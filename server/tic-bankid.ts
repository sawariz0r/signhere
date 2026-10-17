import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { assertBankIdContext, hintMessage, isBase64, signatureCoversContext, signedBinding, visibleText } from './bankid-shared.js';
import { sha256 } from './pdf.js';
import type { SignatureContext, SignatureResult, SigningMethod } from './plugins.js';

// DRAFT adapter for BankID signing through TIC Identity (https://id.tic.io/docs).
// It is deliberately not registered in plugins.ts: the core still needs a
// persisted attempt table, provider calls outside the document transaction,
// per-method consent and storage for `rawProof`. See docs/signing-methods.md.
// Response schemas follow TIC's published docs and must be pinned against a
// recorded sandbox response before this is enabled.

export interface TicBankIdConfig { apiKey: string; baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch; now?: () => number }
export class TicBankIdError extends Error {
  constructor(readonly status: number, readonly code: string) { super('TIC Identity request failed: ' + status + ' ' + code); }
}
export function ticBankIdConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TicBankIdConfig | undefined {
  const apiKey = env.TIC_API_KEY_FILE ? readFileSync(env.TIC_API_KEY_FILE, 'utf8').trim() : env.TIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  const baseUrl = env.TIC_BASE_URL ?? 'https://id.tic.io/api/v1/';
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('TIC_BASE_URL must use https.');
  return { apiKey, baseUrl };
}

const token = z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/);
const startSchema = z.object({ sessionId: token, orderRef: token.optional(), autoStartToken: token, qrStartToken: token, qrStartSecret: token, sessionExpiresAt: z.string().max(64).optional() });
const pollSchema = z.object({
  status: z.string().max(32), hintCode: z.string().max(64).optional(), completedAt: z.string().max(64).optional(),
  user: z.object({ personalNumber: z.string().regex(/^\d{12}$/), givenName: z.string().max(200), surname: z.string().max(200), name: z.string().max(400) }).optional(),
  signature: z.object({ value: z.string().max(400_000), ocspResponse: z.string().max(100_000) }).optional(),
});
const payloadSchema = z.object({ attemptId: token }).strict();

export function createTicBankIdMethod(config: TicBankIdConfig) {
  const baseUrl = new URL(config.baseUrl ?? 'https://id.tic.io/api/v1/');
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  const fetchImpl = config.fetch ?? fetch, timeoutMs = config.timeoutMs ?? 10_000, now = config.now ?? Date.now;
  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'X-Api-Key': config.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (text.length > 1_000_000) throw new TicBankIdError(response.status, 'response_too_large');
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) throw new TicBankIdError(response.status, z.object({ error: z.object({ code: z.string().max(64) }) }).safeParse(json).data?.error.code ?? 'unknown');
    return json;
  }
  const session = (id: string) => 'auth/' + encodeURIComponent(token.parse(id));

  return Object.freeze({
    id: 'tic-bankid', label: 'Signera med BankID', version: '1.0.0',
    capabilities: Object.freeze({ visualSignature: false, verifiesIdentity: true, asynchronous: true }),

    /** Starts a BankID sign order. `persist` belongs on the attempt row and must never reach the browser. */
    async begin(context: SignatureContext) {
      assertBankIdContext(context);
      if (!context.endUserIp) throw new Error('BankID signing requires the end user IP address.');
      const binding = signedBinding(context), visible = visibleText(context);
      const started = startSchema.parse(await call('POST', 'auth/bankid/sign', {
        endUserIp: context.endUserIp, ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 512) } : {}),
        userVisibleData: visible, userVisibleDataFormat: 'simpleMarkdownV1', userNonVisibleData: binding,
      }));
      return {
        client: { attemptId: started.sessionId, autoStartToken: started.autoStartToken, expiresAt: started.sessionExpiresAt ?? null },
        persist: { sessionId: started.sessionId, orderRef: started.orderRef ?? null, qrStartToken: started.qrStartToken, qrStartSecret: started.qrStartSecret, startedAt: now(), bindingSha256: sha256(binding), visibleDataSha256: sha256(visible) },
      };
    },

    /** Polls TIC and, on completion, checks that BankID signed exactly this recipient's binding and visible text. */
    async complete(context: SignatureContext, payload: unknown): Promise<SignatureResult> {
      assertBankIdContext(context);
      const { attemptId } = payloadSchema.parse(payload);
      const result = pollSchema.parse(await call('POST', session(attemptId) + '/poll'));
      if (result.status === 'pending') return { status: 'pending', attemptId, providerEvidence: { hintCode: result.hintCode ?? null, message: hintMessage(result.hintCode, 'Söker efter BankID …') } };
      if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'expired') return { status: result.hintCode === 'userCancel' || result.status === 'cancelled' ? 'cancelled' : 'failed', reason: hintMessage(result.hintCode) };
      if (result.status !== 'complete' || !result.user || !result.signature) throw new TicBankIdError(502, 'unexpected_session_state');
      if (!isBase64(result.signature.value) || !isBase64(result.signature.ocspResponse)) throw new TicBankIdError(502, 'invalid_signature_encoding');
      const xml = Buffer.from(result.signature.value, 'base64');
      if (!signatureCoversContext(xml, context)) return { status: 'failed', reason: 'BankID-signaturen gäller inte detta dokument.' };
      return {
        status: 'completed',
        providerEvidence: {
          schema: 'signhere-tic-bankid-evidence-v1', provider: 'tic-identity', operation: 'bankid-sign',
          assurance: 'bankid', identityVerified: true, sessionId: attemptId, completedAt: result.completedAt ?? null,
          user: result.user, signedBinding: { nonVisibleDataSha256: sha256(signedBinding(context)), visibleDataSha256: sha256(visibleText(context)) },
          signatureXmlSha256: sha256(xml), ocspResponseSha256: sha256(Buffer.from(result.signature.ocspResponse, 'base64')),
          // Trust currently rests on TIC's TLS-authenticated response. XML-DSig,
          // BankID certificate chain and OCSP are retained but not independently validated.
          proofValidation: 'provider-response',
        },
        rawProof: { signatureBase64: result.signature.value, ocspResponseBase64: result.signature.ocspResponse },
      };
    },

    async cancel(attemptId: string) { await call('DELETE', session(attemptId)); },
  } satisfies SigningMethod & { cancel(attemptId: string): Promise<void> });
}
