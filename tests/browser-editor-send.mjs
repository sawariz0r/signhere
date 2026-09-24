// Browser flow for sending a document drafted in the editor: render to PDF, confirm in the upload flow, send.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../dist/server/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL for browser tests.');
const schema = 'e2e_' + randomBytes(8).toString('hex');
const output = resolve('.test-artifacts/browser-editor-send');
await mkdir(output, { recursive: true });
const setupToken = randomBytes(32).toString('base64url');
const server = createServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}`;
// No e-mail configured: the flow must still send and show the links to share.
const runtime = await createApp({ databaseUrl, dataDir: output, keysDir: resolve(output, 'keys', schema), baseUrl: baseURL, schema, setupToken, rateLimit: false });
server.on('request', runtime.app);
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const errors = [];
const polyfill = () => { if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); }; if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = Map.prototype.getOrInsertComputed; };
const draftId = 'e2esend000000001';
try {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await owner.addInitScript(polyfill);
  const api = owner.request;
  assert.equal((await api.post(baseURL + '/api/setup', { data: { setupToken, name: 'Sara Sender', email: 'sara@example.test', password: 'correct horse battery staple', teamName: 'Avtal AB' }, headers: { Origin: baseURL } })).status(), 201);
  const page = await owner.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(`${baseURL}/editor/${draftId}`);
  await page.getByLabel('Dokumentnamn').fill('Serviceavtal 2027');
  await page.getByRole('button', { name: /Tomt dokument/ }).click();
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type('Leverantören sköter service av anläggningen under 2027.');
  await expect(page.locator('.ed-save')).toHaveText(/Sparat/);
  // Choose the signing party as the recipients panel would, and have the sender sign too.
  await page.evaluate(id => {
    const key = 'signhere.drafts.v1.' + id;
    const draft = JSON.parse(localStorage.getItem(key));
    draft.company = { id: 'c1', name: 'Kund AB', orgNr: '556000-0000', address: 'Gatan 1', zip: '111 11', city: 'Stockholm', contacts: [
      { id: 'p1', name: 'Anna Andersson', email: 'anna@example.test', role: 'VD', signs: true },
      { id: 'p2', name: 'Cecilia Copy', email: 'cecilia@example.test', role: 'Ekonomi', signs: false },
    ] };
    draft.settings.senderSigns = true;
    localStorage.setItem(key, JSON.stringify(draft));
  }, draftId);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Skicka' })).toBeVisible();
  await page.screenshot({ path: output + '/01-editor.png', fullPage: true });
  await page.getByRole('button', { name: 'Skicka' }).click();

  await expect(page.getByRole('heading', { name: 'Nytt dokument' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Serviceavtal 2027.pdf')).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('Titel')).toHaveValue('Serviceavtal 2027');
  await page.screenshot({ path: output + '/02-file.png', fullPage: true });
  await page.getByRole('button', { name: 'Nästa' }).click();
  await expect(page.locator('input[value="Anna Andersson"]')).toBeVisible();
  await expect(page.locator('input[value="anna@example.test"]')).toBeVisible();
  await expect(page.locator('input[value="cecilia@example.test"]')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Jag ska också signera/ })).toBeChecked();
  await page.screenshot({ path: output + '/03-recipients.png', fullPage: true });
  await page.getByRole('button', { name: 'Skapa och signera' }).click();
  // The sender signs first, as with an uploaded PDF.
  await expect(page.getByRole('button', { name: 'Signera', exact: true })).toBeVisible({ timeout: 20000 });

  const list = await (await api.get(baseURL + '/api/documents')).json();
  const created = (list.documents ?? list).find(document => document.title === 'Serviceavtal 2027');
  assert.ok(created, 'The draft became a document.');
  const detail = (await (await api.get(`${baseURL}/api/documents/${created.id}`)).json()).document;
  assert.deepEqual(detail.recipients.map(recipient => recipient.email).sort(), ['anna@example.test', 'sara@example.test']);
  assert.ok(detail.senderRecipientId);
  const pdf = await PDFDocument.load(await (await api.get(`${baseURL}/api/documents/${created.id}/pdf?version=original`)).body());
  assert.equal(pdf.getPageCount(), 1, 'The editor renders the draft to a PDF that the server prepared for signing.');
  assert.equal(await page.evaluate(id => localStorage.getItem('signhere.drafts.v1.' + id), draftId), null, 'A sent draft leaves the drafts list.');
  await page.screenshot({ path: output + '/04-sender-sign.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Editor send browser flow passed. Screenshots: ' + output);
} finally {
  await browser.close();
  await runtime.finalization.stop();
  await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
  await runtime.close(); server.close();
}
