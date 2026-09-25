// Browser flow for optional independent approval: the participant approves at the central
// service (separate origin) with the PDF fetched browser-to-installation, then signs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../dist/server/app.js';
import { createCentralApp, createInstance } from '../dist/server/central/app.js';
import { generateSigner, newBundle, signTrustBundle, trustKey } from '../dist/server/central/keys.js';
import { verifyTrustBundle } from '../dist/server/central/protocol.js';
import { createCentralClient } from '../dist/server/central-client.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL or DATABASE_URL for browser tests.');
const output = resolve('.test-artifacts/browser-independent-approval');
await mkdir(output, { recursive: true });
const listen = async () => { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); return server; };
const instanceServer = await listen(), centralServer = await listen();
const baseURL = `http://localhost:${instanceServer.address().port}`;
const centralURL = `http://localhost:${centralServer.address().port}`;
const schema = 'e2e_' + randomBytes(8).toString('hex'), centralSchema = 'e2e_central_' + randomBytes(8).toString('hex');

const root = await generateSigner(), receiptKey = await generateSigner();
const bundleJws = await signTrustBundle(root.signer, newBundle(centralURL, 1, [trustKey(receiptKey.signer, '2020-01-01T00:00:00.000Z')]));
const mail = [];
const central = await createCentralApp({ databaseUrl, schema: centralSchema, origin: centralURL, signer: receiptKey.signer, webDir: resolve('dist/central-web'),
  trustBundle: { jws: bundleJws, bundle: await verifyTrustBundle(bundleJws, root.signer.publicKey), rootPublicKey: root.signer.publicKey },
  mailer: { provider: 'test', async send(message) { mail.push(message); return {}; } }, rateLimit: false, cleanup: { autoStart: false } });
centralServer.on('request', central.app);
const instance = await createInstance(central.pool, { name: 'Exempel AB', origin: baseURL });
const setupToken = randomBytes(32).toString('base64url');
const runtime = await createApp({ databaseUrl, dataDir: output, keysDir: resolve(output, 'keys', schema), baseUrl: baseURL, schema, setupToken, rateLimit: false,
  central: createCentralClient({ url: centralURL, apiKey: instance.apiKey, trustRoot: root.signer.publicKey }) });
