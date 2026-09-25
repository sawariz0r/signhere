/**
 * Optional connection from a self-hosted installation to a signhere central service.
 *
 * Off by default: with SIGNHERE_CENTRAL_URL unset, centralFromEnv returns null, the
 * installation makes no requests to any central host and shows no central controls.
 * Installations whose participants sign with BankID or another identity-verifying
 * method never need it; the requirement applies only to self-asserted methods.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson, receiptMismatches, verifyReceipt, verifyTrustBundle, type ApprovalExpectation, type TrustBundle } from './central/protocol.js';

export interface CentralSettings {
  /** Service origin, e.g. https://signhere.prpl.se. Configurable: interim, staging or self-run services work alike. */
  url: string; apiKey: string;
  /** Base64url Ed25519 trust root, obtained independently of the service's own website. */
  trustRoot: string;
}
export class CentralUnavailableError extends Error { constructor(public readonly code: string) { super(code); this.name = 'CentralUnavailableError'; } }
export class CentralRejectedError extends Error { constructor(public readonly code: string) { super(code); this.name = 'CentralRejectedError'; } }

type Env = Record<string, string | undefined>;
export function centralFromEnv(env: Env = process.env): CentralSettings | null {
  const url = env.SIGNHERE_CENTRAL_URL?.trim();
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.origin !== url.replace(/\/$/, '')) throw new Error('SIGNHERE_CENTRAL_URL must be an origin without a path, e.g. https://signhere.prpl.se');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('SIGNHERE_CENTRAL_URL must use HTTPS.');
  const file = env.SIGNHERE_CENTRAL_API_KEY_FILE?.trim();
  const apiKey = (file ? readFileSync(file, 'utf8') : env.SIGNHERE_CENTRAL_API_KEY ?? '').trim();
  if (!/^shc_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new Error('SIGNHERE_CENTRAL_API_KEY_FILE (or SIGNHERE_CENTRAL_API_KEY) must contain the key issued by the central service.');
  const trustRoot = env.SIGNHERE_CENTRAL_TRUST_ROOT?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(trustRoot)) throw new Error('SIGNHERE_CENTRAL_TRUST_ROOT must be the service trust root public key (43 characters).');
  return { url: parsed.origin, apiKey, trustRoot };
}

export interface CreateApprovalInput {
  documentId: string; revisionId: string; recipientId: string; email: string; name: string; title: string;
  preparedSha256: string; preparedSize: number; intentSha256: string; policySha256: string;
  participantCapabilitySha256: string; documentUrl: string; expiresAt: string;
}
export interface ApprovalState { approvalId: string; instanceId: string; status: 'pending' | 'email_confirmed' | 'approved' | 'cancelled' | 'expired'; receipt?: string; approvalUrl?: string }
export type CentralFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; json(): Promise<any> }>;

export const policySha256 = (policy: unknown) => createHash('sha256').update(canonicalJson(policy)).digest('hex');

export function createCentralClient(settings: CentralSettings, options: { fetch?: CentralFetch; timeoutMs?: number; bundleTtlMs?: number } = {}) {
  const doFetch: CentralFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = options.timeoutMs ?? 10000;
  let cached: { jws: string; bundle: TrustBundle; at: number } | undefined;
  async function call(method: string, path: string, body?: unknown, auth = true) {
    let response;
    try {
      response = await doFetch(settings.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { accept: 'application/json', ...(auth ? { authorization: 'Bearer ' + settings.apiKey } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new CentralUnavailableError('network'); }
    const data = await response.json().catch(() => ({}));
    if (response.status >= 500 || response.status === 429) throw new CentralUnavailableError(typeof data.error === 'string' ? data.error : 'status_' + response.status);
    if (response.status >= 400) throw new CentralRejectedError(typeof data.error === 'string' ? data.error : 'status_' + response.status);
    return data;
  }
  const state = (data: any): ApprovalState => {
    if (typeof data?.approvalId !== 'string' || typeof data?.instanceId !== 'string' || typeof data?.status !== 'string') throw new CentralUnavailableError('invalid_response');
    return data;
  };
  return {
    settings,
    /** The bundle is authenticated with the pinned root; the service cannot substitute its own anchor. */
    async trustBundle(force = false) {
      if (!force && cached && Date.now() - cached.at < (options.bundleTtlMs ?? 600000)) return cached;
      try {
        const data = await call('GET', '/.well-known/signhere-trust.json', undefined, false);
        const bundle = await verifyTrustBundle(String(data.bundle), settings.trustRoot);
        if (bundle.service !== settings.url) throw new CentralRejectedError('bundle_service');
        if (!cached || bundle.sequence >= cached.bundle.sequence) cached = { jws: String(data.bundle), bundle, at: Date.now() };
        return cached;
      } catch (error) {
        if (cached) return cached;
        throw error instanceof CentralRejectedError || error instanceof CentralUnavailableError ? error : new CentralRejectedError('bundle_invalid');
      }
    },
    createApproval: async (input: CreateApprovalInput) => state(await call('POST', '/v1/approvals', input)),
    getApproval: async (approvalId: string) => state(await call('GET', '/v1/approvals/' + encodeURIComponent(approvalId))),
    cancelApproval: async (approvalId: string) => state(await call('POST', '/v1/approvals/' + encodeURIComponent(approvalId) + '/cancel', {})),
    /** Accept only a receipt signed by a currently trusted key that matches every frozen field. */
    async verifyApprovalReceipt(jws: string, expected: ApprovalExpectation) {
      let bundle = await this.trustBundle();
      let result = await verifyReceipt(jws, bundle.bundle);
      if (result.keyTrust === 'unknown-key') { bundle = await this.trustBundle(true); result = await verifyReceipt(jws, bundle.bundle); }
      if (result.keyTrust !== 'trusted') throw new CentralRejectedError('receipt_key_' + result.keyTrust.replace('-', '_'));
      const mismatches = receiptMismatches(result.receipt, expected);
      if (mismatches.length) throw new CentralRejectedError('receipt_mismatch_' + mismatches[0]);
      return { ...result, trustBundle: bundle.jws };
    },
  };
}
export type CentralClient = ReturnType<typeof createCentralClient>;
