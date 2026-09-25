/**
 * signhere central protocol v1 (see docs/central-protocol.md).
 *
 * Isomorphic: runs in Node.js 22+ and modern browsers through WebCrypto only, so the
 * central service, self-hosted installations and the browser verifier share one parser.
 * Signing lives in keys.ts (Node only). Every parse is strict: exact header members,
 * canonical payload bytes, and a closed schema per message type (domain separation).
 */
import { z } from 'zod';

export const PROTOCOL = 'signhere-central-v1';
export const RECEIPT_TYP = 'signhere-approval-receipt+jws';
export const BUNDLE_TYP = 'signhere-trust-bundle+jws';
export const RECEIPT_SCHEMA = 'signhere-approval-receipt-v1';
export const BUNDLE_SCHEMA = 'signhere-trust-bundle-v1';
export const APPROVAL_METHOD = 'signhere-central-email-v1';
export const EMAIL_CONFIRMATION = 'email-code-v1';
export const MAX_JWS_BYTES = 64 * 1024;

/** Service-owned consent. The operator cannot change what the participant approves at the service. */
export const CENTRAL_CONSENT = Object.freeze({
  version: 'signhere-central-consent-v1',
  text: 'Jag har läst hela dokumentet som visas här och godkänner det. Jag förstår att signhere-tjänsten intygar att jag har tillgång till e-postadressen ovan och att jag godkände exakt detta dokument, men inte vem jag är.',
});

export type Bytes = Uint8Array;
/** WebCrypto's input type without depending on the DOM library typings. */
type Source = Parameters<typeof crypto.subtle.digest>[1];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const utf8 = (value: string): Bytes => encoder.encode(value);
export const fromUtf8 = (bytes: Bytes) => decoder.decode(bytes);

/** Recursively sorted keys, no whitespace, arrays keep order. Rejects values JSON cannot represent exactly. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new ProtocolError('non_integer_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(key => {
      if (record[key] === undefined) throw new ProtocolError('undefined_member');
      return JSON.stringify(key) + ':' + canonicalJson(record[key]);
    }).join(',') + '}';
  }
  throw new ProtocolError('unsupported_json_value');
}

export class ProtocolError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'ProtocolError'; }
}

const B64URL = /^[A-Za-z0-9_-]*$/;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function base64url(bytes: Bytes): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += alphabet[n & 63];
  }
  return out;
}
/** Strict: no padding, no whitespace, and only the canonical encoding of the decoded bytes. */
export function fromBase64url(value: string): Bytes {
  if (!B64URL.test(value) || value.length % 4 === 1) throw new ProtocolError('invalid_base64url');
  const bytes = new Uint8Array(Math.floor(value.length * 3 / 4));
  let buffer = 0, bits = 0, index = 0;
  for (const char of value) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes[index++] = (buffer >> bits) & 255; }
  }
  if (base64url(bytes) !== value) throw new ProtocolError('invalid_base64url');
  return bytes;
}
export const hex = (bytes: Bytes) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Source));
}
export const sha256Hex = async (bytes: Bytes) => hex(await sha256(bytes));
/** A key identifier is the SHA-256 of the raw 32-byte Ed25519 public key, base64url. */
export async function keyId(publicKey: Bytes) {
  if (publicKey.length !== 32) throw new ProtocolError('invalid_public_key');
  return base64url(await sha256(publicKey));
}

const kidSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/).refine(value => !Number.isNaN(Date.parse(value)), 'invalid time');
const originSchema = z.string().max(200).refine(value => {
  try { const url = new URL(value); return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && url.origin === value; }
  catch { return false; }
}, 'invalid origin');
const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const text = (max: number) => z.string().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'control characters');

const headerSchema = z.object({ alg: z.literal('EdDSA'), kid: kidSchema, typ: z.enum([RECEIPT_TYP, BUNDLE_TYP]) }).strict();
export type JwsHeader = z.infer<typeof headerSchema>;

