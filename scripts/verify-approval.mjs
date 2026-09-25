#!/usr/bin/env node
/**
 * Offline verifier for signhere central approval receipts (signhere-central-v1).
 *
 * Independent of the service and of the installation: needs Node.js 22+, the receipt, the
 * trust bundle, and the trust root public key obtained through a channel you trust
 * (NOT from the bundle or the service's own page). Makes no network requests.
 *
 *   node verify-approval.mjs receipt.jws trust-bundle.jws --trust-root <key> [--prepared original.pdf] [--completed completed.pdf]
 *
 * Each claim is reported separately. A valid receipt proves that the service confirmed access
 * to the email address and recorded approval of the exact prepared PDF. It does not prove the
 * participant's identity, and it does not prove that a completed PDF shows the approved content.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_JWS = 64 * 1024, MAX_PDF = 64 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('non_integer_number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  fail('unsupported_json_value');
}
function b64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) fail('invalid_base64url');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('invalid_base64url');
  return bytes;
}
function strictJson(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_json'); }
  if (canonical(value) !== bytes.toString('utf8')) fail('non_canonical_json');
  return value;
}
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join() === [...keys].sort().join();
const kidOf = raw => createHash('sha256').update(raw).digest('base64url');
const ed25519 = raw => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));

function parseJws(jws, typ) {
  if (typeof jws !== 'string' || jws.length > MAX_JWS) fail('jws_size');
  const parts = jws.split('.');
  if (parts.length !== 3) fail('jws_format');
  const header = strictJson(b64url(parts[0]));
  if (!exactKeys(header, ['alg', 'kid', 'typ']) || header.alg !== 'EdDSA' || header.typ !== typ || !/^[A-Za-z0-9_-]{43}$/.test(header.kid)) fail('jws_header');
  const signature = b64url(parts[2]);
  if (signature.length !== 64) fail('jws_signature_length');
  return { header, payload: strictJson(b64url(parts[1])), signingInput: Buffer.from(parts[0] + '.' + parts[1]), signature };
}

export function verifyBundle(jws, rootPublicKey) {
  const root = b64url(rootPublicKey);
  if (root.length !== 32) fail('invalid_trust_root');
  const parsed = parseJws(jws, 'signhere-trust-bundle+jws');
  if (parsed.header.kid !== kidOf(root)) fail('bundle_root_mismatch');
  if (!verify(null, parsed.signingInput, ed25519(root), parsed.signature)) fail('bundle_signature_invalid');
  const bundle = parsed.payload;
  if (!exactKeys(bundle, ['schema', 'service', 'sequence', 'issuedAt', 'keys']) || bundle.schema !== 'signhere-trust-bundle-v1' || !Array.isArray(bundle.keys) || !bundle.keys.length || !time(bundle.issuedAt)) fail('bundle_schema');
  for (const key of bundle.keys) {
    const keys = ['kid', 'alg', 'publicKey', 'purposes', 'validFrom', 'validUntil', 'status', ...(key?.status === 'revoked' ? ['revokedAt'] : [])];
    if (!exactKeys(key, keys) || key.alg !== 'Ed25519' || kidOf(b64url(key.publicKey)) !== key.kid || key.kid === parsed.header.kid
      || !Array.isArray(key.purposes) || !['active', 'retired', 'revoked'].includes(key.status) || !time(key.validFrom) || !(key.validUntil === null || time(key.validUntil))) fail('bundle_key');
  }
  return bundle;
}

const RECEIPT_KEYS = ['schema', 'receiptId', 'service', 'keyId', 'instance', 'transaction', 'document', 'intentSha256', 'policySha256', 'consent', 'email', 'claims', 'approval', 'assurance', 'nonce', 'issuedAt'];
/** Returns per-claim results. Throws only for unusable input. */
export function verifyApprovalReceipt(jws, bundle, files = {}) {
  const parsed = parseJws(jws, 'signhere-approval-receipt+jws');
  const receipt = parsed.payload;
  if (!exactKeys(receipt, RECEIPT_KEYS) || receipt.schema !== 'signhere-approval-receipt-v1' || receipt.keyId !== parsed.header.kid
    || !exactKeys(receipt.document, ['preparedSha256', 'preparedSize']) || !exactKeys(receipt.email, ['address', 'confirmation', 'confirmedAt'])
    || !exactKeys(receipt.claims, ['name', 'nameVerified']) || receipt.claims.nameVerified !== false
    || !exactKeys(receipt.assurance, ['civilIdentityVerified', 'trustedTimestamp']) || receipt.assurance.civilIdentityVerified !== false || receipt.assurance.trustedTimestamp !== false
    || !exactKeys(receipt.transaction, ['documentId', 'revisionId', 'recipientId']) || !exactKeys(receipt.approval, ['method', 'approvedAt', 'documentSource'])
    || !time(receipt.issuedAt) || !/^[a-f0-9]{64}$/.test(receipt.document.preparedSha256)) fail('receipt_schema');
  const key = bundle.keys.find(item => item.kid === parsed.header.kid);
  const result = {
    receiptSha256: sha256(Buffer.from(jws)), receiptId: receipt.receiptId, service: receipt.service,
    signature: 'unknown-key', keyTrust: 'unknown-key',
    emailAccess: { address: receipt.email.address, confirmedAt: receipt.email.confirmedAt, claim: 'confirmed-by-service' },
    approval: { approvedAt: receipt.approval.approvedAt, method: receipt.approval.method, consentVersion: receipt.consent.version, serviceObservedTime: true, trustedTimestamp: false },
    claimedName: { value: receipt.claims.name, verified: false }, civilIdentityVerified: false,
    transaction: receipt.transaction, instanceId: receipt.instance.id,
    preparedPdf: 'not-supplied', completedContentRelationship: 'unverified',
  };
  if (key) {
    result.signature = verify(null, parsed.signingInput, ed25519(b64url(key.publicKey)), parsed.signature) ? 'valid' : 'invalid';
    if (result.signature === 'invalid') result.keyTrust = 'invalid-signature';
    else if (!key.purposes.includes('approval-receipt')) result.keyTrust = 'wrong-purpose';
    else if (receipt.service !== bundle.service) result.keyTrust = 'wrong-service';
    else if (key.status === 'revoked') result.keyTrust = 'revoked';
    else if (receipt.issuedAt < key.validFrom || (key.validUntil !== null && receipt.issuedAt > key.validUntil)) result.keyTrust = 'outside-validity';
    else result.keyTrust = 'trusted';
  }
  if (files.prepared) result.preparedPdf = sha256(files.prepared) === receipt.document.preparedSha256 && files.prepared.length === receipt.document.preparedSize ? 'matched' : 'mismatch';
  if (files.completed) {
    // A completed PDF is a different file. Its seal may commit to the approved original, but that
    // is a claim by the installation; it never shows that the visible pages equal what was approved.
    result.completedPdf = { sha256: sha256(files.completed), relationship: 'unverified', note: 'Check the installation seal (verify-sealed-evidence.mjs) for the receipt commitment; visible-content equivalence is not established.' };
  }
  result.valid = result.signature === 'valid' && result.keyTrust === 'trusted' && result.preparedPdf !== 'mismatch';
  return result;
}

