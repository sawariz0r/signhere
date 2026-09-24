import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { createApp, type AppConfig } from './app.js';
import { uid } from './db.js';
import { sha256 } from './pdf.js';
import { CONSENT } from './plugins.js';
import { attachmentName } from './delivery.js';
import { MailPermanentError, MailTransientError, mailerFromEnv, resendMailer, type Mailer, type MailMessage } from './mail.js';
import { createNotifier } from './notify.js';

try { loadEnvFile('.local/postgres.env'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Delivery tests require PostgreSQL.');
const origin = 'http://localhost:3000';
const setupToken = 'test-only-owner-setup-token-32-characters';
const strokes = [[[0.1, 0.2], [0.35, 0.8], [0.7, 0.1], [0.9, 0.6]]];
const DAY = 86400000;

function capture(fail?: (message: MailMessage) => Error | undefined) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { provider: 'test', async send(message) { const error = fail?.(message); if (error) throw error; sent.push(message); return { messageId: 'test-' + sent.length }; } };
  return { mailer, sent };
}
async function fixture(t: TestContext, overrides: Partial<AppConfig> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-delivery-'));
  const schema = 'test_' + uid().replaceAll('-', '');
  let clock = Date.now();
  const runtime = await createApp({ databaseUrl: databaseUrl!, baseUrl: origin, dataDir, schema, setupToken, rateLimit: false, legacyCreation: true,
    now: () => clock, delivery: { autoStart: false, retryBaseMs: 0 }, ...overrides });
  t.after(async () => { await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  const agent = request.agent(runtime.app);
  const post = (path: string, body: unknown, client: any = agent) => client.post(path).set('Origin', origin).send(body);
  assert.equal((await post('/api/setup', { setupToken, name: 'Ägare Öberg', email: 'owner@example.test', password: 'correct horse battery staple', teamName: 'Testteam' })).status, 201);
  const pdf = await PDFDocument.create(); pdf.addPage([595, 842]);
  const original = Buffer.from(await pdf.save());
  async function create(recipients: { name: string; email: string }[], includeSender = false) {
    const response = await post('/api/documents', { title: 'Avtal 2026/1', fileName: 'avtal.pdf', pdfBase64: original.toString('base64'), methodId: 'draw', recipients, includeSender });
    assert.equal(response.status, 201, response.text);
    return { ...response.body, tokens: response.body.links.map((link: { url: string }) => new URL(link.url).hash.slice(1)) as string[] };
  }
  const sign = (document: any, token: string, name = 'Signer') => post('/api/sign/complete', { token, documentHash: document.originalHash, consentVersion: CONSENT.version, accepted: true, name, payload: { strokes } }, request(runtime.app));
  return { ...runtime, agent, post, create, sign, advance: (ms: number) => { clock += ms; } };
}

test('completion emails the sealed copy once per distinct address, including the sender, and supports resending', async t => {
  const mail = capture();
  const f = await fixture(t, { mailer: mail.mailer });
  assert.deepEqual((await f.agent.get('/api/bootstrap')).body.delivery, { email: true });
  // The sender also signs and a party shares the sender's address: one email for that address.
  const created = await f.create([{ name: 'Kund Karlsson', email: 'kund@example.test' }, { name: 'Delad Adress', email: 'OWNER@example.test' }], true);
  const doc = created.document;
  for (const [index, token] of created.tokens.entries()) {
    assert.equal((await f.sign(doc, token, 'Signer ' + index)).status, 200);
    if (index < created.tokens.length - 1) assert.equal((await f.db.query('SELECT count(*) FROM email_deliveries')).rows[0].count, '0');
  }
  const detail = (await f.agent.get('/api/documents/' + doc.id)).body.document;
  assert.equal(detail.status, 'completed');
  assert.deepEqual(detail.deliveries.map((d: any) => [d.email.toLowerCase(), d.status]).sort(), [['kund@example.test', 'queued'], ['owner@example.test', 'queued']]);
  while ((await f.delivery!.runOnce()).status !== 'idle');
  assert.equal(mail.sent.length, 2);
  const completed = (await f.db.query('SELECT completed FROM documents WHERE id=$1', [doc.id])).rows[0].completed;
  for (const message of mail.sent) {
    assert.equal(message.subject, 'Signerat: Avtal 2026/1');
    assert.equal(message.attachments?.length, 1);
    assert.equal(message.attachments![0].filename, 'Avtal 2026_1_signerat.pdf');
    assert.equal(sha256(message.attachments![0].content), sha256(completed));
    assert.match(message.text, new RegExp(doc.id));
    assert.match(message.text, /http:\/\/localhost:3000\/verify/);
    assert.doesNotMatch(message.html!, /<script/);
  }
  // A party's copy carries a personal link to the completed document, bilagor and event log.
  const copyLink = mail.sent.find(m => m.to === 'kund@example.test')!.text.match(/http:\/\/localhost:3000\/copy#([A-Za-z0-9_-]{43})/);
  assert.ok(copyLink);
  assert.equal((await f.post('/api/sign/dossier', { token: copyLink[1] }, request(f.app))).status, 200);
  const sent = (await f.agent.get('/api/documents/' + doc.id)).body.document.deliveries;
  assert.ok(sent.every((d: any) => d.status === 'sent' && d.sentAt));
  // Re-queuing is idempotent at the queue level and never duplicates rows.
  assert.equal((await f.post('/api/documents/' + doc.id + '/deliveries', {})).body.deliveries.length, 2);
  const target = sent.find((d: any) => d.email === 'kund@example.test');
  const resent = await f.post('/api/documents/' + doc.id + '/deliveries/' + target.id + '/resend', {});
  assert.equal(resent.status, 200, resent.text);
  assert.equal(resent.body.deliveries.find((d: any) => d.id === target.id).status, 'queued');
  assert.equal((await f.post('/api/documents/' + doc.id + '/deliveries/' + target.id + '/resend', {})).status, 409);
  assert.equal((await f.delivery!.runOnce()).status, 'sent');
  assert.equal(mail.sent.length, 3);
  assert.notEqual(mail.sent[2].idempotencyKey, mail.sent.find(m => m.to === 'kund@example.test')!.idempotencyKey);
  // Other teams cannot see or trigger deliveries.
  assert.equal((await f.post('/api/documents/' + uid() + '/deliveries/' + target.id + '/resend', {})).status, 404);
});

test('with a mailer, signing links go through it and completion sends one message per address', async t => {
  const mail = capture();
  const f = await fixture(t, { mailer: mail.mailer, notifier: createNotifier({ mailer: mail.mailer }) });
  const settle = async (count: number) => { for (let i = 0; i < 50 && mail.sent.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10)); };
  const created = await f.create([{ name: 'Kund', email: 'kund@example.test' }]);
  assert.equal(created.notified, true);
  await settle(1);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 'kund@example.test');
  assert.match(mail.sent[0].text, /väntar|signera/i);
  assert.ok(mail.sent[0].idempotencyKey);
  assert.equal((await f.sign(created.document, created.tokens[0])).status, 200);
  await settle(2);
  // The best-effort receipt notification is replaced by the durable completed copy.
  assert.equal(mail.sent.length, 1);
  while ((await f.delivery!.runOnce()).status !== 'idle');
  assert.deepEqual(mail.sent.slice(1).map(m => [m.to, m.attachments?.length]).sort(), [['kund@example.test', 1], ['owner@example.test', 1]]);
  assert.match(mail.sent.find(m => m.to === 'owner@example.test')!.text, new RegExp('/documents/' + created.document.id));
});

test('transient failures retry, permanent failures stop, and deliveries only exist for completed documents', async t => {
  let mode: 'transient' | 'permanent' | 'ok' = 'transient';
  const mail = capture(() => mode === 'transient' ? new MailTransientError('smtp_unavailable') : mode === 'permanent' ? new MailPermanentError('smtp_rejected') : undefined);
  const f = await fixture(t, { mailer: mail.mailer });
  const created = await f.create([{ name: 'Kund', email: 'kund@example.test' }]);
  assert.equal((await f.post('/api/documents/' + created.document.id + '/deliveries', {})).status, 409);
  await assert.rejects(f.db.query("INSERT INTO email_deliveries(id,document_id,email,name,kind) VALUES($1,$2,'x@example.test','X','completed_copy')", [uid(), created.document.id]), /completed document/);
  assert.equal((await f.sign(created.document, created.tokens[0])).status, 200);
  assert.equal((await f.delivery!.runOnce()).status, 'retry');
  const row = async () => (await f.db.query("SELECT status,attempts,last_error_code FROM email_deliveries WHERE email='kund@example.test'")).rows[0];
  assert.deepEqual(await row(), { status: 'retry', attempts: 1, last_error_code: 'smtp_unavailable' });
  mode = 'permanent';
  await f.db.query("UPDATE email_deliveries SET available_at=clock_timestamp()");
  while ((await f.delivery!.runOnce()).status !== 'idle');
  assert.equal((await f.db.query("SELECT count(*) FROM email_deliveries WHERE status='failed' AND last_error_code='smtp_rejected'")).rows[0].count, '2');
  mode = 'ok';
  const failed = (await f.agent.get('/api/documents/' + created.document.id)).body.document.deliveries;
  for (const delivery of failed) assert.equal((await f.post('/api/documents/' + created.document.id + '/deliveries/' + delivery.id + '/resend', {})).status, 200);
  while ((await f.delivery!.runOnce()).status !== 'idle');
  assert.equal(mail.sent.length, 2);
  assert.deepEqual(await row(), { status: 'sent', attempts: 1, last_error_code: null });
});

test('without a mailer nothing is queued and the delivery endpoints refuse', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.agent.get('/api/bootstrap')).body.delivery, { email: false });
  const created = await f.create([{ name: 'Kund', email: 'kund@example.test' }]);
  const session = await f.post('/api/sign/session', { token: created.tokens[0] }, request(f.app));
  assert.equal(session.body.emailCopy, false);
  assert.equal((await f.sign(created.document, created.tokens[0])).status, 200);
  assert.equal((await f.db.query('SELECT count(*) FROM email_deliveries')).rows[0].count, '0');
  assert.equal((await f.agent.get('/api/documents/' + created.document.id)).body.document.deliveries, undefined);
  assert.equal((await f.post('/api/documents/' + created.document.id + '/deliveries', {})).status, 409);
  assert.equal(f.delivery, null);
});

