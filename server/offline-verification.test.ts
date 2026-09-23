import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { canonical } from './db.js';
import { signingIntent, freezeEvidenceCore, intentEvidence, eventEvidence, LOCAL_SEAL_POLICY } from './evidence.js';
import { createLocalIdentity, signPdf } from './seal.js';
import { CONSENT } from './plugins.js';
// The portable verifier is deliberately JavaScript without application imports.
// @ts-expect-error standalone verifier has no declaration file
import { verifySealedEvidence } from '../scripts/verify-sealed-evidence.mjs';
// @ts-expect-error standalone verifier has no declaration file
import { verifyEvidence, decodeEvidenceCore, parseEvidenceJson } from '../scripts/verify-evidence.mjs';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
let directory: string, original: Buffer, completed: Buffer, manifest: any, fingerprint: string;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'signhere-offline-test-'));
  const pdf = await PDFDocument.create(); pdf.addPage([595, 842]); original = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const installationId = randomUUID(), documentId = randomUUID(), recipientId = randomUUID();
  const identity = await createLocalIdentity(join(directory, 'identity'), installationId); fingerprint = identity.fingerprintSha256;
  const sender = { name: 'Test sender', email: 'sender@example.test' }, createdAt = '2026-09-24T02:00:00.000Z', signedAt = '2026-09-24T02:01:00.000Z', completedAt = '2026-09-24T02:02:00.000Z';
  const document = { id: documentId, title: 'Offline verifier fixture', file_name: 'fixture.pdf', original_hash: hash(original), size: original.length, pages: 1, created_at: createdAt, sender };
  const recipient: any = { id: recipientId, position: 0, name: 'Test signer', email: 'signer@example.test', method_id: 'draw', method_version: '1', signed_at: signedAt, claimed_name: 'Test signer' };
  recipient.signing_intent = signingIntent(installationId, document, recipient);
  const events: any[] = [];
  const append = (type: string, at: string, data: any) => {
    const previous_hash = events.at(-1)?.hash ?? '0'.repeat(64), sequence = events.length + 1;
    data = { ...data, eventNonce: randomBytes(32).toString('base64url') };
    const event = { sequence, type, at, data, previous_hash, hash: hash(canonical({ documentId, sequence, type, at, data, previousHash: previous_hash })) };
    events.push(event); return event;
  };
  append('document.created', createdAt, { title: document.title, fileName: document.file_name, originalHash: document.original_hash, size: document.size, pages: 1, sender,
    recipients: [{ id: recipientId, name: recipient.name, email: recipient.email }], method: { id: 'draw', version: '1' }, senderRecipientId: null,
    evidenceVersion: 2, installationId, protectionPolicy: LOCAL_SEAL_POLICY });
  const signature = [[{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.9 }]];
  append('recipient.viewed', '2026-09-24T02:00:30.000Z', { recipientId });
  const signed = append('recipient.signed', signedAt, { recipientId, assignedName: recipient.name, claimedName: recipient.claimed_name, email: recipient.email,
    originalHash: document.original_hash, signature, consent: CONSENT, method: { id: 'draw', version: '1' }, ip: '192.0.2.1', userAgent: 'Test verifier fixture', intent: intentEvidence(recipient.signing_intent) });
  const checkpoint = { sequence: signed.sequence, hash: signed.hash };
  const core = freezeEvidenceCore(installationId, document, [recipient], events, checkpoint);
  const signedPdf = await signPdf(original, { schema: 'signhere-seal-v1', evidenceSchema: 2, installationId, documentId, evidenceDigest: hash(core), preparedHash: hash(original), checkpoint,
    certificateFingerprint: fingerprint, policy: { timestamp: 'off' } }, { p12File: join(directory, 'identity/identity.p12'), expectedFingerprint: fingerprint });
  completed = signedPdf.bytes;
  append('document.completed', completedAt, { originalHash: hash(original), completedHash: hash(completed), signingCheckpoint: checkpoint, evidenceCoreHash: hash(core), seal: signedPdf.metadata });
  manifest = { schemaVersion: 2, document: { id: documentId, title: document.title, fileName: document.file_name, originalHash: hash(original), completedHash: hash(completed), size: original.length, pages: 1,
    createdAt, completedAt, sender, senderRecipientId: null, status: 'completed', signingCheckpoint: checkpoint, seal: { fingerprintSha256: fingerprint },
    recipients: [{ id: recipientId, name: recipient.name, email: recipient.email, methodId: 'draw', methodVersion: '1', signedName: recipient.claimed_name, signedAt, signature, ip: '192.0.2.1', userAgent: 'Test verifier fixture' }] },
    events: events.map(eventEvidence), signingCheckpoint: checkpoint, chainHead: events.at(-1)!.hash, evidenceCoreBase64: core.toString('base64'), evidenceCoreHash: hash(core), seal: signedPdf.metadata };
  await Promise.all([writeFile(join(directory, 'evidence.json'), JSON.stringify(manifest)), writeFile(join(directory, 'original.pdf'), original), writeFile(join(directory, 'completed.pdf'), completed)]);
  // A generated, non-user fixture for independent reader/render checks.
  const artifacts = resolve('.test-artifacts/offline-seal'); await mkdir(artifacts, { recursive: true });
  await Promise.all([writeFile(join(artifacts, 'original.pdf'), original), writeFile(join(artifacts, 'completed.pdf'), completed)]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('portable verifier checks realistic frozen v2 evidence without the originating server', async () => {
  const result = await verifySealedEvidence(manifest, original, completed, undefined, fingerprint);
  assert.equal(result.integrity, 'valid'); assert.equal(result.evidence, 'complete'); assert.equal(result.issuerTrust, 'pinned');
  assert.equal(result.signatures, 1); assert.equal(result.trustedTimestamp, false); assert.equal(result.completionMetadata, 'unsealed-consistency-only');
  assert.equal((await verifySealedEvidence(manifest, original, completed)).issuerTrust, 'unknown');
});
test('offline verifier rejects a rewritten core even if every unkeyed outer hash is recomputed', async () => {
  const changed = structuredClone(manifest), { core } = decodeEvidenceCore(changed);
  core.recipients[0].signedName = 'Forged signer';
  const bytes = Buffer.from(canonical(core)); changed.evidenceCoreBase64 = bytes.toString('base64'); changed.evidenceCoreHash = hash(bytes);
  await assert.rejects(verifySealedEvidence(changed, original, completed, undefined, fingerprint), /commitment/);
});
test('offline verifier rejects substituted participant or intent bindings', async () => {
  const changed = structuredClone(manifest); changed.document.recipients[0].name = 'Another person';
  await assert.rejects(verifySealedEvidence(changed, original, completed), /initial snapshot/);
  const { core } = decodeEvidenceCore(manifest); core.recipients[0].intent.bytesBase64 = Buffer.from('{}').toString('base64');
  const bytes = Buffer.from(canonical(core));
  assert.throws(() => verifyEvidence({ ...manifest, evidenceCoreBase64: bytes.toString('base64'), evidenceCoreHash: hash(bytes) }, original, completed), /Intent/);
});
test('strict evidence parsing rejects Unicode ambiguity, BOM and non-finite values', () => {
  for (const source of ['{"x":"\\ud800"}', '{"x":1e400}', '\ufeff{}']) assert.throws(() => parseEvidenceJson(Buffer.from(source)));
  assert.deepEqual(parseEvidenceJson(Buffer.from('{"x":"Swedish åäö and 🌈"}')), { x: 'Swedish åäö and 🌈' });
  const bad = structuredClone(manifest); bad.evidenceCoreBase64 += '\n'; assert.throws(() => decodeEvidenceCore(bad), /encoding|core/);
});
async function cli(script: string, args: string[]) {
  return new Promise<{ code: number | null; out: string; error: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve(script), ...args], { windowsHide: true, shell: false }); let out = '', error = '';
    child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('error', reject); child.on('close', code => resolveResult({ code, out, error }));
  });
}
test('CLI distinguishes pinned success, intact unknown issuer and failure', async () => {
  const args = ['evidence.json', 'original.pdf', 'completed.pdf'].map(name => join(directory, name));
  const unknown = await cli('scripts/verify-sealed-evidence.mjs', args); assert.equal(unknown.code, 3, unknown.error);
  assert.equal(JSON.parse(unknown.out).issuerTrust, 'unknown');
  const pinned = await cli('scripts/verify-evidence.mjs', [...args, '--trust-fingerprint', fingerprint.toUpperCase().match(/.{2}/g)!.join(':')]); assert.equal(pinned.code, 0, pinned.error);
  const wrong = await cli('scripts/verify-sealed-evidence.mjs', [...args, '--trust-fingerprint', 'b'.repeat(64)]); assert.equal(wrong.code, 1);
  const badArgument = await cli('scripts/verify-evidence.mjs', [...args, '--trust-fingerprint']); assert.equal(badArgument.code, 1);
});