function readBounded(path, max) {
  const info = statSync(path);
  if (!info.isFile() || info.size > max) fail('file_too_large');
  return readFileSync(path);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const take = name => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
  const root = take('--trust-root'), prepared = take('--prepared'), completed = take('--completed');
  try {
    if (args.length !== 2 || !root) fail('Usage: node verify-approval.mjs receipt.jws trust-bundle.jws --trust-root <key> [--prepared original.pdf] [--completed completed.pdf]');
    const bundle = verifyBundle(readBounded(args[1], MAX_JWS).toString('utf8').trim(), root);
    const result = verifyApprovalReceipt(readBounded(args[0], MAX_JWS).toString('utf8').trim(), bundle, {
      prepared: prepared ? readBounded(prepared, MAX_PDF) : undefined, completed: completed ? readBounded(completed, MAX_PDF) : undefined });
    console.log(JSON.stringify(result, null, 2));
    console.log(result.valid
      ? `\nThe service ${result.service} confirmed access to ${result.emailAccess.address} and recorded approval of the ${result.preparedPdf === 'matched' ? 'supplied' : 'identified'} prepared PDF. The name "${result.claimedName.value}" and the person's identity are not verified.`
      : '\nThe receipt is NOT a trusted approval. See keyTrust, signature and preparedPdf above.');
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) { console.error('Verification failed: ' + (error.code ?? error.message)); process.exitCode = 1; }
}
