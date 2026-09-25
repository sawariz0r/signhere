import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { createApp } from './app.js';
import { uid } from './db.js';
import { sha256 } from './pdf.js';
import { createCentralApp, createInstance } from './central/app.js';
import { trustFixture, captureMailer, lastCode, databaseUrl } from './central/test-support.js';
import { CENTRAL_CONSENT, RECEIPT_TYP, parseJws } from './central/protocol.js';
import { generateSigner, signJws } from './central/keys.js';
import { createCentralClient, type CentralFetch } from './central-client.js';
// @ts-expect-error standalone verifier distributed with exports
import { verifySealedEvidence } from '../scripts/verify-sealed-evidence.mjs';
// @ts-expect-error standalone verifier distributed with exports
import { verifyApprovalReceipt, verifyBundle } from '../scripts/verify-approval.mjs';

const origin = 'http://localhost:3000';
const password = 'independent-approval-test-password';
const strokes = [[[0.1, 0.2], [0.35, 0.8], [0.7, 0.1], [0.9, 0.6]]];
function binary(response: any, callback: any) { const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks))); }

async function listen(t: TestContext) {
  let handler: RequestListener = (_req, res) => { res.statusCode = 503; res.end(); };
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return { url: 'http://localhost:' + (server.address() as { port: number }).port, set(next: RequestListener) { handler = next; } };
}
async function centralService(t: TestContext) {
  const http = await listen(t);
  const trust = await trustFixture(http.url);
  const mailer = captureMailer();
  const schema = 'central_test_' + uid().replaceAll('-', '');
  const central = await createCentralApp({ databaseUrl: databaseUrl!, schema, origin: http.url, signer: trust.receiptSigner, trustBundle: trust.trustBundle, mailer, rateLimit: false, cleanup: { autoStart: false } });
  t.after(async () => { await central.pool.query('DROP SCHEMA "' + schema + '" CASCADE'); await central.close(); });
  http.set(central.app);
  const instance = await createInstance(central.pool, { name: 'Test AB', origin });
  return { url: http.url, trust, mailer, central, instance };
}
async function instanceApp(t: TestContext, central: ReturnType<typeof createCentralClient> | null) {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-independent-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  const runtime = await createApp({ databaseUrl: databaseUrl!, dataDir, schema, baseUrl: origin, setupToken: 'independent-setup-token-long-enough-32', rateLimit: false, finalization: { autoStart: false }, central });
  t.after(async () => { await runtime.finalization.stop(); await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = request.agent(runtime.app), outsider = request(runtime.app);
  const post = (path: string, body: unknown, client: any = owner) => client.post(path).set('Origin', origin).send(body);
  assert.equal((await post('/api/setup', { setupToken: 'independent-setup-token-long-enough-32', name: 'Olle Avsändare', email: 'sender@example.test', password, teamName: 'Test AB' })).status, 201);
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Approved original A');
  const original = Buffer.from(await pdf.save());
  return { runtime, owner, outsider, post, original, dataDir };
}
async function participantApproves(service: Awaited<ReturnType<typeof centralService>>, url: string, pdf: Buffer, source: 'installation-transfer' | 'local-file' = 'installation-transfer') {
  const [approvalId, capability] = new URL(url).hash.slice(1).split('.');
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(service.url + path, { method, headers: { authorization: 'Capability ' + approvalId + '.' + capability, origin: service.url, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('POST', '/v1/participant/code', {})).status, 200);
  assert.equal((await call('POST', '/v1/participant/confirm', { code: lastCode(service.mailer) })).status, 200);
  const approved = await call('POST', '/v1/participant/approve', { preparedSha256: sha256(pdf), consentVersion: CENTRAL_CONSENT.version, accepted: true, documentSource: source });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return approved.body.receipt as string;
}

test('without central configuration an installation makes no central requests and offers no central option', async t => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => { calls++; return realFetch(...args); }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const f = await instanceApp(t, null);
  assert.equal((await f.owner.get('/api/bootstrap')).body.central, undefined);
  const refused = await f.post('/api/documents', { title: 'Avtal', fileName: 'a.pdf', pdfBase64: f.original.toString('base64'), recipients: [{ name: 'Anna', email: 'anna@example.test' }], methodId: 'draw', independentApproval: true });
  assert.equal(refused.status, 400);
  const created = await f.post('/api/documents', { title: 'Avtal', fileName: 'a.pdf', pdfBase64: f.original.toString('base64'), recipients: [{ name: 'Anna', email: 'anna@example.test' }], methodId: 'draw' });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.document.independentApproval, undefined);
  assert.deepEqual((await f.runtime.db.query('SELECT protection_policy FROM documents')).rows[0].protection_policy, { profile: 'signhere-seal-v1', timestamp: 'off' });
  const token = new URL(created.body.links[0].url).hash.slice(1);
  const session = await f.post('/api/sign/session', { token }, f.outsider);
  assert.equal(session.body.independentApproval, undefined);
  assert.deepEqual((await f.post('/api/sign/independent-approval', { token }, f.outsider)).body, { required: false });
  const signed = await f.post('/api/sign/complete', { token, documentHash: created.body.document.originalHash, consentVersion: session.body.consent.version, signingIntentHash: session.body.signingIntentHash, accepted: true, name: 'Anna', payload: { strokes } }, f.outsider);
  assert.equal(signed.status, 200, signed.text);
  assert.equal((await f.runtime.finalization.runOnce()).status, 'completed');
  assert.equal((await f.owner.get('/api/documents/' + created.body.document.id + '/verification-package').buffer(true).parse(binary)).status, 200);
  assert.equal(calls, 0, 'no network requests');
});

test('independent approval end to end: browser transfer, email code, receipt, sealed commitment and offline verification', async t => {
  const service = await centralService(t);
  const client = createCentralClient({ url: service.url, apiKey: service.instance.apiKey, trustRoot: service.trust.root.publicKey });
  const f = await instanceApp(t, client);
  assert.deepEqual((await f.owner.get('/api/bootstrap')).body.central, { service: service.url, independentApproval: true });
  const created = await f.post('/api/documents', { title: 'Avtal', fileName: 'a.pdf', pdfBase64: f.original.toString('base64'), recipients: [{ name: 'Anna Andersson', email: 'Anna@Example.test' }], methodId: 'draw', independentApproval: true });
  assert.equal(created.status, 201, created.text);
  const document = created.body.document;
  assert.equal(document.independentApproval.service, service.url);
  const token = new URL(created.body.links[0].url).hash.slice(1);
  const session = await f.post('/api/sign/session', { token }, f.outsider);
  assert.deepEqual(session.body.independentApproval, { required: true, service: service.url });
  const complete = { token, documentHash: document.originalHash, consentVersion: session.body.consent.version, signingIntentHash: session.body.signingIntentHash, accepted: true, name: 'Anna Andersson', payload: { strokes } };
  // Signing is blocked until the service has confirmed and the receipt verifies.
  assert.equal((await f.post('/api/sign/complete', complete, f.outsider)).status, 409);
  const pending = (await f.post('/api/sign/independent-approval', { token }, f.outsider)).body;
  assert.equal(pending.status, 'pending');
  assert.ok(pending.url.startsWith(service.url + '/bekrafta#apr_'));
  const [, , transfer] = new URL(pending.url).hash.slice(1).split('.');
  // Browser transfer: CORS only for the frozen service origin; bytes are the prepared PDF.
  const preflight = await f.outsider.options('/api/central/prepared/' + document.id).set('Origin', service.url);
  assert.equal(preflight.headers['access-control-allow-origin'], service.url);
  const pdf = await f.outsider.get('/api/central/prepared/' + document.id).set('Origin', service.url).set('Authorization', 'Bearer ' + transfer).buffer(true).parse(binary);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['access-control-allow-origin'], service.url);
  assert.equal(sha256(pdf.body), document.originalHash);
  const evil = await f.outsider.get('/api/central/prepared/' + document.id).set('Origin', 'https://evil.example').set('Authorization', 'Bearer ' + transfer);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.outsider.get('/api/central/prepared/' + document.id).set('Authorization', 'Bearer ' + 'x'.repeat(43))).status, 404);
  // The participant confirms the code and approves at the service.
  const receipt = await participantApproves(service, pending.url, pdf.body);
  assert.equal(service.mailer.sent[0].to, 'anna@example.test');
  const verified = (await f.post('/api/sign/independent-approval', { token }, f.outsider)).body;
  assert.equal(verified.status, 'verified', JSON.stringify(verified));
  assert.equal(verified.receiptSha256, sha256(receipt));
  // The transfer token is retired once verified.
  assert.equal((await f.outsider.get('/api/central/prepared/' + document.id).set('Authorization', 'Bearer ' + transfer)).status, 404);
  const signed = await f.post('/api/sign/complete', complete, f.outsider);
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.body.document.status, 'finalizing');
  assert.equal((await f.runtime.finalization.runOnce()).status, 'completed');
  const detail = (await f.owner.get('/api/documents/' + document.id)).body.document;
  assert.equal(detail.recipients[0].independentApproval.status, 'verified');
  // Offline: seal commits to the receipt; the receipt verifies only with an independently supplied root.
  const evidence = (await f.owner.get('/api/documents/' + document.id + '/evidence')).body;
  assert.equal(evidence.assurance.civilIdentityVerified, false);
  const completed = (await f.owner.get('/api/documents/' + document.id + '/pdf?version=completed').buffer(true).parse(binary)).body;
  const withoutRoot = await verifySealedEvidence(evidence, f.original, completed);
  assert.equal(withoutRoot.independentApproval.participants[0].receiptSignature, 'not-checked');
  assert.equal(withoutRoot.independentApproval.completedContentRelationship, 'unverified');
  const withRoot = await verifySealedEvidence(evidence, f.original, completed, undefined, undefined, service.trust.root.publicKey);
  assert.equal(withRoot.independentApproval.participants[0].receiptSignature, 'valid');
  assert.equal(withRoot.independentApproval.participants[0].keyTrust, 'trusted');
  assert.equal(withRoot.independentApproval.participants[0].preparedPdf, 'matched');
  assert.equal(withRoot.independentApproval.trustRoot, 'supplied-matches-frozen');
  const attacker = await generateSigner();
  const wrongRoot = await verifySealedEvidence(evidence, f.original, completed, undefined, undefined, attacker.signer.publicKey).catch((error: Error) => error);
  assert.match(String(wrongRoot), /bundle_root_mismatch/);
  // Portable package contains the exact receipt and bundle.
  const zip = unzipSync((await f.owner.get('/api/documents/' + document.id + '/verification-package').buffer(true).parse(binary)).body);
  const recipientId = detail.recipients[0].id;
  assert.equal(Buffer.from(zip['approvals/' + recipientId + '.receipt.jws']).toString(), receipt);
  const bundle = verifyBundle(Buffer.from(zip['approvals/' + recipientId + '.trust-bundle.jws']).toString(), service.trust.root.publicKey);
  // A/B: the receipt is for A. A different visible document B is never reported as approved.
  const b = await PDFDocument.create(); b.addPage().drawText('Different document B');
  const bBytes = Buffer.from(await b.save());
  const againstB = verifyApprovalReceipt(receipt, bundle, { prepared: bBytes });
  assert.equal(againstB.preparedPdf, 'mismatch'); assert.equal(againstB.valid, false);
  const withCompleted = verifyApprovalReceipt(receipt, bundle, { prepared: f.original, completed: bBytes });
  assert.equal(withCompleted.valid, true); assert.equal(withCompleted.completedPdf.relationship, 'unverified');
  assert.equal(withCompleted.claimedName.verified, false); assert.equal(withCompleted.civilIdentityVerified, false);
});

