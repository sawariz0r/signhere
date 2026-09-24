import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import request from 'supertest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { createApp, type AppConfig } from './app.js';
import { canonical, uid } from './db.js';
import { sha256, finalizePdf } from './pdf.js';
import { CONSENT } from './plugins.js';
// @ts-expect-error standalone operational JavaScript verifier
import { verifyEvidence } from '../scripts/verify-evidence.mjs';

try { loadEnvFile('.local/postgres.env'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Tests require TEST_DATABASE_URL (or DATABASE_URL) pointing to a disposable PostgreSQL database.');
const origin = 'http://localhost:3000';
const setupToken = 'test-only-owner-setup-token-32-characters';
const password = 'correct horse battery staple';
const strokes = [[[0.1, 0.2], [0.35, 0.8], [0.7, 0.1], [0.9, 0.6]]];
const owner = { setupToken, name: 'Ägare Öberg', email: 'owner@example.test', password, teamName: 'Testteam' };
async function fixture(t: TestContext, overrides: Partial<AppConfig> = {}, setup = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-test-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  const runtime = await createApp({ databaseUrl: databaseUrl!, baseUrl: origin, dataDir, schema, setupToken, rateLimit: false, legacyCreation: true, ...overrides });
  t.after(async () => {
    await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE');
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const agent = request.agent(runtime.app);
  const post = (path: string, body: unknown, client: any = agent) => client.post(path).set('Origin', origin).send(body);
  if (setup) assert.equal((await post('/api/setup', owner)).status, 201);
  return { ...runtime, agent, post, dataDir };
}
async function pdfBytes() {
  const pdf = await PDFDocument.create(); pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save());
}
async function createDocument(f: Awaited<ReturnType<typeof fixture>>, names = ['Signer One'], bytes?: Buffer) {
  const original = bytes ?? await pdfBytes();
  const response = await f.post('/api/documents', {
    title: 'Överenskommelse', fileName: 'avtal.pdf', pdfBase64: original.toString('base64'),
    methodId: 'draw', recipients: names.map((name, i) => ({ name, email: 'signer' + i + '@example.test' })),
  });
  assert.equal(response.status, 201, response.text);
  return { ...response.body, original, tokens: response.body.links.map((link: { url: string }) => new URL(link.url).hash.slice(1)) };
}
function completeBody(document: any, raw: string, name = 'Signer One') {
  return { token: raw, documentHash: document.originalHash, consentVersion: CONSENT.version, accepted: true, name, payload: { strokes } };
}
function binary(response: any, callback: any) {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

test('bootstrap is exclusive, sessions are opaque, and every mutation checks origin and content type', async t => {
  const f = await fixture(t, {}, false);
  assert.equal((await request(f.app).get('/api/bootstrap')).body.setupRequired, true);
  assert.equal((await request(f.app).get('/api/documents')).status, 401);
  assert.equal((await f.post('/api/setup', { ...owner, setupToken: 'incorrect' })).status, 403);
  assert.equal((await request(f.app).post('/api/setup').send(owner)).status, 403);
  assert.equal((await request(f.app).post('/api/setup').set('Origin', 'https://evil.example').send(owner)).status, 403);
  assert.equal((await request(f.app).post('/api/setup').set('Origin', origin).type('form').send({ test: 'x' })).status, 415);
  const attempts = await Promise.all([f.post('/api/setup', owner), f.post('/api/setup', owner, request(f.app))]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
  assert.equal((await f.db.query('SELECT count(*) AS count FROM users')).rows[0].count, '1');
  const login = await f.post('/api/login', { email: owner.email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0] as string;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const raw = cookie.split(';')[0].split('=')[1];
  const stored = (await f.db.query('SELECT token_hash FROM sessions')).rows;
  assert.ok(stored.some(row => row.token_hash === sha256(raw)));
  assert.ok(stored.every(row => row.token_hash !== raw));
  assert.equal((await f.agent.get('/api/bootstrap')).body.user.role, 'owner');
  assert.equal((await f.post('/api/login', { email: owner.email, password: 'wrong password' })).status, 401);
  assert.equal((await f.post('/api/logout', {})).status, 200);
  assert.equal((await f.agent.get('/api/documents')).status, 401);
  assert.equal((await f.post('/api/setup', owner)).status, 409);
});

test('uploaded source stays byte-exact; unsafe PDFs and cross-team access are rejected', async t => {
  const f = await fixture(t);
  const created = await createDocument(f);
  assert.equal(created.document.originalHash, sha256(created.original));
  const original = await f.agent.get('/api/documents/' + created.document.id + '/pdf?version=original').buffer(true).parse(binary);
  assert.equal(original.status, 200); assert.deepEqual(original.body, created.original);
  const active = await PDFDocument.create(); active.addPage(); active.catalog.set(PDFName.of('OpenAction'), PDFString.of('bad'));
  for (const pdfBase64 of ['%%%%', Buffer.from('not a PDF').toString('base64'), Buffer.from(await active.save()).toString('base64')]) {
    const response = await f.post('/api/documents', { title: 'Invalid', fileName: 'bad.pdf', pdfBase64, recipients: [{ name: 'Test', email: 'x@example.test' }], methodId: 'draw' });
    assert.equal(response.status, 400, response.text);
  }
  const teamId = uid(), userId = uid();
  await f.db.query('INSERT INTO teams(id,name) VALUES($1,$2)', [teamId, 'Other team']);
  const hash = (await f.db.query('SELECT password_hash FROM users LIMIT 1')).rows[0].password_hash;
  await f.db.query("INSERT INTO users(id,team_id,name,email,password_hash,role,created_at) VALUES($1,$2,'Other','other@example.test',$3,'owner',$4)", [userId, teamId, hash, new Date().toISOString()]);
  const other = request.agent(f.app);
  assert.equal((await f.post('/api/login', { email: 'other@example.test', password }, other)).status, 200);
  assert.deepEqual((await other.get('/api/documents')).body.documents, []);
  for (const suffix of ['', '/pdf?version=original', '/pdf?version=uploaded', '/evidence']) assert.equal((await other.get('/api/documents/' + created.document.id + suffix)).status, 404);
  assert.equal((await f.post('/api/documents/' + created.document.id + '/cancel', {}, other)).status, 404);
  assert.equal((await f.post('/api/documents/' + created.document.id + '/recipients/' + created.document.recipients[0].id + '/link', {}, other)).status, 404);
  await assert.rejects(f.db.query("UPDATE documents SET title='changed' WHERE id=$1", [created.document.id]), /immutable/);
  await assert.rejects(f.db.query("UPDATE events SET type='changed' WHERE document_id=$1", [created.document.id]), /append-only/);
  await assert.rejects(f.db.query('DELETE FROM events WHERE document_id=$1', [created.document.id]), /append-only/);
});

test('signatures bind source, exact consent and claimed name; completion is atomic and portable evidence verifies', async t => {
  const f = await fixture(t);
  const { document, original, tokens } = await createDocument(f, ['Assigned One', 'Assigned Two']);
  const publicClient = request(f.app);
  const session = await f.post('/api/sign/session', { token: tokens[0] }, publicClient);
  assert.equal(session.status, 200);
  assert.equal(session.body.consent.text, CONSENT.text);
  assert.equal(session.body.document.events.length, 0);
  for (const recipient of session.body.document.recipients) { assert.equal(recipient.email, undefined); assert.equal(recipient.ip, undefined); assert.equal(recipient.userAgent, undefined); }
  const input = completeBody(document, tokens[0], 'Claimed Åsa');
  assert.equal((await f.post('/api/sign/complete', { ...input, documentHash: 'f'.repeat(64) }, publicClient)).status, 409);
  assert.equal((await f.post('/api/sign/complete', { ...input, accepted: false }, publicClient)).status, 400);
  assert.equal((await f.post('/api/sign/complete', { ...input, consentVersion: 'old-consent' }, publicClient)).status, 400);
  assert.equal((await f.post('/api/sign/complete', { ...input, payload: { strokes: [] } }, publicClient)).status, 400);
  assert.equal((await f.post('/api/sign/complete', { ...input, payload: { strokes: [[[0, 0], [1.1, 1]]] } }, publicClient)).status, 400);
  const first = await f.post('/api/sign/complete', input, publicClient);
  assert.equal(first.status, 200); assert.equal(first.body.document.status, 'pending');
  assert.equal((await f.post('/api/sign/download', { token: tokens[0] }, publicClient)).status, 409);
  const finalInput = completeBody(document, tokens[1], 'Claimed Björn');
  const duplicate = await Promise.all([f.post('/api/sign/complete', finalInput, publicClient), f.post('/api/sign/complete', finalInput, publicClient)]);
  assert.deepEqual(duplicate.map(response => response.status), [200, 200]);
  assert.ok(duplicate.every(response => response.body.document.status === 'completed'));
  assert.equal((await f.post('/api/sign/complete', { ...finalInput, name: 'Someone else' }, publicClient)).status, 409);
  const final = await f.post('/api/sign/download', { token: tokens[0] }, publicClient).buffer(true).parse(binary);
  assert.equal(final.status, 200);
  const pdf = await PDFDocument.load(final.body);
  assert.equal(pdf.getPageCount(), 3);
  const evidence = await f.agent.get('/api/documents/' + document.id + '/evidence');
  const manifest = evidence.body;
  assert.equal(manifest.document.originalHash, sha256(original));
  assert.equal(manifest.document.completedHash, sha256(final.body));
  assert.equal(manifest.events.filter((event: any) => event.type === 'recipient.signed').length, 2);
  assert.equal(manifest.events.filter((event: any) => event.type === 'document.completed').length, 1);
  const signed = manifest.events.find((event: any) => event.type === 'recipient.signed');
  assert.equal(signed.data.assignedName, 'Assigned One');
  assert.equal(signed.data.claimedName, 'Claimed Åsa');
  assert.equal(signed.data.email, 'signer0@example.test');
  assert.deepEqual(signed.data.consent, CONSENT);
  assert.equal(verifyEvidence(manifest, original, final.body).signatures, 2);
  const tampered = structuredClone(manifest); tampered.document.recipients[0].email = 'changed@example.test';
  assert.throws(() => verifyEvidence(tampered, original, final.body));
  const alteredEvent = structuredClone(manifest); alteredEvent.events[1].data.originalHash = '0'.repeat(64);
  assert.throws(() => verifyEvidence(alteredEvent, original, final.body));
  assert.equal((await f.post('/api/verify', { sha256: document.originalHash }, publicClient)).body.match, false);
  assert.deepEqual((await f.post('/api/verify', { sha256: sha256(final.body) }, publicClient)).body, { match: true, status: 'completed', version: 'completed' });
  assert.deepEqual((await f.post('/api/verify', { sha256: 'a'.repeat(64) }, publicClient)).body, { match: false });
  const listed = (await f.agent.get('/api/documents')).body.documents[0];
  assert.deepEqual(listed.events, []);
  assert.equal(listed.recipients[0].signature, undefined);
  assert.equal(listed.recipients[0].ip, undefined);
  // Recompute the chain independently of the operational verifier.
  let previousHash = '0'.repeat(64);
  for (const event of manifest.events) {
    assert.equal(event.previousHash, previousHash);
    assert.equal(event.hash, sha256(canonical({ documentId: document.id, sequence: event.sequence, type: event.type, at: event.at, data: event.data, previousHash })));
    previousHash = event.hash;
  }
});

test('rotating or expiring a signing token removes access, and cancellation is final', async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock });
  const { document, tokens } = await createDocument(f);
  const recipientId = document.recipients[0].id;
  const row = (await f.db.query('SELECT token_hash FROM recipients WHERE id=$1', [recipientId])).rows[0];
  assert.equal(row.token_hash, sha256(tokens[0])); assert.notEqual(row.token_hash, tokens[0]);
  clock += 7 * 86400000 + 1;
  assert.equal((await f.post('/api/sign/session', { token: tokens[0] }, request(f.app))).status, 404);
  // The owner obtains a fresh session after the deliberately advanced clock.
  assert.equal((await f.post('/api/login', { email: owner.email, password })).status, 200);
  const rotated = await f.post('/api/documents/' + document.id + '/recipients/' + recipientId + '/link', {});
  assert.equal(rotated.status, 200);
  const fresh = new URL(rotated.body.url).hash.slice(1);
  assert.equal((await f.post('/api/sign/session', { token: tokens[0] }, request(f.app))).status, 404);
  assert.equal((await f.post('/api/sign/session', { token: fresh }, request(f.app))).status, 200);
  assert.equal((await f.post('/api/documents/' + document.id + '/cancel', {})).status, 200);
  assert.equal((await f.post('/api/sign/complete', completeBody(document, fresh), request(f.app))).status, 410);
  assert.equal((await f.post('/api/sign/pdf', { token: fresh }, request(f.app))).status, 410);
  assert.equal((await f.post('/api/documents/' + document.id + '/cancel', {})).status, 409);
});

test('team invitations are one-use, replacement revokes old invitations, and members cannot administer the team', async t => {
  const f = await fixture(t);
  const first = await f.post('/api/team/invitations', { email: 'member@example.test' });
  const second = await f.post('/api/team/invitations', { email: 'member@example.test' });
  assert.equal(second.status, 201);
  assert.equal(new URL(second.body.url).pathname, '/join');
  const firstToken = new URL(first.body.url).hash.slice(1), secondToken = new URL(second.body.url).hash.slice(1);
  const member = request.agent(f.app);
  assert.equal((await f.post('/api/invitations/accept', { token: firstToken, name: 'Member', password }, member)).status, 404);
  const accepted = await f.post('/api/invitations/accept', { token: secondToken, name: 'Member', password }, member);
  assert.equal(accepted.status, 201); assert.equal(accepted.body.user.role, 'member');
  assert.equal((await f.post('/api/invitations/accept', { token: secondToken, name: 'Member', password }, member)).status, 404);
  assert.equal((await f.post('/api/team/invitations', { email: 'other@example.test' }, member)).status, 403);
  assert.equal((await member.patch('/api/team').set('Origin', origin).send({ name: 'Takeover' })).status, 403);
  const created = await createDocument(f);
  assert.equal((await member.get('/api/documents/' + created.document.id)).status, 200);
});

test('PDF finalization failure rolls back the signature and audit, and a retry can complete', async t => {
  let fail = true;
  const f = await fixture(t, { pdfFinalizer: async (...args) => { if (fail) throw new Error('simulated worker failure'); return finalizePdf(...args); } });
  const { document, tokens } = await createDocument(f);
  const input = completeBody(document, tokens[0]);
  assert.equal((await f.post('/api/sign/complete', input, request(f.app))).status, 503);
  const row = (await f.db.query('SELECT status,completed,completed_hash FROM documents WHERE id=$1', [document.id])).rows[0];
  assert.equal(row.status, 'pending'); assert.equal(row.completed, null); assert.equal(row.completed_hash, null);
  assert.equal((await f.db.query('SELECT signed_at FROM recipients WHERE document_id=$1', [document.id])).rows[0].signed_at, null);
  assert.equal((await f.db.query("SELECT count(*) AS count FROM events WHERE document_id=$1 AND type='recipient.signed'", [document.id])).rows[0].count, '0');
  fail = false;
  assert.equal((await f.post('/api/sign/complete', input, request(f.app))).status, 200);
});

test('a concurrent cancellation waits for finalization and cannot cancel a completed document', async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { pdfFinalizer: async (...args) => { entered(); await gate; return finalizePdf(...args); } });
  const { document, tokens } = await createDocument(f);
  const signing = f.post('/api/sign/complete', completeBody(document, tokens[0]), request(f.app)).then((result: any) => result);
  await started;
  const cancelling = f.post('/api/documents/' + document.id + '/cancel', {}).then((result: any) => result);
  release();
  const [signed, cancelled] = await Promise.all([signing, cancelling]);
  assert.equal(signed.status, 200); assert.equal(cancelled.status, 409);
  const detail = await f.agent.get('/api/documents/' + document.id);
  assert.equal(detail.body.document.status, 'completed');
  assert.equal(detail.body.document.events.filter((event: any) => event.type === 'document.cancelled').length, 0);
});


test('audit JSON normalization, structural insert guards and artifact deletion guards hold in PostgreSQL', async t => {
  const f = await fixture(t);
  const { document } = await createDocument(f);
  const { appendEvent, transaction } = await import('./db.js');
  const eventTime = '2026-09-23T12:00:00.000Z';
  await transaction(f.db, async client => {
    await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [document.id]);
    await appendEvent(client, document.id, 'recipient.viewed', eventTime, { timestamp: new Date(eventTime), optional: undefined, list: [undefined, 3] });
  });
  const normalized = (await f.db.query('SELECT * FROM events WHERE document_id=$1 AND sequence=2', [document.id])).rows[0];
  assert.deepEqual(normalized.data, { timestamp: eventTime, list: [null, 3] });
  assert.equal(normalized.hash, sha256(canonical({ documentId: document.id, sequence: 2, type: normalized.type, at: normalized.at, data: normalized.data, previousHash: normalized.previous_hash })));
  await assert.rejects(f.db.query("INSERT INTO events(document_id,sequence,type,at,data,previous_hash,hash) VALUES($1,5,'recipient.viewed',$2,'{}',$3,$4)", [document.id, eventTime, normalized.hash, 'f'.repeat(64)]), /sequence/);
  await assert.rejects(f.db.query('DELETE FROM recipients WHERE document_id=$1', [document.id]), /append-only/);
  await assert.rejects(f.db.query('DELETE FROM documents WHERE id=$1', [document.id]), /append-only/);
  for (const table of ['events', 'recipients', 'documents']) await assert.rejects(f.db.query('TRUNCATE ' + table + ' CASCADE'), /append-only/);
  assert.equal((await f.post('/api/documents/' + document.id + '/cancel', {})).status, 200);
  await assert.rejects(transaction(f.db, client => appendEvent(client, document.id, 'recipient.viewed', eventTime, {})), /Closed audit/);
});

