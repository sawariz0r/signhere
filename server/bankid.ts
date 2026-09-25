import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { z } from 'zod';
import { assertBankIdContext, hintMessage, isBase64, signatureCoversContext, signedBinding, visibleText } from './bankid-shared.js';
import { sha256 } from './pdf.js';
import type { SignatureContext, SignatureResult, SigningMethod } from './plugins.js';

// DRAFT method for BankID signing directly against the BankID Relying Party
// API v6.0 (https://developers.bankid.com/api-references/auth--sign/sign),
// authenticated with the operator's RP certificate over mutual TLS.
// Not registered in plugins.ts for the same core gaps as tic-bankid.ts:
// persisted attempts, provider calls outside the document transaction,
// per-method consent and `rawProof` storage. See docs/signing-methods.md.

export const BANKID_ENDPOINTS = Object.freeze({
  production: 'https://appapi2.bankid.com/rp/v6.0/',
  test: 'https://appapi2.test.bankid.com/rp/v6.0/',
});
export type BankIdTransport = (path: 'sign' | 'collect' | 'cancel', body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
export interface BankIdConfig { transport: BankIdTransport; referringDomain?: string; returnRisk?: boolean; now?: () => number }
export class BankIdError extends Error {
  constructor(readonly status: number, readonly code: string) { super('BankID request failed: ' + status + ' ' + code); }
}

/** Mutual-TLS transport. `ca` replaces the default trust store, pinning BankID's issuing CA for the chosen environment. */
export function mtlsTransport(options: { baseUrl: string; pfx: Buffer; passphrase: string; ca: Buffer; timeoutMs?: number }): BankIdTransport {
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== 'https:') throw new Error('BankID endpoint must use https.');
  const agent = new Agent({ pfx: options.pfx, passphrase: options.passphrase, ca: options.ca, minVersion: 'TLSv1.2', keepAlive: true });
  return (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = request(new URL(path, baseUrl), {
      method: 'POST', agent, timeout: options.timeoutMs ?? 10_000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1_000_000) outgoing.destroy(new Error('BankID response too large.')); else chunks.push(chunk); });
      response.on('end', () => {
        try { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} }); } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('BankID request timed out.')));
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

export function bankIdConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BankIdConfig | undefined {
  if (!env.BANKID_P12_FILE) return undefined;
  const environment = env.BANKID_ENV;
  if (environment !== 'test' && environment !== 'production') throw new Error('BANKID_ENV must be "test" or "production".');
  if (!env.BANKID_P12_PASSWORD_FILE || !env.BANKID_CA_FILE) throw new Error('BANKID_P12_PASSWORD_FILE and BANKID_CA_FILE are required with BANKID_P12_FILE.');
  return {
    transport: mtlsTransport({
      baseUrl: env.BANKID_BASE_URL ?? BANKID_ENDPOINTS[environment], pfx: readFileSync(env.BANKID_P12_FILE),
      passphrase: readFileSync(env.BANKID_P12_PASSWORD_FILE, 'utf8').trim(), ca: readFileSync(env.BANKID_CA_FILE),
    }),
    ...(env.BANKID_REFERRING_DOMAIN ? { referringDomain: env.BANKID_REFERRING_DOMAIN } : {}),
  };
}

const token = z.string().min(1).max(256).regex(/^[A-Za-z0-9._-]+$/);
const signSchema = z.object({ orderRef: token, autoStartToken: token, qrStartToken: token, qrStartSecret: token });
const collectSchema = z.object({
  orderRef: token, status: z.string().max(32), hintCode: z.string().max(64).optional(),
  completionData: z.object({
    user: z.object({ personalNumber: z.string().regex(/^\d{12}$/), name: z.string().max(400), givenName: z.string().max(200), surname: z.string().max(200) }),
    device: z.object({ ipAddress: z.string().max(64), uhi: z.string().max(256).optional() }),
    bankIdIssueDate: z.string().max(32), stepUp: z.object({ mrtd: z.boolean() }).optional(), risk: z.string().max(32).optional(),
    signature: z.string().max(400_000), ocspResponse: z.string().max(100_000),
  }).optional(),
});
const payloadSchema = z.object({ attemptId: token }).strict();
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