test('an early signer keeps receipt access until 30 days after a late completion', async t => {
  const f = await fixture(t);
  const created = await f.create([{ name: 'Tidig', email: 'early@example.test' }, { name: 'Sen', email: 'late@example.test' }]);
  const doc = created.document;
  assert.equal((await f.sign(doc, created.tokens[0], 'Tidig')).status, 200);
  const signedPdf = await request(f.app).post('/api/sign/pdf').set('Origin', origin).send({ token: created.tokens[0] });
  assert.equal(signedPdf.status, 200);
  f.advance(40 * DAY);
  // Still pending: the accepted receipt remains available while others sign.
  assert.equal((await f.post('/api/sign/session', { token: created.tokens[0] }, request(f.app))).status, 200);
  assert.equal((await f.post('/api/login', { email: 'owner@example.test', password: 'correct horse battery staple' })).status, 200);
  const rotated = await f.post('/api/documents/' + doc.id + '/recipients/' + doc.recipients[1].id + '/link', {});
  assert.equal(rotated.status, 200, rotated.text);
  assert.equal((await f.sign(doc, new URL(rotated.body.url).hash.slice(1), 'Sen')).status, 200);
  assert.equal((await request(f.app).post('/api/sign/download').set('Origin', origin).send({ token: created.tokens[0] })).status, 200);
  f.advance(29 * DAY);
  assert.equal((await request(f.app).post('/api/sign/download').set('Origin', origin).send({ token: created.tokens[0] })).status, 200);
  f.advance(2 * DAY);
  assert.equal((await request(f.app).post('/api/sign/download').set('Origin', origin).send({ token: created.tokens[0] })).status, 404);
});