test('different recipients signing concurrently cannot lose a signature or finalize twice', async t => {
  const f = await fixture(t);
  const { document, tokens } = await createDocument(f, ['One', 'Two']);
  const responses = await Promise.all(tokens.map((raw: string, index: number) => f.post('/api/sign/complete', completeBody(document, raw, 'Claimed ' + index), request(f.app))));
  assert.ok(responses.every(response => response.status === 200), responses.map(response => response.text).join('\n'));
  assert.deepEqual(responses.map(response => response.body.document.status).sort(), ['completed', 'pending']);
  const events = (await f.db.query('SELECT type FROM events WHERE document_id=$1', [document.id])).rows;
  assert.equal(events.filter(row => row.type === 'recipient.signed').length, 2);
  assert.equal(events.filter(row => row.type === 'document.completed').length, 1);
  const recipients = (await f.db.query('SELECT signed_at,expires_at FROM recipients WHERE document_id=$1', [document.id])).rows;
  assert.ok(recipients.every(row => Number(row.expires_at) >= Date.parse(row.signed_at) + 29 * 86400000));
});

test('automatic owner token stays private, is removed after setup, and HTTPS cookies are secure', async t => {
  const { readFile, access } = await import('node:fs/promises');
  const f = await fixture(t, { setupToken: undefined, baseUrl: 'https://sign.example.test' }, false);
  const raw = (await readFile(join(f.dataDir, 'setup-token'), 'utf8')).trim();
  assert.equal(raw.length, 43);
  const bootstrap = await request(f.app).get('/api/bootstrap');
  assert.ok(!bootstrap.text.includes(raw));
  const setup = await request(f.app).post('/api/setup').set('Origin', 'https://sign.example.test').send({ ...owner, setupToken: raw });
  assert.equal(setup.status, 201);
  assert.match(setup.headers['set-cookie'][0], /Secure/);
  await assert.rejects(access(join(f.dataDir, 'setup-token')));
  const sessionCookie = setup.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(f.app).get('/api/bootstrap').set('Cookie', sessionCookie)).body.user.email, owner.email);
  assert.equal((await request(f.app).post('/api/logout').set('Origin', origin).set('Cookie', sessionCookie).send({})).status, 403);
});



