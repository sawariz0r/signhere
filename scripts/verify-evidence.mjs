import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
export function normalizeFingerprint(value) {
  if (typeof value !== 'string') throw new Error('Missing trusted certificate fingerprint.');
  const normalized = value.trim().replace(/^(?:sha256\s+)?fingerprint=/i, '').replaceAll(':', '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('Invalid trusted certificate fingerprint.');
  return normalized;
}
export const MAX_EVIDENCE_JSON_BYTES = 128 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
export function readBoundedFile(path, limit) {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    check(info.isFile() && info.size >= 0 && info.size <= limit, 'Input is not a regular file within verification limits.');
    const bytes = Buffer.alloc(info.size + 1);
    let read = 0;
    while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, null); if (!count) break; read += count; }
    check(read === info.size, 'Input changed while being read.');
    return bytes.subarray(0, read);
  } finally { closeSync(fd); }
}
export function parseEvidenceJson(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_EVIDENCE_JSON_BYTES, 'Evidence JSON is missing or oversized.');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  check(!text.startsWith('\ufeff'), 'Evidence JSON must not contain a BOM.');
  const value = JSON.parse(text);
  validateJsonValue(value);
  return value;
}
function validateJsonValue(value, depth = 0) {
  check(depth <= 64, 'Evidence JSON nesting exceeds the supported limit.');
  if (typeof value === 'string') {
    check(value.isWellFormed(), 'Evidence JSON contains invalid Unicode.');
  } else if (typeof value === 'number') check(Number.isFinite(value), 'Evidence JSON contains non-finite numbers.');
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { validateJsonValue(key, depth + 1); validateJsonValue(child, depth + 1); }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;

export function verifyEvidence(manifest, original, completed, uploaded) {
  check(object(manifest), 'Missing evidence manifest.');
  for (const bytes of [original, completed, ...(uploaded === undefined ? [] : [uploaded])]) check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_PDF_BYTES, 'PDF input is missing or oversized.');
  if (manifest.schemaVersion === 2) return verifyV2Consistency(manifest, original, completed, uploaded);
  check(manifest.schemaVersion === 1, 'Unsupported evidence schema.');
  const doc = manifest.document;
  check(doc && typeof doc.id === 'string', 'Missing document identity.');
  check(doc.status === 'completed', 'This document was not completed.');
  check(digest(original) === doc.originalHash, 'Original PDF hash does not match.');
  check(digest(completed) === doc.completedHash, 'Completed PDF hash does not match.');
  check(Array.isArray(manifest.events) && manifest.events.length > 0, 'No audit events.');
  const created = manifest.events[0];
  check(created.type === 'document.created', 'Missing initial document snapshot.');
  for (const key of ['title', 'fileName', 'originalHash', 'size', 'pages', 'sender']) {
    check(canonical(created.data[key]) === canonical(doc[key]), `Document ${key} does not match the initial snapshot.`);
  }
  // A bilaga records the completed main document it extends in its creation snapshot.
  check(canonical(created.data.attachmentOf ?? null) === canonical(doc.attachmentOf ?? null), 'Attachment binding does not match the initial snapshot.');
  if (doc.attachmentOf) check(object(doc.attachmentOf) && typeof doc.attachmentOf.documentId === 'string' && doc.attachmentOf.documentId !== doc.id && /^[a-f0-9]{64}$/.test(doc.attachmentOf.completedHash) && Number.isSafeInteger(doc.attachmentOf.number) && doc.attachmentOf.number > 0, 'Invalid attachment binding.');
  const preparation = doc.preparation ?? null;
  check(canonical(created.data.preparation ?? null) === canonical(preparation), 'Conversion metadata does not match the initial snapshot.');
  if (preparation) {
    check(preparation.kind === 'flatten' && preparation.engine === 'mupdf' && typeof preparation.engineVersion === 'string', 'Unsupported PDF preparation record.');
    check(/^[a-f0-9]{64}$/.test(preparation.sourceHash) && preparation.sourceHash !== doc.originalHash, 'Invalid uploaded source hash.');
    check(Number.isSafeInteger(preparation.sourceSize) && preparation.sourceSize > 0, 'Invalid uploaded source size.');
    for (const key of ['annotationCount', 'formFieldCount', 'noteCount']) check(Number.isSafeInteger(preparation[key]) && preparation[key] >= 0, 'Invalid conversion count.');
    if (uploaded !== undefined) {
      check(digest(uploaded) === preparation.sourceHash, 'Uploaded PDF hash does not match.');
      check(uploaded.length === preparation.sourceSize, 'Uploaded PDF size does not match.');
    }
  } else if (uploaded !== undefined) check(digest(uploaded) === doc.originalHash, 'Uploaded PDF hash does not match the unconverted signing document.');
  check(Array.isArray(doc.recipients) && Array.isArray(created.data.recipients) && doc.recipients.length === created.data.recipients.length, 'Recipient assignment count does not match.');
  for (const [index, recipient] of doc.recipients.entries()) {
    const assigned = created.data.recipients[index];
    for (const key of ['id', 'name', 'email']) check(recipient[key] === assigned[key], `Recipient ${key} does not match the initial snapshot.`);
    check(recipient.methodId === created.data.method.id && recipient.methodVersion === created.data.method.version, 'Recipient signing method was changed.');
  }
  if (Object.hasOwn(created.data, 'senderRecipientId')) {
    check(created.data.senderRecipientId === doc.senderRecipientId, 'Sender signature assignment does not match the initial snapshot.');
    if (doc.senderRecipientId !== null) {
      const senderRecipient = doc.recipients.find(recipient => recipient.id === doc.senderRecipientId);
      check(senderRecipient && senderRecipient.name === doc.sender.name && senderRecipient.email === doc.sender.email, 'Sender signature assignment does not match the sender identity.');
    }
  }
  let previousHash = '0'.repeat(64);
  let sequence = 0;
  const signedRecipients = new Set();
  for (const event of manifest.events) {
    check(event.sequence === ++sequence, `Invalid audit sequence at ${sequence}.`);
    check(event.previousHash === previousHash, `Broken audit link at ${sequence}.`);
    const hash = digest(canonical({ documentId: doc.id, sequence, type: event.type, at: event.at, data: event.data, previousHash }));
    check(hash === event.hash, `Changed audit event at ${sequence}.`);
    previousHash = hash;
    if (event.type === 'recipient.signed') {
      check(event.data.originalHash === doc.originalHash, 'A signature is bound to another document.');
      check(event.data.consent?.version && event.data.consent?.text, 'A signature has no recorded consent.');
      check(!signedRecipients.has(event.data.recipientId), 'Recipient signed more than once.');
      const recipient = doc.recipients.find(value => value.id === event.data.recipientId);
      check(recipient && recipient.name === event.data.assignedName && recipient.email === event.data.email, 'Signature recipient assignment does not match.');
      check(recipient.signedName === event.data.claimedName && recipient.signedAt === event.at, 'Claimed signer name or time does not match.');
      check(canonical(recipient.signature) === canonical(event.data.signature), 'Signature appearance does not match.');
      check(recipient.methodId === event.data.method?.id && recipient.methodVersion === event.data.method?.version, 'Signature method does not match.');
      check(recipient.ip === event.data.ip && recipient.userAgent === event.data.userAgent, 'Signer request metadata does not match.');
      signedRecipients.add(event.data.recipientId);
    }
  }
  const head = typeof manifest.chainHead === 'string' ? manifest.chainHead : manifest.chainHead?.hash;
  check(previousHash === head, 'Audit chain head does not match.');
  const finalEvent = manifest.events.at(-1);
  check(finalEvent.type === 'document.completed' && finalEvent.data.completedHash === doc.completedHash, 'Completion event does not bind the completed PDF.');
  const checkpoint = manifest.signingCheckpoint ?? doc.signingCheckpoint;
  check(checkpoint && manifest.events[checkpoint.sequence - 1]?.hash === checkpoint.hash, 'Signing checkpoint does not match the audit chain.');
  check(checkpoint.sequence === finalEvent.sequence - 1 && manifest.events[checkpoint.sequence - 1]?.type === 'recipient.signed', 'Signing checkpoint does not cover every signature.');
  check(canonical(checkpoint) === canonical(finalEvent.data.signingCheckpoint), 'Completion event does not bind the signing checkpoint.');
  if (doc.signingCheckpoint) check(canonical(doc.signingCheckpoint) === canonical(checkpoint), 'Conflicting signing checkpoints.');
  check(signedRecipients.size === doc.recipients.length && signedRecipients.size > 0, 'Not every assigned recipient has signature evidence.');
  check(doc.createdAt === created.at && doc.completedAt === finalEvent.at, 'Document timestamps do not match the audit events.');
  check(finalEvent.data.originalHash === doc.originalHash, 'Completion event is bound to another original.');
  return { uploadedSourceVerified: uploaded !== undefined ? true : preparation ? false : null, documentId: doc.id, signatures: signedRecipients.size, events: sequence, chainHead: previousHash, manifestSha256: digest(canonical(manifest)) };
}
export function decodeEvidenceCore(manifest) {
  const encoded = manifest.evidenceCoreBase64;
  check(typeof encoded === 'string' && encoded.length <= 45 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'Missing or oversized exact evidence core.');
  const bytes = Buffer.from(encoded, 'base64');
  check(bytes.toString('base64') === encoded && bytes.length <= 32 * 1024 * 1024, 'Invalid evidence encoding.');
  check(digest(bytes) === manifest.evidenceCoreHash, 'Changed evidence core bytes.');
  const core = parseEvidenceJson(bytes);
  // The v2 producer format is deliberately fixed. This comparison rejects duplicate
  // keys/invalid UTF-8/alternate representations; the commitment is over bytes above.
  check(Buffer.from(canonical(core), 'utf8').equals(bytes), 'Evidence is not in its declared strict producer format.');
  check(object(core) && core.schema === 'signhere-evidence-core-v2' && validNonce(core.nonce), 'Invalid evidence core schema or nonce.');
  check(object(core.document) && typeof core.installationId === 'string' && object(core.signingCheckpoint) && Array.isArray(core.events) && core.events.length > 1 && Array.isArray(core.recipients) && core.recipients.length > 0 && core.recipients.length <= 26, 'Incomplete frozen evidence core.');
  for (const name of ['id', 'title', 'fileName', 'originalHash', 'size', 'pages', 'createdAt', 'sender', 'senderRecipientId']) check(Object.hasOwn(core.document, name), `Missing frozen document ${name}.`);
  return { core, bytes };
}
function verifyV2Consistency(manifest, original, completed, uploaded) {
  const { core, bytes } = decodeEvidenceCore(manifest);
  const result = verifyEvidence({ ...manifest, schemaVersion: 1 }, original, completed, uploaded);
  const doc = manifest.document;
  for (const [key, value] of Object.entries(core.document)) check(canonical(value) === canonical(doc[key]), `Frozen document ${key} does not match.`);
  check(canonical(core.signingCheckpoint) === canonical(manifest.signingCheckpoint), 'Frozen checkpoint changed.');
  check(canonical(core.events) === canonical(manifest.events.slice(0, core.signingCheckpoint.sequence)), 'Frozen signing events changed.');
  check(core.events.every(event => object(event.data) && validNonce(event.data.eventNonce)), 'Missing v2 audit nonce.');
  check(core.events.slice(1).every(event => ['recipient.viewed', 'recipient.signed', 'link.rotated'].includes(event.type)), 'Unexpected frozen signing event.');
  const created = core.events[0];
  check(created.data.installationId === core.installationId && created.data.evidenceVersion === 2, 'Installation binding mismatch.');
  check(created.data.protectionPolicy?.profile === 'signhere-seal-v1' && created.data.protectionPolicy?.timestamp === 'off', 'Unsupported frozen protection policy.');
  check(core.recipients.length === doc.recipients.length, 'Frozen recipient count changed.');
  for (const [index, recipient] of core.recipients.entries()) {
    const exported = doc.recipients[index];
    for (const key of ['id', 'name', 'email', 'methodId', 'methodVersion', 'signedAt', 'signedName']) check(canonical(recipient[key]) === canonical(exported[key]), `Frozen recipient ${key} changed.`);
    check(recipient.position === index, 'Frozen recipient order changed.');
    const signed = core.events.find(event => event.type === 'recipient.signed' && event.data.recipientId === recipient.id);
    check(signed && canonical(signed.data.intent) === canonical(recipient.intent), 'Intent is not bound to the accepted signature.');
    const raw = Buffer.from(recipient.intent.bytesBase64, 'base64');
    check(raw.length <= 16384 && raw.toString('base64') === recipient.intent.bytesBase64 && digest(raw) === recipient.intent.sha256, 'Changed intent bytes.');
    const intent = parseEvidenceJson(raw);
    check(Buffer.from(canonical(intent), 'utf8').equals(raw), 'Invalid strict intent encoding.');
    check(intent.schema === 'signhere-intent-v2' && intent.domain === 'signhere/document-approval', 'Unknown signing intent.');
    check(intent.installationId === core.installationId && intent.documentId === doc.id && intent.revisionId === doc.id && intent.recipientId === recipient.id && intent.preparedHash === digest(original), 'Intent is bound to another document or recipient.');
    check(canonical(intent.attachmentOf ?? null) === canonical(core.document.attachmentOf ?? null), 'Intent is bound to another main document.');
    check(canonical(intent.consent) === canonical(signed.data.consent) && canonical(intent.method) === canonical(signed.data.method) && validNonce(intent.nonce), 'Intent consent/method/nonce mismatch.');
    checkIndependentApproval(created.data.protectionPolicy, core, doc, recipient, signed, original);
  }
  check(manifest.events.at(-1).data.evidenceCoreHash === digest(bytes), 'Completion does not bind exact evidence.');
  const independentApprovals = core.recipients.filter(recipient => recipient.independentApproval).length;
  return { ...result, evidenceVersion: 2, evidenceCoreHash: digest(bytes), cryptographicPdfSeal: 'not-checked', issuerTrust: 'not-checked',
    ...(created.data.protectionPolicy.independentApproval ? { independentApproval: { receipts: independentApprovals, bindings: 'consistent', receiptSignatures: 'not-checked' } } : {}) };
}
const SELF_ASSERTED_METHODS = new Set(['draw']);
/** Structural binding of a central approval receipt to this record. Signatures are checked by verify-approval.mjs with an independently obtained trust root. */
function checkIndependentApproval(policy, core, doc, recipient, signed, original) {
  const independent = policy.independentApproval;
  const approval = recipient.independentApproval;
  check(Object.keys(policy).every(key => ['profile', 'timestamp', 'independentApproval'].includes(key)), 'Unsupported frozen protection policy.');
  if (!independent) { check(approval === undefined && signed.data.independentApproval === undefined, 'Unexpected independent approval evidence.'); return; }
  check(object(independent) && Object.keys(independent).sort().join() === 'mode,service,trustRoot' && independent.mode === 'email' && /^[A-Za-z0-9_-]{43}$/.test(independent.trustRoot), 'Unsupported independent approval policy.');
  if (!approval) { check(!SELF_ASSERTED_METHODS.has(recipient.methodId) && signed.data.independentApproval === undefined, 'A required independent approval is missing.'); return; }
  check(object(approval) && Object.keys(approval).sort().join() === 'approvalId,instanceId,receipt,receiptSha256,service,trustBundle' && approval.service === independent.service, 'Invalid independent approval evidence.');
  check(digest(Buffer.from(approval.receipt, 'utf8')) === approval.receiptSha256, 'Changed approval receipt bytes.');
  check(canonical(signed.data.independentApproval) === canonical({ service: approval.service, instanceId: approval.instanceId, approvalId: approval.approvalId, receiptSha256: approval.receiptSha256 }), 'Approval receipt is not bound to the accepted signature.');
  const parts = approval.receipt.split('.');
  check(parts.length === 3, 'Invalid approval receipt.');
  const receipt = parseEvidenceJson(Buffer.from(parts[1], 'base64url'));
  check(receipt.schema === 'signhere-approval-receipt-v1' && receipt.service === approval.service && receipt.instance?.id === approval.instanceId, 'Approval receipt names another service or installation.');
  check(receipt.transaction?.documentId === doc.id && receipt.transaction?.revisionId === doc.id && receipt.transaction?.recipientId === recipient.id, 'Approval receipt is bound to another document or recipient.');
  check(receipt.document?.preparedSha256 === digest(original) && receipt.document?.preparedSize === original.length, 'Approval receipt is for another prepared PDF.');
  check(receipt.intentSha256 === recipient.intent.sha256 && receipt.policySha256 === digest(Buffer.from(canonical(policy), 'utf8')), 'Approval receipt is bound to another intent or policy.');
  check(receipt.email?.address === String(recipient.email).trim().toLowerCase(), 'Approval receipt confirms another email address.');
}
async function runCli() {
  const args = process.argv.slice(2);
  const trustIndex = args.indexOf('--trust-fingerprint');
  const trustInput = trustIndex >= 0 ? args.splice(trustIndex, 2)[1] : undefined;
  try {
    const trustedFingerprint = trustIndex >= 0 ? normalizeFingerprint(trustInput) : undefined;
    check(args.length >= 3 && args.length <= 4 && (trustIndex < 0 || /^[a-f0-9]{64}$/.test(trustedFingerprint ?? '')), 'Usage: node verify-evidence.mjs evidence.json original.pdf completed.pdf [uploaded.pdf] [--trust-fingerprint HEX]');
    const [manifestPath, originalPath, completedPath, uploadedPath] = args;
    const manifest = parseEvidenceJson(readBoundedFile(manifestPath, MAX_EVIDENCE_JSON_BYTES));
    const original = readBoundedFile(originalPath, MAX_PDF_BYTES), completed = readBoundedFile(completedPath, MAX_PDF_BYTES), uploaded = uploadedPath ? readBoundedFile(uploadedPath, MAX_PDF_BYTES) : undefined;
    if (manifest.schemaVersion === 2) {
      const { verifySealedEvidence } = await import('./verify-sealed-evidence.mjs');
      const result = await verifySealedEvidence(manifest, original, completed, uploaded, trustedFingerprint);
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.issuerTrust === 'unknown' ? 3 : 0;
    } else {
      check(!trustedFingerprint, 'Legacy evidence has no certificate seal to authenticate with a fingerprint.');
      const result = verifyEvidence(manifest, original, completed, uploaded);
      console.log(JSON.stringify(result, null, 2));
      if (result.uploadedSourceVerified === false) console.log('The pre-conversion upload was not supplied; its recorded hash has not been independently checked.');
      console.log('PDF hashes and audit links match. This checks consistency, not signer identity, trusted time, or issuer authenticity. Compare the checkpoint with an independently retained copy.');
    }
  } catch (error) { console.error(`Verification failed: ${error.message}`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void runCli();
