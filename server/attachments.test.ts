import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { createApp } from './app.js';
import { uid } from './db.js';
import { sha256 } from './pdf.js';
import { createNotifier, type Message } from './notify.js';
// @ts-expect-error standalone verifier distributed with exports
import { verifySealedEvidence } from '../scripts/verify-sealed-evidence.mjs';
try { loadEnvFile('.local/postgres.env'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Real PostgreSQL is required.');
const origin = 'http://localhost:3000';
const password = 'attachment-test-correct-horse';
const strokes = [[[0.1, 0.2], [0.35, 0.8], [0.7, 0.1], [0.9, 0.6]]];
const hash = (url: string) => new URL(url).hash.slice(1);
function binary(response: any, callback: any) { const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => callback(null, Buffer.concat(chunks))); }
async function pdf(text: string) { const document = await PDFDocument.create(); document.addPage().drawText(text); return Buffer.from(await document.save()); }

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-attachments-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  const mail: Message[] = [];
  const runtime = await createApp({ databaseUrl: databaseUrl!, dataDir, schema, baseUrl: origin, setupToken: 'attachment-test-setup-token-long-enough', rateLimit: false,
    finalization: { autoStart: false }, notifier: createNotifier({ deliver: async message => { mail.push(message); } }) });
  t.after(async () => { await runtime.finalization.stop(); await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = request.agent(runtime.app), outsider = request(runtime.app);
  const post = (path: string, body: unknown, client: any = owner) => client.post(path).set('Origin', origin).send(body);
  assert.equal((await post('/api/setup', { setupToken: 'attachment-test-setup-token-long-enough', name: 'Sara Sender', email: 'sara@example.test', password, teamName: 'Bilagor' })).status, 201);
  const settle = async () => { for (let i = 0; i < 20 && (await runtime.finalization.runOnce()).status !== 'idle'; i++); await new Promise(resolve => setTimeout(resolve, 50)); };
  async function sign(token: string, name: string, documentId?: string) {
    const session = await post('/api/sign/session', { token, ...(documentId ? { documentId } : {}) }, outsider);
    assert.equal(session.status, 200, session.text);
    const response = await post('/api/sign/complete', { token, ...(documentId ? { documentId } : {}), documentHash: session.body.document.originalHash, consentVersion: session.body.consent.version, signingIntentHash: session.body.signingIntentHash, accepted: true, name, payload: { strokes } }, outsider);
    assert.equal(response.status, 200, response.text);
    return response.body;
  }
  return { ...runtime, owner, outsider, post, mail, settle, sign };
}

test('a bilaga is signed by the main document parties, reachable from their links and sealed with its own evidence', async t => {
  const f = await fixture(t);
  const original = await pdf('Huvudavtal');
  const main = await f.post('/api/documents', { title: 'Huvudavtal', fileName: 'avtal.pdf', pdfBase64: original.toString('base64'), methodId: 'draw', includeSender: true,
    recipients: [{ name: 'Anna Andersson', email: 'anna@example.test' }, { name: 'Bo Berg', email: 'bo@example.test' }] });
  assert.equal(main.status, 201, main.text);
  assert.equal(main.body.notified, true);
  assert.deepEqual(f.mail.map(message => message.to), ['anna@example.test', 'bo@example.test'], 'Only parties are e-mailed; the sender signs in the app.');
  assert.ok(f.mail[0].text.includes(main.body.links[0].url));
  const [annaMain, boMain, saraMain] = main.body.links.map((link: any) => hash(link.url));
  const mainId = main.body.document.id;
  const [annaId, boId] = main.body.document.recipients.map((recipient: any) => recipient.id);
  const attachmentBody = async (overrides: object = {}) => ({ title: 'Prisbilaga', fileName: 'priser.pdf', pdfBase64: (await pdf('Priser 2027')).toString('base64'), methodId: 'draw',
    parentRecipientIds: main.body.document.recipients.map((recipient: any) => recipient.id), recipients: [], ...overrides });
  assert.equal((await f.post(`/api/documents/${mainId}/attachments`, await attachmentBody())).status, 409, 'A pending document cannot receive a bilaga.');

  await f.sign(annaMain, 'Anna Andersson'); await f.sign(boMain, 'Bo Berg'); await f.sign(saraMain, 'Sara Sender');
  await f.settle();
  assert.equal((await f.owner.get('/api/documents/' + mainId)).body.document.status, 'completed');
  const mainEvents = (await f.db.query('SELECT hash FROM events WHERE document_id=$1 ORDER BY sequence', [mainId])).rows;
  f.mail.length = 0;

  assert.equal((await f.post(`/api/documents/${mainId}/attachments`, await attachmentBody({ parentRecipientIds: [uid()] }))).status, 400);
  assert.equal((await f.post(`/api/documents/${mainId}/attachments`, await attachmentBody(), f.outsider)).status, 401);
  const created = await f.post(`/api/documents/${mainId}/attachments`, await attachmentBody());
  assert.equal(created.status, 201, created.text);
  const bilaga = created.body.document;
  const mainCompleted = (await f.owner.get('/api/documents/' + mainId)).body.document;
  assert.deepEqual(bilaga.attachmentOf, { documentId: mainId, title: 'Huvudavtal', completedHash: mainCompleted.completedHash, number: 1 });
  assert.equal(bilaga.recipients.length, 3);
  assert.deepEqual(bilaga.recipients.map((recipient: any) => recipient.parentRecipientId), main.body.document.recipients.map((recipient: any) => recipient.id));
  assert.equal(bilaga.senderRecipientId, bilaga.recipients[2].id, 'The signing sender keeps the sender assignment.');
  assert.deepEqual(f.mail.map(message => message.to), ['anna@example.test', 'bo@example.test']);
  assert.match(f.mail[0].subject, /^Bilaga 1 till Huvudavtal/);
  assert.ok(f.mail[0].text.includes(created.body.links[0].url));
  assert.deepEqual((await f.db.query('SELECT hash FROM events WHERE document_id=$1 ORDER BY sequence', [mainId])).rows, mainEvents, 'The closed main audit chain is untouched.');

  const list = (await f.owner.get('/api/documents')).body.documents;
  assert.deepEqual(list.map((document: any) => document.id), [mainId], 'Bilagor are listed on their main document.');
  assert.equal(list[0].attachmentCount, 1); assert.equal(list[0].openAttachmentCount, 1);
  const detail = (await f.owner.get('/api/documents/' + mainId)).body.document;
  assert.deepEqual(detail.attachments.map((attachment: any) => attachment.id), [bilaga.id]);

  // Anna returns through her original link: she sees the main document, the new bilaga and the combined trail.
  const dossier = await f.post('/api/sign/dossier', { token: annaMain }, f.outsider);
  assert.equal(dossier.status, 200, dossier.text);
  assert.deepEqual(dossier.body.documents.map((document: any) => document.id), [mainId, bilaga.id]);
  assert.equal(dossier.body.documents[1].partyRecipientId, bilaga.recipients[0].id);
  assert.ok(dossier.body.documents[1].events.some((event: any) => event.type === 'document.created' && event.actor === 'Sara Sender'));
  assert.doesNotMatch(JSON.stringify(dossier.body), /anna@|bo@|userAgent|"ip"/, 'Parties do not see other parties\' addresses, IPs or devices.');
  const annaSigned = await f.sign(annaMain, 'Anna Andersson', bilaga.id);
  assert.equal(annaSigned.recipientId, bilaga.recipients[0].id);
  const annaEvidence = (await f.db.query('SELECT evidence FROM recipients WHERE id=$1', [bilaga.recipients[0].id])).rows[0].evidence;
  assert.equal(annaEvidence.accessRecipientId, annaId); assert.equal(annaEvidence.accessDocumentId, mainId);
  const viewedOnce = (await f.post('/api/sign/dossier', { token: annaMain }, f.outsider)).body.documents[1].events.filter((event: any) => event.type === 'recipient.viewed');
  assert.deepEqual(viewedOnce.map((event: any) => event.actor), ['Anna Andersson']);

  // Bo and Sara use the bilaga's own links.
  const [, boBilaga, saraBilaga] = created.body.links.map((link: any) => hash(link.url));
  assert.deepEqual((await f.post('/api/sign/dossier', { token: boBilaga }, f.outsider)).body.documents.map((document: any) => document.id), [mainId, bilaga.id]);
  await f.sign(boBilaga, 'Bo Berg');
  f.mail.length = 0;
  const last = await f.sign(saraBilaga, 'Sara Sender');
  assert.equal(last.document.status, 'finalizing');
  await f.settle();
  const completed = (await f.owner.get('/api/documents/' + bilaga.id)).body.document;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(f.mail.map(message => message.to).sort(), ['anna@example.test', 'bo@example.test', 'sara@example.test']);
  const copyMail = f.mail.find(message => message.to === 'bo@example.test')!;
  const copyToken = hash(copyMail.text.match(/http:\/\/localhost:3000\/copy#\S+/)![0]);

  // The receipt link from the e-mail reaches the main document and bilaga, read-only.
  const copyDossier = await f.post('/api/sign/dossier', { token: copyToken }, f.outsider);
  assert.deepEqual(copyDossier.body.documents.map((document: any) => document.status), ['completed', 'completed']);
  const mainPdf = await f.outsider.post('/api/sign/download').set('Origin', origin).send({ token: copyToken, documentId: mainId }).buffer(true).parse(binary);
  assert.equal(mainPdf.status, 200); assert.equal(sha256(mainPdf.body), mainCompleted.completedHash);
  const bilagaPdf = await f.outsider.post('/api/sign/download').set('Origin', origin).send({ token: annaMain, documentId: bilaga.id }).buffer(true).parse(binary);
  assert.equal(sha256(bilagaPdf.body), completed.completedHash);
  assert.equal((await f.post('/api/sign/session', { token: copyToken, documentId: bilaga.id }, f.outsider)).status, 404, 'Receipt links cannot sign.');

  // The bilaga carries portable evidence bound to the main document.
  const evidence = (await f.owner.get('/api/documents/' + bilaga.id + '/evidence')).body;
  const core = JSON.parse(Buffer.from(evidence.evidenceCoreBase64, 'base64').toString('utf8'));
  assert.deepEqual(core.document.attachmentOf, bilaga.attachmentOf);
  const bilagaOriginal = (await f.owner.get('/api/documents/' + bilaga.id + '/pdf?version=original').buffer(true).parse(binary)).body;
  const verified = await verifySealedEvidence(evidence, bilagaOriginal, bilagaPdf.body);
  assert.equal(verified.integrity, 'valid'); assert.equal(verified.signatures, 3);
  const moved = structuredClone(evidence); moved.document.attachmentOf.documentId = uid();
  await assert.rejects(verifySealedEvidence(moved, bilagaOriginal, bilagaPdf.body));

  // Later bilagor are numbered, and a bilaga cannot have its own bilagor.
  const second = await f.post(`/api/documents/${mainId}/attachments`, await attachmentBody({ title: 'Tillägg', parentRecipientIds: [annaId], recipients: [{ name: 'Cecilia Ny', email: 'cecilia@example.test' }] }));
  assert.equal(second.status, 201, second.text);
  assert.equal(second.body.document.attachmentOf.number, 2);
  assert.equal(second.body.senderRecipientId, null);
  assert.equal((await f.post(`/api/documents/${bilaga.id}/attachments`, await attachmentBody())).status, 409);

  // Bo was not selected for the second bilaga, and Cecilia is only a party to it.
  const boDocuments = (await f.post('/api/sign/dossier', { token: boMain }, f.outsider)).body.documents.map((document: any) => document.id);
  assert.deepEqual(boDocuments, [mainId, bilaga.id]);
  assert.equal((await f.post('/api/sign/session', { token: boMain, documentId: second.body.document.id }, f.outsider)).status, 404);
  const cecilia = hash(second.body.links[1].url);
  assert.deepEqual((await f.post('/api/sign/dossier', { token: cecilia }, f.outsider)).body.documents.map((document: any) => document.id), [second.body.document.id]);
  assert.equal((await f.post('/api/sign/pdf', { token: cecilia, documentId: mainId }, f.outsider)).status, 404);
  assert.equal((await f.post('/api/sign/session', { token: annaMain, documentId: second.body.document.id }, f.outsider)).body.recipientId, second.body.document.recipients[0].id);

  // Storage keeps the relationship immutable.
  await assert.rejects(f.db.query('UPDATE documents SET parent_id=NULL WHERE id=$1', [second.body.document.id]), /immutable/);
  await assert.rejects(f.db.query('UPDATE recipients SET parent_recipient_id=$1 WHERE id=$2', [boId, second.body.document.recipients[0].id]), /immutable/);
});

test('without SMTP the response says links must be shared manually', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-attachments-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  const runtime = await createApp({ databaseUrl: databaseUrl!, dataDir, schema, baseUrl: origin, setupToken: 'attachment-test-setup-token-long-enough', rateLimit: false, legacyCreation: true });
  t.after(async () => { await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = request.agent(runtime.app);
  const post = (path: string, body: unknown) => owner.post(path).set('Origin', origin).send(body);
  assert.equal((await post('/api/setup', { setupToken: 'attachment-test-setup-token-long-enough', name: 'Sara Sender', email: 'sara@example.test', password, teamName: 'Bilagor' })).status, 201);
  const main = await post('/api/documents', { title: 'Avtal', fileName: 'avtal.pdf', pdfBase64: (await pdf('Avtal')).toString('base64'), methodId: 'draw', recipients: [{ name: 'Anna', email: 'anna@example.test' }] });
  assert.equal(main.body.notified, false);
  const token = hash(main.body.links[0].url);
  const session = await post('/api/sign/session', { token });
  assert.equal((await post('/api/sign/complete', { token, documentHash: session.body.document.originalHash, consentVersion: session.body.consent.version, accepted: true, name: 'Anna', payload: { strokes } })).body.document.status, 'completed');
  // Real bilagor are larger than the small JSON limit, and only authenticated uploads get the large body parser.
  const large = await PDFDocument.create();
  const page = large.addPage();
  for (let line = 0; line < 3000; line++) page.drawText(uid() + uid(), { x: 20 + (line % 5) * 100, y: 20 + (line % 150) * 5, size: 4 });
  const big = Buffer.from(await large.save());
  assert.ok(big.length > 64 * 1024);
  assert.equal((await request(runtime.app).post(`/api/documents/${main.body.document.id}/attachments`).set('Origin', origin).send({ title: 'Bilaga', fileName: 'b.pdf', pdfBase64: big.toString('base64'), methodId: 'draw', parentRecipientIds: [], recipients: [] })).status, 401);
  const bilaga = await post(`/api/documents/${main.body.document.id}/attachments`, { title: 'Bilaga', fileName: 'b.pdf', pdfBase64: big.toString('base64'), methodId: 'draw', parentRecipientIds: [main.body.document.recipients[0].id], recipients: [] });
  assert.equal(bilaga.status, 201, bilaga.text);
  assert.equal(bilaga.body.notified, false);
  // Recipient parent mappings are checked by the database, not only by the API.
  await assert.rejects(runtime.db.query('INSERT INTO recipients(id,document_id,position,name,email,method_id,method_version,token_hash,expires_at,parent_recipient_id) VALUES($1,$2,9,$3,$4,$5,$6,$7,$8,$9)',
    [uid(), main.body.document.id, 'X', 'x@example.test', 'draw', '1', sha256(uid()), Date.now() + 1000, bilaga.body.document.recipients[0].id]), /main document|immutable/);
});