test('automatic flattening needs no preview acknowledgement and retains verifiable source evidence', async t => {
  const f = await fixture(t);
  const source = await PDFDocument.create(); const page = source.addPage();
  page.drawText('A readable contract with a normal link');
  page.node.set(PDFName.of('Annots'), source.context.obj([source.context.register(source.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [40, 40, 200, 60], Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of('https://example.com') },
  }))]));
  const uploaded = Buffer.from(await source.save());
  const input = { title: 'Prepared contract', fileName: 'contract.pdf', pdfBase64: uploaded.toString('base64'), methodId: 'draw', recipients: [{ name: 'Signer One', email: 'one@example.test' }] };
  assert.equal((await f.post('/api/documents/prepare', { pdfBase64: input.pdfBase64 }, request(f.app))).status, 401);
  assert.equal((await f.agent.post('/api/documents/prepare').set('Origin', 'https://evil.test').send({ pdfBase64: input.pdfBase64 })).status, 403);
  const preview = await f.post('/api/documents/prepare', { pdfBase64: input.pdfBase64 });
  assert.equal(preview.status, 200, preview.text);
  const original = Buffer.from(preview.body.pdfBase64, 'base64');
  assert.equal(preview.body.hash, sha256(original));
  assert.notEqual(preview.body.hash, sha256(uploaded));
  assert.equal(preview.body.preparation.sourceHash, sha256(uploaded));
  assert.equal(preview.body.preparation.annotationCount, 1);
  assert.equal((await f.db.query('SELECT count(*) FROM documents')).rows[0].count, '0');
  const created = await f.post('/api/documents', input);
  assert.equal(created.status, 201, created.text);
  const { document, links } = created.body;
  // An older browser tab can carry a preview marker from a previous build.
  // It must still send normally: the server prepares and freezes its own bytes.
  const olderClient = await f.post('/api/documents', { ...input, preparedHash: sha256(uploaded) });
  assert.equal(olderClient.status, 201, olderClient.text);
  assert.equal(olderClient.body.document.originalHash, document.originalHash);
  assert.deepEqual(document.preparation, preview.body.preparation);
  const storedSource = await f.agent.get(`/api/documents/${document.id}/pdf?version=uploaded`).buffer(true).parse(binary);
  const storedOriginal = await f.agent.get(`/api/documents/${document.id}/pdf?version=original`).buffer(true).parse(binary);
  assert.deepEqual(storedSource.body, uploaded); assert.deepEqual(storedOriginal.body, original);
  const preparedPdf = await PDFDocument.load(storedOriginal.body);
  assert.ok(!preparedPdf.getPage(0).node.Annots()?.size());
  await assert.rejects(f.db.query('UPDATE documents SET uploaded=$1 WHERE id=$2', [original, document.id]), /immutable/);
  await assert.rejects(f.db.query("UPDATE documents SET preparation=preparation || '{\"sourceHash\":\"changed\"}'::jsonb WHERE id=$1", [document.id]), /immutable/);
  const raw = new URL(links[0].url).hash.slice(1);
  const signer = request(f.app);
  const signBody = completeBody(document, raw);
  assert.equal((await f.post('/api/sign/complete', { ...signBody, documentHash: sha256(uploaded) }, signer)).status, 409);
  assert.equal((await f.post('/api/sign/complete', signBody, signer)).status, 200);
  const completed = await f.post('/api/sign/download', { token: raw }, signer).buffer(true).parse(binary);
  const manifest = (await f.agent.get(`/api/documents/${document.id}/evidence`)).body;
  assert.equal(verifyEvidence(manifest, original, completed.body, uploaded).uploadedSourceVerified, true);
  assert.equal(verifyEvidence(manifest, original, completed.body).uploadedSourceVerified, false);
  assert.throws(() => verifyEvidence(manifest, original, completed.body, original), /Uploaded PDF hash/);
  const tampered = structuredClone(manifest); tampered.document.preparation.sourceHash = '0'.repeat(64);
  assert.throws(() => verifyEvidence(tampered, original, completed.body, uploaded), /Conversion metadata/);
});