export function createBankIdMethod(config: BankIdConfig) {
  const now = config.now ?? Date.now;
  async function call(path: 'sign' | 'collect' | 'cancel', body: Record<string, unknown>) {
    const response = await config.transport(path, body);
    if (response.status < 200 || response.status > 299) throw new BankIdError(response.status, z.object({ errorCode: z.string().max(64) }).safeParse(response.body).data?.errorCode ?? 'unknown');
    return response.body;
  }

  return Object.freeze({
    id: 'bankid', label: 'Signera med BankID', version: '1.0.0',
    capabilities: Object.freeze({ visualSignature: false, verifiesIdentity: true, asynchronous: true }),

    /** Starts a BankID sign order. `persist` belongs on the attempt row and must never reach the browser. */
    async begin(context: SignatureContext) {
      assertBankIdContext(context);
      if (!context.endUserIp) throw new Error('BankID signing requires the end user IP address.');
      const binding = signedBinding(context), visible = visibleText(context);
      const web = { ...(config.referringDomain ? { referringDomain: config.referringDomain } : {}), ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 512) } : {}) };
      const started = signSchema.parse(await call('sign', {
        endUserIp: context.endUserIp, userVisibleData: b64(visible), userVisibleDataFormat: 'simpleMarkdownV1', userNonVisibleData: b64(binding),
        ...(Object.keys(web).length ? { web } : {}), ...(config.returnRisk ? { returnRisk: true } : {}),
      }));
      // Until attempts are persisted, the orderRef doubles as the attempt ID. Once
      // they are, the browser should get a Signhere attempt ID and orderRef stays server-side.
      return {
        client: { attemptId: started.orderRef, autoStartToken: started.autoStartToken },
        persist: { orderRef: started.orderRef, qrStartToken: started.qrStartToken, qrStartSecret: started.qrStartSecret, startedAt: now(), bindingSha256: sha256(binding), visibleDataSha256: sha256(visible) },
      };
    },

    /** Collects the order and, on completion, checks that BankID signed exactly this recipient's binding and visible text. */
    async complete(context: SignatureContext, payload: unknown): Promise<SignatureResult> {
      assertBankIdContext(context);
      const { attemptId } = payloadSchema.parse(payload);
      const result = collectSchema.parse(await call('collect', { orderRef: attemptId }));
      if (result.orderRef !== attemptId) throw new BankIdError(502, 'order_mismatch');
      if (result.status === 'pending') return { status: 'pending', attemptId, providerEvidence: { hintCode: result.hintCode ?? null, message: hintMessage(result.hintCode, 'Söker efter BankID …') } };
      if (result.status === 'failed') return { status: result.hintCode === 'userCancel' ? 'cancelled' : 'failed', reason: hintMessage(result.hintCode) };
      const data = result.completionData;
      if (result.status !== 'complete' || !data) throw new BankIdError(502, 'unexpected_order_state');
      if (!isBase64(data.signature) || !isBase64(data.ocspResponse)) throw new BankIdError(502, 'invalid_signature_encoding');
      const xml = Buffer.from(data.signature, 'base64');
      if (!signatureCoversContext(xml, context)) return { status: 'failed', reason: 'BankID-signaturen gäller inte detta dokument.' };
      return {
        status: 'completed',
        providerEvidence: {
          schema: 'signhere-bankid-evidence-v1', provider: 'bankid-rp-v6', operation: 'sign',
          assurance: 'bankid', identityVerified: true, orderRef: attemptId,
          user: data.user, device: data.device, bankIdIssueDate: data.bankIdIssueDate,
          ...(data.stepUp ? { stepUp: data.stepUp } : {}), ...(data.risk ? { risk: data.risk } : {}),
          signedBinding: { nonVisibleDataSha256: sha256(signedBinding(context)), visibleDataSha256: sha256(visibleText(context)) },
          signatureXmlSha256: sha256(xml), ocspResponseSha256: sha256(Buffer.from(data.ocspResponse, 'base64')),
          // Trust rests on the pinned-CA mutual-TLS response from BankID. XML-DSig,
          // BankID certificate chain and OCSP are retained but not independently validated.
          proofValidation: 'bankid-rp-mtls',
        },
        rawProof: { signatureBase64: data.signature, ocspResponseBase64: data.ocspResponse },
      };
    },

    async cancel(attemptId: string) { await call('cancel', { orderRef: token.parse(attemptId) }); },
  } satisfies SigningMethod & { cancel(attemptId: string): Promise<void> });
}
