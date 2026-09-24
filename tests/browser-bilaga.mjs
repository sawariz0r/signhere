// Browser flow for bilagor: add one from the editor, sign it through the original link, open the e-mailed receipt.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../dist/server/app.js';
import { createNotifier } from '../dist/server/notify.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL for browser tests.');
const schema = 'e2e_' + randomBytes(8).toString('hex');
const output = resolve('.test-artifacts/browser-bilaga');
await mkdir(output, { recursive: true });
const setupToken = randomBytes(32).toString('base64url');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const mail = [];
const runtime = await createApp({ databaseUrl, dataDir: output, keysDir: resolve(output, 'keys', schema), baseUrl: baseURL, schema, setupToken, rateLimit: false, notifier: createNotifier({ deliver: async m => { mail.push(m); } }) });
server.on('request', runtime.app);
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const errors = [];
// Older Chromium builds predate Map.prototype.getOrInsertComputed, which pdf.js 6 uses.
const polyfill = () => { if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); }; if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = Map.prototype.getOrInsertComputed; };
try {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await owner.addInitScript(polyfill);
  const api = owner.request;
  const post = (path, data) => api.post(baseURL + path, { data, headers: { Origin: baseURL } });
  assert.equal((await post('/api/setup', { setupToken, name: 'Sara Sender', email: 'sara@example.test', password: 'correct horse battery staple', teamName: 'Bilagor AB' })).status(), 201);
  const doc = await PDFDocument.create(); doc.addPage().drawText('Huvudavtal mellan parterna');
  const created = await (await post('/api/documents', { title: 'Huvudavtal', fileName: 'avtal.pdf', pdfBase64: Buffer.from(await doc.save()).toString('base64'), methodId: 'draw', recipients: [{ name: 'Anna Andersson', email: 'anna@example.test' }, { name: 'Bo Berg', email: 'bo@example.test' }] })).json();
  const tokens = created.links.map(link => new URL(link.url).hash.slice(1));
  const strokes = [[[0.1, 0.2], [0.35, 0.8], [0.7, 0.1], [0.9, 0.6]]];
  for (const [index, token] of tokens.entries()) {
    const session = await (await post('/api/sign/session', { token })).json();
    const signed = await post('/api/sign/complete', { token, documentHash: session.document.originalHash, consentVersion: session.consent.version, signingIntentHash: session.signingIntentHash, accepted: true, name: ['Anna Andersson', 'Bo Berg'][index], payload: { strokes } });
    assert.equal(signed.status(), 200);
  }
  await expect.poll(async () => (await (await api.get(`${baseURL}/api/documents/${created.document.id}`)).json()).document.status, { timeout: 30000 }).toBe('completed');

  await new Promise(r => setTimeout(r, 300));
  mail.length = 0;
  const page = await owner.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${baseURL}/documents/${created.document.id}`);
  await expect(page.getByRole('heading', { name: 'Bilagor' })).toBeVisible();
  await page.screenshot({ path: output + '/01-detail.png', fullPage: true });
  await page.getByRole('button', { name: '+ Lägg till bilaga' }).click();
  await expect(page.getByRole('heading', { name: 'Ny bilaga' })).toBeVisible();
  await page.getByRole('button', { name: 'Skapa bilagan i editorn' }).click();
  await expect(page.getByRole('button', { name: 'Använd som bilaga' })).toBeVisible();
  await page.getByLabel('Dokumentnamn').fill('Prisbilaga 2027');
  await page.getByRole('button', { name: /Avtal/ }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Använd som bilaga/ }).click();
  await expect(page.getByText(/Tomt fält/).first()).toBeVisible();
  // Empty customer fields block use, like sending. Start again from a blank draft.
  await page.goto(`${baseURL}/editor/e2eblank0000001?bilaga=${created.document.id}`);
  await page.getByLabel('Dokumentnamn').fill('Prisbilaga 2027');
  await page.getByRole('button', { name: /Tomt dokument/ }).click();
  const prose = page.locator('.ProseMirror').first();
  await prose.click();
  await page.keyboard.type('Priserna gäller från 1 januari 2027. ');
  await page.keyboard.press('Control+b'); await page.keyboard.type('Fast pris 12 000 kr per månad.'); await page.keyboard.press('Control+b');
  await page.keyboard.press('Enter'); await page.keyboard.type('Övriga villkor i huvudavtalet gäller oförändrade.');
  await page.waitForTimeout(700);
  await page.screenshot({ path: output + '/02-editor.png', fullPage: true });
  await page.getByRole('button', { name: /Använd som bilaga/ }).click();
  await expect(page.getByRole('heading', { name: 'Ny bilaga' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Prisbilaga 2027.pdf')).toBeVisible({ timeout: 20000 });
  await page.getByText('Förhandsvisa PDF').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: output + '/03-bilaga-file.png', fullPage: true });
  await page.getByRole('button', { name: 'Nästa' }).click();
  await expect(page.getByRole('checkbox', { name: /Anna Andersson/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Bo Berg/ })).toBeChecked();
  await page.screenshot({ path: output + '/04-parties.png', fullPage: true });
  await page.getByRole('button', { name: 'Skicka för signering' }).click();
  await expect(page.getByText('Länkarna har skickats via e-post')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: output + '/05-sent.png', fullPage: true });
  assert.deepEqual(mail.map(m => m.to), ['anna@example.test', 'bo@example.test']);
  const bilagaId = (await (await api.get(`${baseURL}/api/documents/${created.document.id}`)).json()).document.attachments[0].id;
  const bilagaPdf = await PDFDocument.load(await (await api.get(`${baseURL}/api/documents/${bilagaId}/pdf?version=original`)).body());
  assert.equal(bilagaPdf.getPageCount(), 1, 'The editor renders the draft to a PDF that the server prepared for signing.');

  // Anna uses her original link.
  const party = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await party.addInitScript(polyfill);
  const annaPage = await party.newPage();
  annaPage.on('pageerror', error => errors.push(error.message));
  await annaPage.goto(`${baseURL}/sign#${tokens[0]}`);
  await expect(annaPage.getByRole('heading', { name: 'Dokument och bilagor' })).toBeVisible({ timeout: 20000 });
  await annaPage.screenshot({ path: output + '/06-party-dossier.png', fullPage: true });
  await annaPage.getByRole('button', { name: 'Läs och signera' }).click();
  await expect(annaPage.getByText('Bilaga 1 till Huvudavtal')).toBeVisible({ timeout: 20000 });
  await expect(annaPage.getByRole('button', { name: 'Signera', exact: true })).toBeEnabled({ timeout: 20000 });
  await annaPage.screenshot({ path: output + '/07-party-bilaga.png', fullPage: true });
  await annaPage.getByRole('button', { name: 'Signera', exact: true }).click();
  const canvas = annaPage.locator('canvas').last();
  const box = await canvas.boundingBox();
  await annaPage.mouse.move(box.x + 30, box.y + 100); await annaPage.mouse.down();
  for (let i = 0; i < 20; i++) await annaPage.mouse.move(box.x + 30 + i * 12, box.y + 100 + Math.sin(i) * 30);
  await annaPage.mouse.up();
  await annaPage.getByRole('checkbox').check();
  await annaPage.getByRole('button', { name: 'Signera dokumentet' }).click();
  await expect(annaPage.getByRole('heading', { name: 'Signerat' })).toBeVisible({ timeout: 20000 });
  await annaPage.screenshot({ path: output + '/08-party-signed.png', fullPage: true });

  // Bo signs through the bilaga link from the e-mail; the bilaga completes and receipts are e-mailed.
  const boLink = mail.find(m => m.to === 'bo@example.test').text.match(/http\S+\/sign#\S+/)[0];
  const boToken = new URL(boLink).hash.slice(1);
  const session = await (await post('/api/sign/session', { token: boToken })).json();
  assert.equal((await post('/api/sign/complete', { token: boToken, documentHash: session.document.originalHash, consentVersion: session.consent.version, signingIntentHash: session.signingIntentHash, accepted: true, name: 'Bo Berg', payload: { strokes } })).status(), 200);
  await expect.poll(() => mail.filter(m => m.subject.startsWith('Signerat av alla parter')).length, { timeout: 30000 }).toBe(3);
  const copy = mail.find(m => m.to === 'anna@example.test' && m.subject.startsWith('Signerat')).text.match(/http\S+\/copy#\S+/)[0];
  await annaPage.goto(copy);
  await expect(annaPage.getByRole('heading', { name: 'Dokument och bilagor' })).toBeVisible({ timeout: 20000 });
  await expect(annaPage.getByRole('button', { name: 'Ladda ner', exact: true })).toHaveCount(2);
  await annaPage.screenshot({ path: output + '/09-copy-dossier.png', fullPage: true });

  await page.goto(`${baseURL}/documents/${created.document.id}`);
  await expect(page.getByText('Bilaga 1 · Prisbilaga 2027')).toBeVisible();
  await page.screenshot({ path: output + '/10-owner-detail.png', fullPage: true });
  await page.goto(baseURL);
  await expect(page.getByText('1 bilaga')).toBeVisible();
  await page.screenshot({ path: output + '/11-list.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Bilaga browser flow passed. Screenshots: ' + output);
} finally {
  await browser.close();
  await runtime.finalization.stop();
  await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
  await runtime.close(); server.close();
}