test('schema 3 upgrades existing signed documents without rewriting artifacts or audit history', async t => {
  const f = await fixture(t);
  const { document, tokens } = await createDocument(f);
  assert.equal((await f.post('/api/sign/complete', completeBody(document, tokens[0]), request(f.app))).status, 200);
  const before = (await f.db.query('SELECT original,completed,original_hash,completed_hash,status FROM documents WHERE id=$1', [document.id])).rows[0];
  const events = (await f.db.query('SELECT * FROM events WHERE document_id=$1 ORDER BY sequence', [document.id])).rows;
  const schema = (await f.db.query('SELECT current_schema() AS schema')).rows[0].schema;
  // Reconstruct the prior schema in this disposable test database only.
  await f.db.query(`
    DROP TABLE email_deliveries; DROP FUNCTION guard_email_delivery();
    DROP TRIGGER documents_attachment ON documents; DROP FUNCTION guard_attachment();
    DROP TRIGGER recipients_parent_valid ON recipients; DROP FUNCTION guard_recipient_parent();
    ALTER TABLE recipients DROP COLUMN parent_recipient_id;
    ALTER TABLE documents DROP COLUMN parent_id, DROP COLUMN attachment_number;
    DROP TABLE completed_copy_access,finalization_attempts,finalization_jobs,sealing_key_events,sealing_certificates,sealing_identity;
    DROP FUNCTION guard_completed_copy_access(),guard_finalization_attempt();
    ALTER TABLE recipients DROP CONSTRAINT recipients_id_document_unique;
    ALTER TABLE recipients DROP COLUMN signing_intent;
    ALTER TABLE documents DROP COLUMN uploaded, DROP COLUMN preparation,
      DROP COLUMN evidence_version, DROP COLUMN evidence_core, DROP COLUMN protection_policy, DROP COLUMN seal_metadata;
    ALTER TABLE documents DROP CONSTRAINT documents_status_check;
    ALTER TABLE documents ADD CONSTRAINT documents_status_check CHECK(status IN ('pending','completed','cancelled'));
    DELETE FROM migrations WHERE version>=2;
  `);
  const { createDatabase } = await import('./db.js');
  const upgraded = await createDatabase(databaseUrl!, schema);
  try {
    assert.deepEqual((await upgraded.query('SELECT original,completed,original_hash,completed_hash,status FROM documents WHERE id=$1', [document.id])).rows[0], before);
    assert.deepEqual((await upgraded.query('SELECT * FROM events WHERE document_id=$1 ORDER BY sequence', [document.id])).rows, events);
    assert.deepEqual((await upgraded.query('SELECT uploaded,preparation FROM documents WHERE id=$1', [document.id])).rows[0], { uploaded: null, preparation: null });
    assert.equal((await upgraded.query('SELECT max(version) AS version FROM migrations')).rows[0].version, 5);
    const constraint = (await upgraded.query("SELECT oid FROM pg_constraint WHERE conrelid='documents'::regclass AND conname='documents_preparation_pair'")).rows[0].oid;
    const reopened = await createDatabase(databaseUrl!, schema);
    try {
      assert.equal((await reopened.query("SELECT oid FROM pg_constraint WHERE conrelid='documents'::regclass AND conname='documents_preparation_pair'")).rows[0].oid, constraint);
      await assert.rejects(reopened.query('UPDATE documents SET original=$1 WHERE id=$2', [Buffer.from('changed'), document.id]), /immutable/);
    } finally { await reopened.end(); }
  } finally { await upgraded.end(); }
});