instanceServer.on('request', runtime.app);

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const errors = [];
const polyfill = () => { if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); }; if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = Map.prototype.getOrInsertComputed; };
try {
  const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await owner.addInitScript(polyfill);
  const post = (path, data) => owner.request.post(baseURL + path, { data, headers: { Origin: baseURL } });
  assert.equal((await post('/api/setup', { setupToken, name: 'Sara Sender', email: 'sara@example.test', password: 'correct horse battery staple', teamName: 'Exempel AB' })).status(), 201);
  const pdf = await PDFDocument.create(); pdf.addPage().drawText('Avtal som godkänns oberoende');
  const pdfBytes = Buffer.from(await pdf.save());
  // The option is visible only because a central service is configured.
  const ownerPage = await owner.newPage();
  ownerPage.on('pageerror', error => errors.push(error.message));
  await ownerPage.goto(baseURL + '/new');
  await ownerPage.locator('input[type=file]').setInputFiles({ name: 'avtal.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
  await ownerPage.getByRole('button', { name: 'Nästa' }).click();
  await expect(ownerPage.getByText(/Kräv oberoende bekräftelse via localhost/)).toBeVisible();
  await ownerPage.screenshot({ path: output + '/01-create-option.png', fullPage: true });
  const created = await (await post('/api/documents', { title: 'Hyresavtal', fileName: 'avtal.pdf', pdfBase64: pdfBytes.toString('base64'), methodId: 'draw', independentApproval: true, recipients: [{ name: 'Anna Andersson', email: 'anna@example.test' }] })).json();
  const token = new URL(created.links[0].url).hash.slice(1);

  const participant = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await participant.addInitScript(polyfill);
  const signer = await participant.newPage();
  signer.on('pageerror', error => errors.push(error.message));
  await signer.goto(baseURL + '/sign#' + token);
  const approveLink = signer.getByRole('link', { name: /Bekräfta via localhost/ });
  await expect(approveLink).toBeVisible({ timeout: 15000 });
  await expect(signer.getByRole('button', { name: 'Signera', exact: true })).toBeDisabled();
  await signer.screenshot({ path: output + '/02-sign-needs-approval.png', fullPage: true });

  const [approval] = await Promise.all([participant.waitForEvent('page'), approveLink.click()]);
  approval.on('pageerror', error => errors.push(error.message));
  approval.on('console', message => { if (message.type() === 'error') errors.push('central: ' + message.text()); });
  await expect(approval.getByRole('heading', { name: 'Hyresavtal' })).toBeVisible({ timeout: 15000 });
  await expect(approval.getByText(/Hämtad direkt från avsändarens installation/)).toBeVisible({ timeout: 15000 });
  await expect(approval.locator('.pdf-page canvas').first()).toBeVisible();
  await approval.getByRole('button', { name: 'Skicka kod' }).click();
  await expect.poll(() => mail.length).toBe(1);
  assert.equal(mail[0].to, 'anna@example.test');
  const code = /(\d{4}) (\d{4})/.exec(mail[0].text).slice(1).join('');
  await approval.getByLabel('Kod från e-postmeddelandet').fill(code);
  await approval.getByRole('button', { name: 'Bekräfta', exact: true }).click();
  await expect(approval.getByText('✓ anna@example.test är bekräftad.')).toBeVisible();
  await approval.getByRole('checkbox').check();
  await approval.screenshot({ path: output + '/03-central-approve.png', fullPage: true });
  await approval.getByRole('button', { name: 'Godkänn dokumentet' }).click();
  await expect(approval.getByRole('heading', { name: 'Godkänt' })).toBeVisible();
  await approval.screenshot({ path: output + '/04-central-approved.png', fullPage: true });
  await approval.close();

  await signer.bringToFront();
  await expect(signer.getByText(/Du har bekräftat din e-postadress/)).toBeVisible({ timeout: 15000 });
  await signer.getByRole('button', { name: 'Signera', exact: true }).click();
  const dialog = signer.getByRole('dialog');
  await dialog.getByLabel('Ditt fullständiga namn').fill('Anna Andersson');
  const canvas = dialog.locator('canvas');
  await canvas.focus(); await canvas.press('Space');
  for (let i = 0; i < 25; i++) await canvas.press('ArrowRight');
  for (let i = 0; i < 8; i++) await canvas.press('ArrowUp');
  await canvas.press('Space');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Signera dokumentet', exact: true }).click();
  await expect(signer.getByRole('heading', { name: 'Signerat', exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await (await owner.request.get(`${baseURL}/api/documents/${created.document.id}`)).json()).document.status, { timeout: 60000 }).toBe('completed');
  await signer.reload();
  await expect(signer.getByRole('button', { name: 'Ladda ner ditt bevispaket' })).toBeVisible({ timeout: 15000 });
  await signer.screenshot({ path: output + '/05-signed.png', fullPage: true });

  // Local receipt check on the central service's own verifier page.
  const receipt = (await central.pool.query('SELECT receipt FROM approvals')).rows[0].receipt;
  const verify = await participant.newPage();
  await verify.goto(centralURL + '/verifiera');
  await expect(verify.getByLabel('Rotnyckel (trust root)')).toHaveValue(root.signer.publicKey);
  await verify.getByLabel('Kvitto (.jws)').setInputFiles({ name: 'kvitto.jws', mimeType: 'application/jose', buffer: Buffer.from(receipt) });
  await verify.getByLabel(/Dokumentet du godkände/).setInputFiles({ name: 'avtal.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await (await owner.request.get(`${baseURL}/api/documents/${created.document.id}/pdf?version=original`)).body()) });
  await verify.waitForTimeout(300);
  await verify.getByRole('button', { name: 'Kontrollera' }).click();
  await expect(verify.getByText(/Kvittot är signerat av/)).toBeVisible();
  await expect(verify.getByText('Den valda PDF-filen är exakt det dokument som godkändes.')).toBeVisible();
  await verify.screenshot({ path: output + '/06-verify.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Independent approval browser flow passed. Screenshots: ' + output);
} finally {
  await browser.close();
  await runtime.finalization.stop();
  await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
  await central.pool.query('DROP SCHEMA "' + centralSchema + '" CASCADE').catch(() => {});
  await runtime.close(); await central.close();
  instanceServer.close(); centralServer.close();
}