test('an unsigned link still expires on schedule', async t => {
  const f = await fixture(t);
  const created = await f.create([{ name: 'Kund', email: 'kund@example.test' }]);
  f.advance(8 * DAY);
  assert.equal((await f.post('/api/sign/session', { token: created.tokens[0] }, request(f.app))).status, 404);
});

test('mail configuration: SMTP is the default, Resend is explicit, and misconfiguration fails at startup', () => {
  assert.equal(mailerFromEnv({}), null);
  assert.equal(mailerFromEnv({ SIGNHERE_MAIL_FROM: 'a@example.test' }), null);
  assert.equal(mailerFromEnv({ SMTP_HOST: 'smtp.example.test', SIGNHERE_MAIL_FROM: 'Signhere <a@example.test>' })?.provider, 'smtp');
  assert.throws(() => mailerFromEnv({ SMTP_HOST: 'smtp.example.test' }), /SIGNHERE_MAIL_FROM/);
  // SMTP_URL and SMTP_FROM are shorthand for the SMTP_* settings.
  assert.equal(mailerFromEnv({ SMTP_URL: 'smtps://user%40example.test:secret@smtp.example.test', SMTP_FROM: 'a@example.test' })?.provider, 'smtp');
  assert.throws(() => mailerFromEnv({ SMTP_URL: 'http://smtp.example.test', SMTP_FROM: 'a@example.test' }), /smtp:\/\/ or smtps:\/\//);
  assert.throws(() => mailerFromEnv({ SMTP_URL: 'smtp://smtp.example.test' }), /SIGNHERE_MAIL_FROM/);
  assert.throws(() => mailerFromEnv({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '0', SIGNHERE_MAIL_FROM: 'a@example.test' }), /SMTP_PORT/);
  assert.throws(() => mailerFromEnv({ SMTP_HOST: 'smtp.example.test', SIGNHERE_MAIL_FROM: 'a@example.test\r\nBcc: x@example.test' }), /single line/);
  assert.equal(mailerFromEnv({ SIGNHERE_MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', SIGNHERE_MAIL_FROM: 'a@example.test' })?.provider, 'resend');
  assert.throws(() => mailerFromEnv({ SIGNHERE_MAIL_PROVIDER: 'resend', SIGNHERE_MAIL_FROM: 'a@example.test' }), /RESEND_API_KEY/);
  assert.throws(() => mailerFromEnv({ SIGNHERE_MAIL_PROVIDER: 'sendgrid' }), /smtp or resend/);
  assert.equal(attachmentName('../../etc/passwd'), '.._.._etc_passwd_signerat.pdf');
});

test('an unreachable SMTP server is a transient failure', async () => {
  const { smtpMailer } = await import('./mail.js');
  const mailer = smtpMailer({ host: '127.0.0.1', port: 1, secure: false, from: 'a@example.test' });
  await assert.rejects(mailer.send({ to: 'kund@example.test', subject: 'x', text: 'x', html: 'x', idempotencyKey: 'k.0' }), (error: unknown) => error instanceof MailTransientError && error.code === 'smtp_unavailable');
});

test('Resend requests carry the attachment and idempotency key and classify failures', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(status === 200 ? { id: 'msg_1' } : { message: 'no' }), { status }); }) as unknown as typeof fetch;
  const mailer = resendMailer({ apiKey: 're_secret', from: 'Signhere <a@example.test>', fetch: fake });
  const message: MailMessage = { to: 'kund@example.test', subject: 'Signerat', text: 'Hej', html: '<p>Hej</p>', idempotencyKey: 'delivery.0', attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' }] };
  assert.deepEqual(await mailer.send(message), { messageId: 'msg_1' });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(headers.Authorization, 'Bearer re_secret'); assert.equal(headers['Idempotency-Key'], 'delivery.0');
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, ['kund@example.test']);
  assert.deepEqual(body.attachments, [{ filename: 'a.pdf', content: Buffer.from('%PDF').toString('base64'), content_type: 'application/pdf' }]);
  for (const [code, kind] of [[429, MailTransientError], [500, MailTransientError], [409, MailTransientError], [422, MailPermanentError], [401, MailPermanentError]] as const) {
    status = code;
    await assert.rejects(mailer.send(message), kind);
  }
});