test('including the sender creates an unsigned required recipient and supports signing alone', async t => {
  const f = await fixture(t);
  const original = await pdfBytes();
  const response = await f.post('/api/documents', {
    title: 'Sender only', fileName: 'sender.pdf', pdfBase64: original.toString('base64'),
    methodId: 'draw', recipients: [], includeSender: true,
  });
  assert.equal(response.status, 201, response.text);
  const { document, links, senderRecipientId } = response.body;
  assert.equal(document.status, 'pending');
  assert.equal(document.completedHash, null);
  assert.equal(document.recipients.length, 1);
  assert.equal(document.recipients[0].id, senderRecipientId);
  assert.equal(document.senderRecipientId, senderRecipientId);
  assert.equal(document.events[0].data.senderRecipientId, senderRecipientId);
  assert.equal(document.recipients[0].name, owner.name);
  assert.equal(document.recipients[0].email, owner.email);
  assert.equal(document.recipients[0].signedAt, null);
  assert.equal(document.recipients[0].signature, undefined);
  assert.equal(links[0].recipientId, senderRecipientId);
  assert.deepEqual(document.events.map((event: any) => event.type), ['document.created']);
  assert.deepEqual(document.events[0].data.recipients, [{ id: senderRecipientId, position: 0, name: owner.name, email: owner.email }]);
  const raw = new URL(links[0].url).hash.slice(1);
  const signature = completeBody(document, raw, owner.name);
  // Creating or merely opening a document never stands in for signature consent.
  assert.equal((await f.post('/api/sign/session', { token: raw })).status, 200);
  assert.equal((await f.post('/api/sign/complete', { ...signature, accepted: false })).status, 400);
  assert.equal((await f.post('/api/sign/complete', { ...signature, payload: { strokes: [] } })).status, 400);
  const pending = (await f.agent.get('/api/documents/' + document.id)).body.document;
  assert.equal(pending.recipients[0].signedAt, null);
  assert.equal(pending.status, 'pending');
  const signed = await f.post('/api/sign/complete', signature);
  assert.equal(signed.status, 200, signed.text);
  assert.equal(signed.body.document.status, 'completed');
  assert.ok(signed.body.document.recipients[0].signedAt);
});