export const trustKeySchema = z.object({
  kid: kidSchema, alg: z.literal('Ed25519'), publicKey: publicKeySchema,
  purposes: z.array(z.enum(['approval-receipt'])).min(1).max(4),
  validFrom: timeSchema, validUntil: timeSchema.nullable(),
  status: z.enum(['active', 'retired', 'revoked']),
  /** For revoked keys: receipts claiming a later issue time are rejected; earlier ones stay indeterminate. */
  revokedAt: timeSchema.optional(),
}).strict();
export const trustBundleSchema = z.object({
  schema: z.literal(BUNDLE_SCHEMA), service: originSchema, sequence: z.number().int().min(1).max(2 ** 31),
  issuedAt: timeSchema, keys: z.array(trustKeySchema).min(1).max(64),
}).strict();
export type TrustKey = z.infer<typeof trustKeySchema>;
export type TrustBundle = z.infer<typeof trustBundleSchema>;

export const receiptSchema = z.object({
  schema: z.literal(RECEIPT_SCHEMA),
  receiptId: z.uuid(),
  service: originSchema,
  keyId: kidSchema,
  /** Opaque central account of the self-hosted installation. Not a verified organisation. */
  instance: z.object({ id: identifierSchema }).strict(),
  /** Installation-assigned identifiers. Bound, but not independently meaningful. */
  transaction: z.object({ documentId: identifierSchema, revisionId: identifierSchema, recipientId: identifierSchema }).strict(),
  document: z.object({ preparedSha256: digestSchema, preparedSize: z.number().int().min(1).max(64 * 1024 * 1024) }).strict(),
  intentSha256: digestSchema,
  policySha256: digestSchema,
  consent: z.object({ version: text(128), text: text(4000) }).strict(),
  email: z.object({ address: text(254), confirmation: z.literal(EMAIL_CONFIRMATION), confirmedAt: timeSchema }).strict(),
  /** Supplied by the installation's sender. Never verified by the service. */
  claims: z.object({ name: text(160), nameVerified: z.literal(false) }).strict(),
  approval: z.object({ method: z.literal(APPROVAL_METHOD), approvedAt: timeSchema, documentSource: z.enum(['installation-transfer', 'local-file']) }).strict(),
  assurance: z.object({ civilIdentityVerified: z.literal(false), trustedTimestamp: z.literal(false) }).strict(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt: timeSchema,
}).strict();
export type ApprovalReceipt = z.infer<typeof receiptSchema>;

export interface ParsedJws { header: JwsHeader; payloadBytes: Bytes; payload: unknown; signingInput: Bytes; signature: Bytes }

/** Parse compact JWS without trusting it. The caller must verify the signature before using the payload. */
export function parseJws(jws: string, typ: typeof RECEIPT_TYP | typeof BUNDLE_TYP): ParsedJws {
  if (typeof jws !== 'string' || jws.length > MAX_JWS_BYTES) throw new ProtocolError('jws_size');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new ProtocolError('jws_format');
  const headerBytes = fromBase64url(parts[0]);
  const payloadBytes = fromBase64url(parts[1]);
  const signature = fromBase64url(parts[2]);
  if (signature.length !== 64) throw new ProtocolError('jws_signature_length');
  const header = strictJson(headerBytes);
  const parsedHeader = headerSchema.safeParse(header);
  if (!parsedHeader.success) throw new ProtocolError('jws_header');
  if (parsedHeader.data.typ !== typ) throw new ProtocolError('jws_type');
  return { header: parsedHeader.data, payloadBytes, payload: strictJson(payloadBytes), signingInput: utf8(parts[0] + '.' + parts[1]), signature };
}
/** Exact canonical encoding only: duplicate members, whitespace or reordered keys fail. */
function strictJson(bytes: Bytes): unknown {
  let value: unknown;
  try { value = JSON.parse(fromUtf8(bytes)); } catch { throw new ProtocolError('invalid_json'); }
  let expected: string;
  try { expected = canonicalJson(value); } catch { throw new ProtocolError('non_canonical_json'); }
  if (expected !== fromUtf8(bytes)) throw new ProtocolError('non_canonical_json');
  return value;
}
export async function verifyEd25519(publicKey: Bytes, message: Bytes, signature: Bytes) {
  const key = await crypto.subtle.importKey('raw', publicKey as Source, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature as Source, message as Source);
}

/** The root key is an independent input (pinned configuration or offline copy), never taken from the bundle. */
export async function verifyTrustBundle(jws: string, rootPublicKey: string): Promise<TrustBundle> {
  const root = fromBase64url(publicKeySchema.parse(rootPublicKey));
  const parsed = parseJws(jws, BUNDLE_TYP);
  if (parsed.header.kid !== await keyId(root)) throw new ProtocolError('bundle_root_mismatch');
  if (!await verifyEd25519(root, parsed.signingInput, parsed.signature)) throw new ProtocolError('bundle_signature_invalid');
  const bundle = trustBundleSchema.safeParse(parsed.payload);
  if (!bundle.success) throw new ProtocolError('bundle_schema');
  for (const key of bundle.data.keys) {
    if (key.kid !== await keyId(fromBase64url(key.publicKey))) throw new ProtocolError('bundle_key_id');
    if (key.kid === parsed.header.kid) throw new ProtocolError('bundle_root_reused');
    if ((key.status === 'revoked') !== Boolean(key.revokedAt)) throw new ProtocolError('bundle_revocation');
  }
  if (new Set(bundle.data.keys.map(key => key.kid)).size !== bundle.data.keys.length) throw new ProtocolError('bundle_duplicate_key');
  return bundle.data;
}

export type KeyTrust = 'trusted' | 'unknown-key' | 'wrong-service' | 'outside-validity' | 'revoked';
export interface ReceiptVerification {
  receipt: ApprovalReceipt;
  receiptSha256: string;
  keyTrust: KeyTrust;
}
/**
 * Verifies signature, schema and key status. A receipt is only accepted when keyTrust is
 * 'trusted'; other values explain why. Throws for malformed or wrongly signed input.
 */
export async function verifyReceipt(jws: string, bundle: TrustBundle): Promise<ReceiptVerification> {
  const parsed = parseJws(jws, RECEIPT_TYP);
  const key = bundle.keys.find(item => item.kid === parsed.header.kid);
  const receiptSha256 = await sha256Hex(utf8(jws));
  const check = receiptSchema.safeParse(parsed.payload);
  if (!key) {
    if (!check.success) throw new ProtocolError('receipt_schema');
    return { receipt: check.data, receiptSha256, keyTrust: 'unknown-key' };
  }
  if (!await verifyEd25519(fromBase64url(key.publicKey), parsed.signingInput, parsed.signature)) throw new ProtocolError('receipt_signature_invalid');
  if (!check.success) throw new ProtocolError('receipt_schema');
  const receipt = check.data;
  if (receipt.keyId !== key.kid) throw new ProtocolError('receipt_key_mismatch');
  let keyTrust: KeyTrust = 'trusted';
  if (!key.purposes.includes('approval-receipt')) keyTrust = 'unknown-key';
  else if (receipt.service !== bundle.service) keyTrust = 'wrong-service';
  else if (key.status === 'revoked') keyTrust = 'revoked';
  else if (receipt.issuedAt < key.validFrom || (key.validUntil !== null && receipt.issuedAt > key.validUntil)) keyTrust = 'outside-validity';
  return { receipt, receiptSha256, keyTrust };
}

/** What the installation froze before inviting the participant. Every field must match exactly. */
export interface ApprovalExpectation {
  service: string; instanceId: string; documentId: string; revisionId: string; recipientId: string;
  preparedSha256: string; preparedSize: number; intentSha256: string; policySha256: string; email: string;
}
export function receiptMismatches(receipt: ApprovalReceipt, expected: ApprovalExpectation): string[] {
  const pairs: Array<[string, unknown, unknown]> = [
    ['service', receipt.service, expected.service], ['instance', receipt.instance.id, expected.instanceId],
    ['document', receipt.transaction.documentId, expected.documentId], ['revision', receipt.transaction.revisionId, expected.revisionId],
    ['recipient', receipt.transaction.recipientId, expected.recipientId], ['prepared_hash', receipt.document.preparedSha256, expected.preparedSha256],
    ['prepared_size', receipt.document.preparedSize, expected.preparedSize], ['intent', receipt.intentSha256, expected.intentSha256],
    ['policy', receipt.policySha256, expected.policySha256], ['email', receipt.email.address, normalizeEmail(expected.email)],
    ['consent', receipt.consent.version, CENTRAL_CONSENT.version],
  ];
  return pairs.filter(([, actual, wanted]) => actual !== wanted).map(([name]) => name);
}
/** Lower-case and trim only. Provider-specific aliasing (dots, plus tags) is deliberately not applied. */
export const normalizeEmail = (value: string) => value.trim().toLowerCase();
