import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
export function verifyEvidence(manifest, original, completed, uploaded) {
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, originalPath, completedPath, uploadedPath] = process.argv.slice(2);
  if (!manifestPath || !originalPath || !completedPath) {
    console.error('Usage: npm run verify:evidence -- evidence.json original.pdf completed.pdf [uploaded.pdf]'); process.exitCode = 2;
  } else {
    try {
      const result = verifyEvidence(JSON.parse(readFileSync(manifestPath, 'utf8')), readFileSync(originalPath), readFileSync(completedPath), uploadedPath ? readFileSync(uploadedPath) : undefined);
      console.log(JSON.stringify(result, null, 2));
      if (result.uploadedSourceVerified === false) console.log('The pre-conversion upload was not supplied; its recorded hash has not been independently checked.');
      console.log('PDF hashes and audit links match. This checks consistency, not signer identity, trusted time, or issuer authenticity. Compare the checkpoint with an independently retained copy.');
    } catch (error) { console.error(`Verification failed: ${error.message}`); process.exitCode = 1; }
  }
}