test('other recipients cannot complete the document before the included sender explicitly signs', async t => {
  const f = await fixture(t);
  const response = await f.post('/api/documents', {
    title: 'Sender and recipient', fileName: 'contract.pdf', pdfBase64: (await pdfBytes()).toString('base64'),
    methodId: 'draw', recipients: [{ name: 'Other signer', email: 'other@example.test' }], includeSender: true,
  });
  assert.equal(response.status, 201, response.text);
  const { document, links, senderRecipientId } = response.body;
  assert.equal(document.recipients.length, 2);
  const senderLink = links.find((link: any) => link.recipientId === senderRecipientId);
  const otherLink = links.find((link: any) => link.recipientId !== senderRecipientId);
  const otherToken = new URL(otherLink.url).hash.slice(1);
  const senderToken = new URL(senderLink.url).hash.slice(1);
  const publicClient = request(f.app);
  const first = await f.post('/api/sign/complete', completeBody(document, otherToken, 'Other signer'), publicClient);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.document.status, 'pending');
  assert.equal(first.body.document.completedHash, null);
  assert.equal(first.body.document.recipients.find((recipient: any) => recipient.id === senderRecipientId).signedAt, null);
  assert.equal((await f.post('/api/sign/download', { token: otherToken }, publicClient)).status, 409);
  assert.equal((await f.agent.get('/api/documents/' + document.id + '/pdf?version=completed')).status, 409);
  const before = (await f.agent.get('/api/documents/' + document.id + '/evidence')).body;
  assert.equal(before.events.filter((event: any) => event.type === 'recipient.signed').length, 1);
  assert.ok(before.events.every((event: any) => event.type !== 'document.completed'));
  const last = await f.post('/api/sign/complete', completeBody(document, senderToken, owner.name));
  assert.equal(last.status, 200, last.text);
  assert.equal(last.body.document.status, 'completed');
  assert.ok(last.body.document.recipients.every((recipient: any) => recipient.signedAt));
  const after = (await f.agent.get('/api/documents/' + document.id + '/evidence')).body;
  assert.equal(after.events.filter((event: any) => event.type === 'recipient.signed').length, 2);
  assert.equal(after.events.filter((event: any) => event.type === 'document.completed').length, 1);
  assert.equal(after.events.find((event: any) => event.type === 'recipient.signed' && event.data.recipientId === senderRecipientId).data.email, owner.email);
});