test('a forged or mismatched receipt is rejected and a changed configuration never skips approval', async t => {
  const service = await centralService(t);
  const client = createCentralClient({ url: service.url, apiKey: service.instance.apiKey, trustRoot: service.trust.root.publicKey });
  const f = await instanceApp(t, client);
  const created = (await f.post('/api/documents', { title: 'Avtal', fileName: 'a.pdf', pdfBase64: f.original.toString('base64'), recipients: [{ name: 'Anna', email: 'anna@example.test' }, { name: 'Bo', email: 'bo@example.test' }], methodId: 'draw', independentApproval: true })).body;
  const [tokenA, tokenB] = created.links.map((link: any) => new URL(link.url).hash.slice(1));
  const pendingA = (await f.post('/api/sign/independent-approval', { token: tokenA }, f.outsider)).body;
  const receiptA = await participantApproves(service, pendingA.url, f.original, 'local-file');
  // A malicious or broken service response: B's approval "returns" A's receipt, or a self-signed one.
  const attacker = await generateSigner();
  const forged = await signJws(attacker.signer, RECEIPT_TYP, parseJws(receiptA, RECEIPT_TYP).payload);
  for (const receipt of [receiptA, forged]) {
    const fake: CentralFetch = async (url, init) => {
      const response = await fetch(url, init);
      if (!url.includes('/v1/approvals')) return response;
      const data = await response.json();
      return { status: response.status, json: async () => ({ ...data, status: 'approved', receipt }) };
    };
    const tampered = await instanceAppWith(t, f, createCentralClient({ url: service.url, apiKey: service.instance.apiKey, trustRoot: service.trust.root.publicKey }, { fetch: fake }));
    const result = (await tampered.post('/api/sign/independent-approval', { token: tokenB }, tampered.outsider)).body;
    assert.equal(result.status, 'rejected', JSON.stringify(result));
  }
  // Configuration now points elsewhere (or is removed): the frozen requirement stays and signing stays blocked.
  for (const other of [null, createCentralClient({ url: service.url, apiKey: service.instance.apiKey, trustRoot: attacker.signer.publicKey })]) {
    const changed = await instanceAppWith(t, f, other);
    const result = (await changed.post('/api/sign/independent-approval', { token: tokenB }, changed.outsider)).body;
    assert.equal(result.status, 'unavailable');
    const session = (await changed.post('/api/sign/session', { token: tokenB }, changed.outsider)).body;
    const blocked = await changed.post('/api/sign/complete', { token: tokenB, documentHash: created.document.originalHash, consentVersion: session.consent.version, signingIntentHash: session.signingIntentHash, accepted: true, name: 'Bo', payload: { strokes } }, changed.outsider);
    assert.equal(blocked.status, 409);
  }
  // Cancellation reaches the service best-effort and closes the local requirement.
  assert.equal((await f.post('/api/documents/' + created.document.id + '/cancel', {})).status, 200);
  await new Promise(resolve => setTimeout(resolve, 200));
  const states = (await service.central.pool.query('SELECT status FROM approvals ORDER BY created_at')).rows.map(row => row.status);
  assert.deepEqual(states.sort(), ['approved', 'cancelled']);
});

/** A second app over the same database schema, as after a restart with different configuration. */
async function instanceAppWith(t: TestContext, f: Awaited<ReturnType<typeof instanceApp>>, central: ReturnType<typeof createCentralClient> | null) {
  const schema = (await f.runtime.db.query('SELECT current_schema() AS schema')).rows[0].schema;
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-independent-'));
  const runtime = await createApp({ databaseUrl: databaseUrl!, dataDir, schema, baseUrl: origin, rateLimit: false, finalization: { autoStart: false }, central, keysDir: join(f.dataDir, 'keys') });
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const outsider = request(runtime.app);
  return { runtime, outsider, post: (path: string, body: unknown, client: any) => client.post(path).set('Origin', origin).send(body) };
}
