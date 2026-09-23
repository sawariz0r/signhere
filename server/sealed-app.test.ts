import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { createApp } from './app.js';
import { canonical, transaction, uid } from './db.js';
import { CONSENT } from './plugins.js';
import { finalizePdf, sha256 } from './pdf.js';
// @ts-expect-error standalone verifier distributed with exports
import { verifySealedEvidence } from '../scripts/verify-sealed-evidence.mjs';
try { loadEnvFile('.local/postgres.env'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Real PostgreSQL is required.');
const origin = 'http://localhost:3000';
const password = 'sealed-test-correct-horse-battery';
const strokes = [[[0.1, 0.2], [0.35, 0.8], [0.7, 0.1], [0.9, 0.6]]];
function binary(response: any, callback: any) { const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks))); }

test('v2 sender and client approval survive finalizer failure, seal independently and export renewable portable evidence', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-sealed-api-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  let clock = Date.now(), fail = true;
  const runtime = await createApp({ databaseUrl, dataDir, schema, baseUrl: origin, setupToken: 'sealed-test-setup-token-long-enough', rateLimit: false,
    now: () => clock, finalization: { autoStart: false }, pdfFinalizer: async (...args) => { if (fail) throw new Error('simulated PDF failure'); return finalizePdf(...args); } });
  t.after(async () => { await runtime.finalization.stop(); await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = request.agent(runtime.app), outsider = request(runtime.app);
  const post = (path: string, body: unknown, client: any = owner) => client.post(path).set('Origin', origin).send(body);
  assert.equal((await owner.get('/api/ready')).status, 200);
  const certificate = (await outsider.get('/.well-known/signhere-sealing.json')).body;
  assert.match(certificate.fingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal((await post('/api/setup', { setupToken: 'sealed-test-setup-token-long-enough', name: 'Oscar Sender', email: 'same@example.test', password, teamName: 'Seal tests' })).status, 201);
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Prepared original must remain independently verifiable.');
  const original = Buffer.from(await pdf.save());
  const createdResponse = await post('/api/documents', { title: 'Two required approvals', fileName: 'original.pdf', pdfBase64: original.toString('base64'), recipients: [{ name: 'Client Ocar', email: 'same@example.test' }], includeSender: true, methodId: 'draw' });
  assert.equal(createdResponse.status, 201, createdResponse.text);
  const created = createdResponse.body;
  assert.equal(created.document.evidenceVersion, 2); assert.equal(created.links.length, 2);
  const tokens = created.links.map((link: any) => new URL(link.url).hash.slice(1));
  const sessions = await Promise.all(tokens.map((token: string) => post('/api/sign/session', { token }, outsider)));
  assert.notEqual(sessions[0].body.signingIntentHash, sessions[1].body.signingIntentHash);
  const body = (index: number) => ({ token: tokens[index], documentHash: created.document.originalHash, consentVersion: sessions[index].body.consent.version, signingIntentHash: sessions[index].body.signingIntentHash, accepted: true, name: index ? 'Oscar Sender' : 'Client Ocar', payload: { strokes } });
  assert.equal((await post('/api/sign/complete', { ...body(0), signingIntentHash: sessions[1].body.signingIntentHash }, outsider)).status, 409);
  // Valid geometry and point count, but long decimal coordinates exceed the canonical byte budget.
  const oversizedStrokes = [Array.from({ length: 2000 }, (_, i) => [i % 2 ? 0.1234567890123456 : 0.8765432109876543, i % 2 ? 0.9876543210987654 : 0.2345678901234567])];
  assert.ok(Buffer.byteLength(canonical(oversizedStrokes)) > 65536);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...body(0), payload: { strokes: oversizedStrokes } })) < 1024 * 1024);
  const oversized = await post('/api/sign/complete', { ...body(0), payload: { strokes: oversizedStrokes } }, outsider);
  assert.equal(oversized.status, 400, oversized.text); assert.match(oversized.body.error, /64 KB/);
  assert.equal((await runtime.db.query('SELECT count(*) AS count FROM recipients WHERE document_id=$1 AND signed_at IS NOT NULL', [created.document.id])).rows[0].count, '0');
  assert.equal((await runtime.db.query("SELECT count(*) AS count FROM events WHERE document_id=$1 AND type='recipient.signed'", [created.document.id])).rows[0].count, '0');
  const senderAccepted = await post('/api/sign/complete', body(1), outsider);
  assert.equal(senderAccepted.status, 200); assert.equal(senderAccepted.body.document.status, 'pending');
  assert.equal(senderAccepted.body.document.recipients.find((r: any) => r.id === created.senderRecipientId).signedName, 'Oscar Sender');
  const accepted = await post('/api/sign/complete', body(0), outsider).set('User-Agent', 'Private signing evidence agent');
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.body.document.status, 'finalizing');
  assert.ok(accepted.body.document.recipients.every((r: any) => r.signedAt));
  assert.equal((await post('/api/documents/' + created.document.id + '/cancel', {})).status, 409);
  assert.equal((await runtime.finalization.runOnce()).status, 'retry');
  const receipt = (await post('/api/sign/session', { token: tokens[0] }, outsider)).body;
  assert.equal(receipt.document.status, 'finalizing'); assert.ok(receipt.document.recipients[0].signedAt);
  assert.equal((await post('/api/sign/complete', body(0), outsider)).body.document.status, 'finalizing');
  assert.equal((await runtime.db.query("SELECT count(*) AS count FROM events WHERE document_id=$1 AND type='recipient.signed'", [created.document.id])).rows[0].count, '2');
  fail = false;
  await runtime.db.query('UPDATE finalization_jobs SET available_at=clock_timestamp() WHERE document_id=$1', [created.document.id]);
  const finalized = await runtime.finalization.runOnce();
  assert.equal(finalized.status, 'completed', JSON.stringify(finalized));
  const evidence = (await owner.get('/api/documents/' + created.document.id + '/evidence')).body;
  assert.equal(evidence.schemaVersion, 2); assert.equal(evidence.document.status, 'completed');
  const frozenCore = JSON.parse(Buffer.from(evidence.evidenceCoreBase64, 'base64').toString('utf8'));
  const storedSigners = (await runtime.db.query('SELECT id,signed_at,evidence FROM recipients WHERE document_id=$1 ORDER BY position', [created.document.id])).rows;
  for (const signer of storedSigners) {
    const event = evidence.events.find((item: any) => item.type === 'recipient.signed' && item.data.recipientId === signer.id);
    const frozenEvent = frozenCore.events.find((item: any) => item.type === 'recipient.signed' && item.data.recipientId === signer.id);
    assert.ok(event); assert.deepEqual(frozenEvent, event);
    for (const saved of [signer.evidence, event.data, frozenEvent.data]) {
      assert.equal(saved.authenticationMethod, 'personal_signing_link');
      assert.equal(saved.consentAcceptedAt, event.at); assert.equal(saved.signedAt, event.at);
      assert.equal(saved.documentId, created.document.id); assert.equal(saved.transactionId, created.document.id);
      assert.equal(saved.recipientId, signer.id);
    }
    assert.equal(signer.signed_at, event.at);
  }
  assert.equal(storedSigners[0].evidence.userAgent, 'Private signing evidence agent');
  const completeResponse = await owner.get('/api/documents/' + created.document.id + '/pdf?version=completed').buffer(true).parse(binary);
  const completed = completeResponse.body;
  assert.equal(sha256(completed), evidence.document.completedHash);
  const participantDownload = await outsider.post('/api/sign/download').set('Origin', origin).send({ token: tokens[0] }).buffer(true).parse(binary);
  assert.equal(participantDownload.status, 200); assert.match(participantDownload.headers['content-type'], /^application\/pdf/);
  assert.deepEqual(participantDownload.body, completed, 'A participant receives the public sealed PDF, not the private audit bundle.');
  const unknown = await verifySealedEvidence(evidence, original, completed);
  assert.equal(unknown.integrity, 'valid'); assert.equal(unknown.issuerTrust, 'unknown'); assert.equal(unknown.signatures, 2);
  const pinned = await verifySealedEvidence(evidence, original, completed, undefined, certificate.fingerprintSha256);
  assert.equal(pinned.issuerTrust, 'pinned'); assert.equal(pinned.trustedTimestamp, false); assert.equal(pinned.identityVerified, false);
  await assert.rejects(verifySealedEvidence(evidence, original, Buffer.concat([completed, Buffer.from('\n%unsigned append')]), undefined, certificate.fingerprintSha256));
  const changed = structuredClone(evidence); changed.evidenceCoreBase64 = Buffer.from(Buffer.from(changed.evidenceCoreBase64, 'base64').toString('utf8').replace('Client Ocar', 'Client Oscar')).toString('base64');
  await assert.rejects(verifySealedEvidence(changed, original, completed));
  assert.equal((await outsider.get('/api/documents/' + created.document.id + '/verification-package')).status, 401);
  const packageResponse = await owner.get('/api/documents/' + created.document.id + '/verification-package').buffer(true).parse(binary);
  assert.equal(packageResponse.status, 200, packageResponse.text);
  const files = unzipSync(packageResponse.body);
  assert.deepEqual(Buffer.from(files['original.pdf']), original); assert.deepEqual(Buffer.from(files['completed.pdf']), completed);
  assert.ok(files['LICENSE']); assert.ok(files['pdf-seal/requirements.txt']);
  assert.match(Buffer.from(files['evidence.json']).toString('utf8'), /Private signing evidence agent/);
  const exportDir = join(dataDir, 'export'); await mkdir(exportDir);
  for (const [name, bytes] of Object.entries(files)) { const target = join(exportDir, name); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, bytes); }
  const command = await promisify(execFile)(process.execPath, ['verify-sealed-evidence.mjs', 'evidence.json', 'original.pdf', 'completed.pdf', '--trust-fingerprint', certificate.fingerprintSha256], { cwd: exportDir, windowsHide: true, env: { ...process.env, SIGNHERE_SEAL_PYTHON: resolve('.local/seal-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') } });
  assert.equal(JSON.parse(command.stdout).evidence, 'complete');
  clock += 31 * 86400000;
  assert.equal((await post('/api/sign/download', { token: tokens[0] }, outsider)).status, 404);
  assert.equal((await post('/api/login', { email: 'same@example.test', password })).status, 200);
  const copy = await post(`/api/documents/${created.document.id}/recipients/${created.document.recipients[0].id}/copy-link`, {});
  assert.equal(copy.status, 200, copy.text);
  const copyToken = new URL(copy.body.url).hash.slice(1);
  const copyDownload = () => outsider.post('/api/copy/download').set('Origin', origin).send({ token: copyToken }).buffer(true).parse(binary);
  const renewedPdf = await copyDownload();
  assert.equal(renewedPdf.status, 200); assert.match(renewedPdf.headers['content-type'], /^application\/pdf/);
  assert.deepEqual(renewedPdf.body, completed, 'Renewal grants only the public sealed PDF.');
  const copyPath = `/api/documents/${created.document.id}/recipients/${created.document.recipients[0].id}/revoke-copy-links`;
  assert.equal((await post(copyPath, {}, outsider)).status, 401);
  assert.equal((await copyDownload()).status, 200, 'An unauthenticated revocation cannot invalidate access.');
  const otherCopy = await post(`/api/documents/${created.document.id}/recipients/${created.senderRecipientId}/copy-link`, {});
  assert.equal(otherCopy.status, 200);
  const otherCopyToken = new URL(otherCopy.body.url).hash.slice(1);
  assert.equal((await post(copyPath, {})).status, 200);
  assert.equal((await copyDownload()).status, 404);
  assert.equal((await outsider.post('/api/copy/download').set('Origin', origin).send({ token: otherCopyToken }).buffer(true).parse(binary)).status, 200, 'Revocation is scoped to the selected recipient.');
  const retained = (await runtime.db.query('SELECT evidence_core,completed FROM documents WHERE id=$1', [created.document.id])).rows[0];
  assert.equal(retained.evidence_core.toString('base64'), evidence.evidenceCoreBase64); assert.deepEqual(retained.completed, completed);
  assert.equal((await runtime.db.query('SELECT count(*) AS count FROM events WHERE document_id=$1', [created.document.id])).rows[0].count, String(evidence.events.length));
});