test('including the sender preserves a party with the same email and records two independent signatures', async t => {
  const f = await fixture(t);
  const original = await pdfBytes();
  const response = await f.post('/api/documents', {
    title: 'Shared mailbox', fileName: 'contract.pdf', pdfBase64: original.toString('base64'),
    methodId: 'draw', recipients: [{ name: 'Other signing party', email: owner.email.toUpperCase() }], includeSender: true,
  });
  assert.equal(response.status, 201, response.text);
  const { document, links, senderRecipientId } = response.body;
  const [party, sender] = document.recipients;
  assert.equal(document.originalHash, sha256(original));
  assert.equal(document.recipients.length, 2);
  assert.equal(party.name, 'Other signing party');
  assert.equal(party.email, owner.email);
  assert.equal(sender.name, owner.name);
  assert.equal(sender.email, owner.email);
  assert.notEqual(sender.id, party.id);
  assert.equal(senderRecipientId, sender.id);
  assert.equal(document.senderRecipientId, sender.id);
  assert.equal(document.events[0].data.senderRecipientId, sender.id);
  assert.equal(links.length, 2);
  assert.notEqual(links[0].url, links[1].url);
  const senderToken = new URL(links[1].url).hash.slice(1);
  const partyToken = new URL(links[0].url).hash.slice(1);
  const publicClient = request(f.app);
  const session = await f.post('/api/sign/session', { token: senderToken }, publicClient);
  assert.equal(session.body.document.senderRecipientId, sender.id);
  const senderSigned = await f.post('/api/sign/complete', completeBody(document, senderToken, owner.name), publicClient);
  assert.equal(senderSigned.status, 200, senderSigned.text);
  assert.equal(senderSigned.body.document.status, 'pending');
  assert.equal(senderSigned.body.document.completedHash, null);
  assert.equal(senderSigned.body.document.recipients[0].signedAt, null);
  assert.ok(senderSigned.body.document.recipients[1].signedAt);
  assert.equal((await f.post('/api/sign/download', { token: senderToken }, publicClient)).status, 409);
  const partyInput = { ...completeBody(document, partyToken, party.name), payload: { strokes: [[[0.1, 0.7], [0.4, 0.1], [0.8, 0.6]]] } };
  const partySigned = await f.post('/api/sign/complete', partyInput, publicClient);
  assert.equal(partySigned.status, 200, partySigned.text);
  assert.equal(partySigned.body.document.status, 'completed');
  const completed = await f.post('/api/sign/download', { token: partyToken }, publicClient).buffer(true).parse(binary);
  assert.equal(completed.status, 200);
  assert.equal((await PDFDocument.load(completed.body)).getPageCount(), 3);
  const manifest = (await f.agent.get('/api/documents/' + document.id + '/evidence')).body;
  const signedEvents = manifest.events.filter((event: any) => event.type === 'recipient.signed');
  assert.deepEqual(signedEvents.map((event: any) => event.data.recipientId), [sender.id, party.id]);
  assert.ok(signedEvents.every((event: any) => event.data.originalHash === sha256(original)));
  assert.notDeepEqual(signedEvents[0].data.signature, signedEvents[1].data.signature);
  assert.equal(verifyEvidence(manifest, original, completed.body).signatures, 2);
  const wrongSender = structuredClone(manifest);
  wrongSender.document.senderRecipientId = party.id;
  assert.throws(() => verifyEvidence(wrongSender, original, completed.body), /Sender signature assignment/);
  const wrongAssignment = structuredClone(manifest);
  wrongAssignment.document.senderRecipientId = party.id;
  wrongAssignment.events[0].data.senderRecipientId = party.id;
  assert.throws(() => verifyEvidence(wrongAssignment, original, completed.body), /sender identity/);
  const missingSender = structuredClone(manifest);
  delete missingSender.document.senderRecipientId;
  assert.throws(() => verifyEvidence(missingSender, original, completed.body), /Sender signature assignment/);
  const listed = (await f.agent.get('/api/documents')).body.documents[0];
  assert.equal(listed.senderRecipientId, sender.id);
  assert.deepEqual(listed.events, []);
});

test('sender designation is explicit even when an entered party has the sender name and email', async t => {
  const f = await fixture(t);
  const input = {
    title: 'Explicit sender assignment', fileName: 'sender.pdf', pdfBase64: (await pdfBytes()).toString('base64'),
    methodId: 'draw', recipients: [{ name: owner.name, email: owner.email.toUpperCase() }],
  };
  for (const includeSender of [false, true]) {
    const response = await f.post('/api/documents', { ...input, includeSender });
    assert.equal(response.status, 201, response.text);
    const { document, senderRecipientId, links } = response.body;
    assert.equal(document.recipients.length, includeSender ? 2 : 1);
    assert.equal(links.length, includeSender ? 2 : 1);
    assert.equal(senderRecipientId, includeSender ? document.recipients[1].id : null);
    assert.equal(document.senderRecipientId, senderRecipientId);
    assert.equal(document.events[0].data.senderRecipientId, senderRecipientId);
  }
  const withoutSender = await f.post('/api/documents', input);
  assert.equal(withoutSender.status, 201, withoutSender.text);
  assert.equal(withoutSender.body.senderRecipientId, null);
  assert.equal(withoutSender.body.document.senderRecipientId, null);
});

