// Browser flow for sending from the editor: one confirm sheet, the sender signs, then the links to share.
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
// No e-mail configured: the links are the way to share.
const runtime = await createApp({ databaseUrl, dataDir: output, keysDir: resolve(output, 'keys', schema), baseUrl: baseURL, schema, setupToken, rateLimit: false });
server.on('request', runtime.app);
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const errors = [];
const polyfill = () => { if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); }; if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = Map.prototype.getOrInsertComputed; };
const draftKey = id => 'signhere.drafts.v1.' + id;
const company = { id: 'c1', name: 'Kund AB', orgNr: '556000-0000', address: 'Gatan 1', zip: '111 11', city: 'Stockholm', contacts: [
  { id: 'p1', name: 'Anna Andersson', email: 'anna@example.test', role: 'VD', signs: true },
  { id: 'p2', name: 'Cecilia Copy', email: 'cecilia@example.test', role: 'Ekonomi', signs: false },
] };
try {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await owner.addInitScript(polyfill);
  const api = owner.request;
  assert.equal((await api.post(baseURL + '/api/setup', { data: { setupToken, name: 'Sara Sender', email: 'sara@example.test', password: 'correct horse battery staple', teamName: 'Avtal AB' }, headers: { Origin: baseURL } })).status(), 201);
  const page = await owner.newPage();
  page.on('pageerror', error => errors.push(error.message));
  // The deliberate 503 below is logged by the browser as a failed resource; everything else must be clean.
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('503')) errors.push(message.text()); });

  /** Opens a new draft with some text, the customer and its signers, and the given title. */
  async function draft(id, title, senderSigns) {
    await page.goto(`${baseURL}/editor/${id}`);
    await page.getByRole('button', { name: /Tomt dokument/ }).click();
    await page.locator('.ProseMirror').first().click();
    await page.keyboard.type('Leverantören sköter service av anläggningen under 2027.');
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.blocks?.length > 0, draftKey(id));
    await page.evaluate(({ key, company, title, senderSigns }) => {
      const stored = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify({ ...stored, title, company, settings: { ...stored.settings, senderSigns } }));
    }, { key: draftKey(id), company, title, senderSigns });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Skicka' })).toBeVisible();
  }

  // An untitled draft cannot be sent; the issue points to the title.
  await draft('e2euntitled00001', '', true);
  await page.getByRole('button', { name: 'Skicka' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Ge dokumentet ett namn/ }).click();
  await expect(page.getByLabel('Dokumentnamn')).toBeFocused();

  // One sheet confirms the signers chosen in the editor. A failed send keeps the draft and can be retried.
  await draft('e2esend000000001', 'Serviceavtal 2027', true);
  await page.getByRole('button', { name: 'Skicka' }).click();
  const sheet = page.getByRole('dialog', { name: 'Skicka för signering' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Anna Andersson')).toBeVisible();
  await expect(sheet.getByText('Sara Sender (du)')).toBeVisible();
  await expect(sheet.getByText('Cecilia Copy')).toHaveCount(0);
  await expect(sheet.getByText(/Inga e-postmeddelanden skickas/)).toBeVisible();
  await page.screenshot({ path: output + '/01-sheet.png', fullPage: true });
  await page.route('**/api/documents', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Förseglingen behöver åtgärdas av administratören innan nya dokument kan skickas.' }) })
    : route.continue());
  await sheet.getByRole('button', { name: 'Skicka och signera' }).click();
  await expect(sheet.getByRole('alert')).toHaveText(/Förseglingen behöver åtgärdas/, { timeout: 20000 });
  await expect(sheet.getByRole('button', { name: 'Försök igen' })).toBeEnabled();
  await page.screenshot({ path: output + '/02-error.png', fullPage: true });
  await sheet.getByRole('button', { name: 'Avbryt' }).click();
  await expect(sheet).toHaveCount(0);
  assert.ok(await page.evaluate(key => localStorage.getItem(key), draftKey('e2esend000000001')), 'A failed send keeps the draft.');
  await page.unroute('**/api/documents');
  await page.getByRole('button', { name: 'Skicka' }).click();
  await sheet.getByRole('button', { name: 'Skicka och signera' }).click();

  // The sender's signature opens by itself; afterwards the links are shown at the document's URL.
  const signDialog = page.getByRole('dialog', { name: 'Signera' });
  await expect(signDialog).toBeVisible({ timeout: 30000 });
  const canvas = signDialog.locator('canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 60); await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 30 + i * 12, box.y + 60 + Math.sin(i) * 25);
  await page.mouse.up();
  await signDialog.getByRole('checkbox').check();
  await signDialog.getByRole('button', { name: 'Signera dokumentet' }).click();
  await expect(page.getByRole('heading', { name: 'Din signatur är klar' })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Skickat' })).toBeFocused();
  await expect(page.getByText('1 av 2 signerat')).toBeVisible();
  await expect(page.getByText(/Spara länkarna nu/)).toBeVisible();
  await expect(page.locator('.share-card')).toHaveCount(1);
  await expect(page.locator('.share-card')).toContainText('Anna Andersson');
  await page.screenshot({ path: output + '/03-sent.png', fullPage: true });
  const documentId = new URL(page.url()).pathname.split('/')[2];
  assert.match(page.url(), /\/documents\/[0-9a-f-]{36}$/);
  const detail = (await (await api.get(`${baseURL}/api/documents/${documentId}`)).json()).document;
  assert.equal(detail.title, 'Serviceavtal 2027');
  assert.deepEqual(detail.recipients.map(recipient => recipient.email).sort(), ['anna@example.test', 'sara@example.test']);
  assert.ok(detail.recipients.find(recipient => recipient.id === detail.senderRecipientId).signedAt);
  const pdf = await PDFDocument.load(await (await api.get(`${baseURL}/api/documents/${documentId}/pdf?version=original`)).body());
  assert.equal(pdf.getPageCount(), 1, 'The editor renders the draft to a PDF that the server prepared for signing.');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), draftKey('e2esend000000001')), null, 'A sent draft leaves the drafts list.');
  await page.getByRole('button', { name: 'Till dokumentet' }).click();
  await expect(page.getByRole('heading', { name: 'Serviceavtal 2027' })).toBeVisible();

  // Without the sender signing, sending goes straight to the links.
  await draft('e2esend000000002', 'Serviceavtal 2028', false);
  await page.getByRole('button', { name: 'Skicka' }).click();
  await expect(sheet.getByText('Sara Sender (du)')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Skicka för signering' }).click();
  await expect(page.getByRole('heading', { name: 'Redo att signeras' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.share-card')).toHaveCount(1);
  await page.screenshot({ path: output + '/04-sent-no-sender.png', fullPage: true });
  // Back leaves the sent page without reopening the deleted draft.
  await page.goBack();
  await expect(page).not.toHaveURL(/e2esend000000002/);
  assert.deepEqual(errors, []);
  console.log('Editor send browser flow passed. Screenshots: ' + output);
} finally {
  await browser.close();
  await runtime.finalization.stop();
  await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
  await runtime.close(); server.close();
}