test('v2 pending documents preserve their frozen consent across an application consent revision', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-old-consent-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  const oldConsent = { version: 'signhere-consent-before-upgrade', text: 'This is the exact consent shown by the earlier application version.' };
  let finalizerConsent: unknown, finalizerSignerConsent: unknown;
  const runtime = await createApp({ databaseUrl, dataDir, schema, baseUrl: origin, setupToken: 'old-consent-test-setup-token-long-enough', rateLimit: false,
    finalization: { autoStart: false }, pdfFinalizer: async (...args) => { finalizerConsent = args[4]; finalizerSignerConsent = args[5][0].consent; return finalizePdf(...args); } });
  t.after(async () => { await runtime.finalization.stop(); await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = request.agent(runtime.app), signer = request(runtime.app);
  const post = (path: string, body: unknown, client: any = owner) => client.post(path).set('Origin', origin).send(body);
  assert.equal((await post('/api/setup', { setupToken: 'old-consent-test-setup-token-long-enough', name: 'Consent Owner', email: 'owner@example.test', password, teamName: 'Historical consent' })).status, 201);
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Approved under an earlier consent version.');
  const original = Buffer.from(await pdf.save());
  const response = await post('/api/documents', { title: 'Historical consent', fileName: 'original.pdf', pdfBase64: original.toString('base64'), recipients: [{ name: 'Assigned Signer', email: 'signer@example.test' }], includeSender: false, methodId: 'draw' });
  assert.equal(response.status, 201, response.text);
  const created = response.body, recipientId = created.document.recipients[0].id;
  const token = new URL(created.links[0].url).hash.slice(1);
  // Emulate a persisted, unsigned intent created by an earlier release. Only this isolated test's
  // schema owner can bypass the assignment guard; DDL and fixture mutation roll back together.
  const intentBytes = await transaction(runtime.db, async client => {
    const row = (await client.query('SELECT signing_intent,signed_at FROM recipients WHERE id=$1', [recipientId])).rows[0];
    assert.equal(row.signed_at, null);
    const intent = JSON.parse(row.signing_intent.toString('utf8')); intent.consent = oldConsent;
    const bytes = Buffer.from(canonical(intent));
    await client.query('ALTER TABLE recipients DISABLE TRIGGER recipients_immutable');
    await client.query('UPDATE recipients SET signing_intent=$1 WHERE id=$2', [bytes, recipientId]);
    await client.query('ALTER TABLE recipients ENABLE TRIGGER recipients_immutable');
    return bytes;
  });
  assert.equal((await runtime.db.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='recipients'::regclass AND tgname='recipients_immutable'")).rows[0].tgenabled, 'O');
  const session = await post('/api/sign/session', { token }, signer);
  assert.equal(session.status, 200); assert.deepEqual(session.body.consent, oldConsent);
  assert.equal(session.body.signingIntentHash, sha256(intentBytes));
  assert.notEqual(session.body.consent.version, CONSENT.version);
  const approval = { token, documentHash: created.document.originalHash, consentVersion: oldConsent.version, signingIntentHash: session.body.signingIntentHash, accepted: true, name: 'Claimed Signer', payload: { strokes } };
  const currentConsent = await post('/api/sign/complete', { ...approval, consentVersion: CONSENT.version }, signer);
  assert.equal(currentConsent.status, 400, currentConsent.text);
  assert.equal((await runtime.db.query('SELECT signed_at FROM recipients WHERE id=$1', [recipientId])).rows[0].signed_at, null);
  const accepted = await post('/api/sign/complete', approval, signer);
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.body.document.status, 'finalizing');
  const signed = (await runtime.db.query('SELECT signed_at,evidence FROM recipients WHERE id=$1', [recipientId])).rows[0];
  const event = (await runtime.db.query("SELECT * FROM events WHERE document_id=$1 AND type='recipient.signed'", [created.document.id])).rows[0];
  for (const saved of [signed.evidence, event.data]) {
    assert.deepEqual(saved.consent, oldConsent); assert.equal(saved.authenticationMethod, 'personal_signing_link');
    assert.equal(saved.consentAcceptedAt, event.at); assert.equal(saved.signedAt, event.at);
    assert.equal(saved.documentId, created.document.id); assert.equal(saved.transactionId, created.document.id);
    assert.equal(saved.recipientId, recipientId); assert.equal(saved.assignedName, 'Assigned Signer'); assert.equal(saved.claimedName, 'Claimed Signer');
    assert.equal(saved.intent.bytesBase64, intentBytes.toString('base64'));
  }
  assert.equal(signed.signed_at, event.at);
  const finalized = await runtime.finalization.runOnce();
  assert.equal(finalized.status, 'completed', JSON.stringify(finalized));
  assert.deepEqual(finalizerConsent, oldConsent); assert.deepEqual(finalizerSignerConsent, oldConsent);
  const manifest = (await owner.get('/api/documents/' + created.document.id + '/evidence')).body;
  const completed = (await owner.get('/api/documents/' + created.document.id + '/pdf?version=completed').buffer(true).parse(binary)).body;
  const checked = await verifySealedEvidence(manifest, original, completed);
  assert.equal(checked.integrity, 'valid'); assert.equal(checked.evidence, 'complete');
  const frozen = JSON.parse(Buffer.from(manifest.evidenceCoreBase64, 'base64').toString('utf8'));
  assert.deepEqual(frozen.events.find((item: any) => item.type === 'recipient.signed').data.consent, oldConsent);
});


test('missing PDF sandbox is unavailable readiness and a service error before invitations, not an invalid-document error', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-readiness-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  const runtime = await createApp({ databaseUrl, dataDir, schema, baseUrl: origin, setupToken: 'sealed-test-setup-token-long-enough', rateLimit: false, finalization: {autoStart:false} });
  t.after(async () => { await runtime.finalization.stop(); await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, {recursive:true,force:true}); });
  const owner = request.agent(runtime.app);
  assert.equal((await owner.post('/api/setup').set('Origin',origin).send({setupToken:'sealed-test-setup-token-long-enough',name:'Readiness owner',email:'ready@example.test',password,teamName:'Readiness'})).status,201);
  const oldRequired=process.env.SIGNHERE_REQUIRE_PDF_SANDBOX, oldLauncher=process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER;
  process.env.SIGNHERE_REQUIRE_PDF_SANDBOX='true'; delete process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER;
  try {
    assert.equal((await owner.get('/api/ready')).status,503);
    const pdf=await PDFDocument.create();pdf.addPage();
    const created=await owner.post('/api/documents').set('Origin',origin).send({title:'Must not invite',fileName:'ready.pdf',pdfBase64:Buffer.from(await pdf.save()).toString('base64'),recipients:[{name:'Recipient',email:'recipient@example.test'}],methodId:'draw'});
    assert.equal(created.status,503,created.text); assert.doesNotMatch(created.body.error,/Exportera/);
    assert.equal((await runtime.db.query('SELECT count(*) FROM documents')).rows[0].count,'0');
    assert.equal((await runtime.db.query('SELECT count(*) FROM recipients')).rows[0].count,'0');
  } finally {
    if(oldRequired===undefined) delete process.env.SIGNHERE_REQUIRE_PDF_SANDBOX; else process.env.SIGNHERE_REQUIRE_PDF_SANDBOX=oldRequired;
    if(oldLauncher===undefined) delete process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER; else process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER=oldLauncher;
  }
});