test('legacy evidence remains verifiable and legacy sender inference requires an unambiguous name and email match', async t => {
  const f = await fixture(t);
  const { appendEvent, transaction } = await import('./db.js');
  const user = (await f.db.query('SELECT * FROM users WHERE email=$1', [owner.email])).rows[0];
  const original = await pdfBytes();
  const sender = { name: owner.name, email: owner.email, teamName: owner.teamName };
  const cases = [[owner.name], ['Different party'], [owner.name, owner.name]];
  for (const [caseIndex, names] of cases.entries()) {
    const documentId = uid(), createdAt = new Date().toISOString();
    const assigned = names.map((name, position) => ({ id: uid(), position, name, email: owner.email }));
    const tokens = assigned.map((_, index) => 'L'.repeat(41) + caseIndex + index);
    // Construct historical fixtures directly, without changing any audit event.
    await transaction(f.db, async client => {
      await client.query("INSERT INTO documents(id,team_id,created_by,title,file_name,original,original_hash,size,pages,status,sender,method_id,method_version,created_at) VALUES($1,$2,$3,'Legacy','legacy.pdf',$4,$5,$6,1,'pending',$7,'draw','1.0.0',$8)",
        [documentId, user.team_id, user.id, original, sha256(original), original.length, sender, createdAt]);
      for (const recipient of assigned) {
        await client.query("INSERT INTO recipients(id,document_id,position,name,email,method_id,method_version,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,'draw','1.0.0',$6,$7)",
          [recipient.id, documentId, recipient.position, recipient.name, recipient.email, sha256(tokens[recipient.position]), Date.now() + 86400000]);
      }
      await appendEvent(client, documentId, 'document.created', createdAt, { originalHash: sha256(original), fileName: 'legacy.pdf', pages: 1, size: original.length, title: 'Legacy', sender, recipients: assigned, recipientIds: assigned.map(recipient => recipient.id), method: { id: 'draw', version: '1.0.0' }, actorId: user.id });
    });
    const document = (await f.agent.get('/api/documents/' + documentId)).body.document;
    assert.equal(document.senderRecipientId, caseIndex === 0 ? assigned[0].id : null);
    assert.equal(Object.hasOwn(document.events[0].data, 'senderRecipientId'), false);
    const publicSession = await f.post('/api/sign/session', { token: tokens[0] }, request(f.app));
    assert.equal(publicSession.body.document.senderRecipientId, document.senderRecipientId);
    if (caseIndex === 0) {
      assert.equal((await f.post('/api/sign/complete', completeBody(document, tokens[0], owner.name))).status, 200);
      const completed = await f.post('/api/sign/download', { token: tokens[0] }).buffer(true).parse(binary);
      const manifest = (await f.agent.get('/api/documents/' + documentId + '/evidence')).body;
      assert.equal(verifyEvidence(manifest, original, completed.body).signatures, 1);
      delete manifest.document.senderRecipientId;
      assert.equal(verifyEvidence(manifest, original, completed.body).signatures, 1);
    }
  }
});

test('sender inclusion validates recipients, limits and the authenticated sender identity', async t => {
  const f = await fixture(t);
  const input = {
    title: 'Recipient validation', fileName: 'contract.pdf', pdfBase64: (await pdfBytes()).toString('base64'),
    methodId: 'draw', recipients: [],
  };
  assert.equal((await f.post('/api/documents', { ...input, includeSender: true }, request(f.app))).status, 401);
  for (const body of [
    input,
    { ...input, includeSender: false },
    { ...input, includeSender: 'true' },
    { ...input, includeSender: true, sender: { name: 'Other', email: 'other@example.test' } },
    { ...input, includeSender: true, recipients: [{ name: 'One', email: owner.email }, { name: 'Duplicate', email: owner.email.toUpperCase() }] },
    { ...input, includeSender: true, recipients: Array.from({ length: 25 }, (_, index) => ({ name: 'Signer ' + index, email: 'signer' + index + '@example.test' })) },
  ]) {
    const response = await f.post('/api/documents', body);
    assert.equal(response.status, 400, response.text);
  }
  const invalidEmail = await f.post('/api/documents', { ...input, includeSender: false, recipients: [{ name: 'One', email: 'a@b@c.example' }] });
  assert.deepEqual([invalidEmail.status, invalidEmail.body.error], [400, 'Ogiltig e-postadress.']);
  assert.equal((await f.db.query('SELECT count(*) FROM documents')).rows[0].count, '0');
  const permitted = await f.post('/api/documents', {
    ...input, includeSender: true,
    recipients: Array.from({ length: 24 }, (_, index) => ({ name: 'Signer ' + index, email: 'signer' + index + '@example.test' })),
  });
  assert.equal(permitted.status, 201, permitted.text);
  assert.equal(permitted.body.document.recipients.length, 25);
  assert.equal(permitted.body.document.recipients[24].email, owner.email);
});
