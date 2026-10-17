import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../dist/server/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const schema = 'agent_browser_' + randomBytes(8).toString('hex');
const output = resolve('.test-artifacts/browser-agent');
await mkdir(output, { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const setupToken = randomBytes(32).toString('base64url');
const runtime = await createApp({ databaseUrl, schema, dataDir: output, baseUrl: baseURL, setupToken, legacyCreation: true, rateLimit: false });
server.on('request', runtime.app);
const browser = await chromium.launch({ headless: true });
const client = new Client({ name: 'signhere-browser-journey', version: '1.0.0' });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const api = context.request;
  assert.equal((await api.post(baseURL + '/api/setup', { headers: { Origin: baseURL }, data: { setupToken, name: 'Sara Sender', email: 'sara@example.test', password: 'correct horse battery staple', teamName: 'PRPL' } })).status(), 201);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack));
  await page.goto(baseURL + '/settings/agents');
  await expect(page.getByRole('heading', { name: 'Anslut din agent' })).toBeVisible();
  await expect(page.getByLabel('MCP-adress')).toHaveValue(baseURL + '/mcp');
  await expect(page.getByLabel('Giltighet')).toHaveValue('60');
  await page.getByLabel('Giltighet').selectOption('15');
  await expect(page.getByRole('checkbox', { name: /^Uppdatera delade versioner/ })).not.toBeChecked();
  await page.getByLabel('Nyckelns namn').fill('Claude för offerter');
  await page.getByRole('button', { name: 'Skapa API-nyckel', exact: true }).click();
  const created = page.getByRole('region', { name: 'Din nya API-nyckel' });
  await expect(created).toBeVisible();
  const token = await created.getByLabel('API-nyckel', { exact: true }).inputValue();
  assert.match(token, /^shk_[A-Za-z0-9_-]{43}$/);
  const metadata = (await (await api.get(baseURL + '/api/agent-keys')).json()).keys[0];
  assert.equal(Date.parse(metadata.expiresAt) - Date.parse(metadata.createdAt), 15 * 60000);
  await created.getByRole('button', { name: 'Kopiera nyckel', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
  await created.getByRole('button', { name: 'Jag har sparat nyckeln' }).click();
  await expect(created).toHaveCount(0);
  assert.equal(await page.evaluate(value => JSON.stringify(localStorage).includes(value), token), false);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Dina API-nycklar' })).toContainText('Claude för offerter');
  assert.equal((await page.locator('body').innerText()).includes(token), false);
  await page.screenshot({ path: output + '/01-agent-settings-desktop.png', fullPage: true });

  // A real MCP client uses the key created in the UI. The ordinary editor sees its work.
  await client.connect(new StreamableHTTPClientTransport(new URL(baseURL + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'signhere_create_draft'));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content?.find(item => item.type === 'text')?.text);
    return result.structuredContent;
  };
  const workspace = await call('signhere_workspace', {});
  assert.equal(workspace.workspace.name, 'PRPL');
  assert.equal(workspace.expiresAt, metadata.expiresAt);
  const timestamp = new Date().toISOString(), id = randomBytes(10).toString('hex');
  const draft = {
    id, version: 2, title: 'Offert från min agent', createdAt: timestamp, updatedAt: timestamp,
    blocks: [{ id: 'scope', type: 'text', title: 'Omfattning', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vi skapar en webbplats för klienten.' }] }] } }],
    company: null, theme: { font: 'grotesk', accent: '#0e1116' },
    settings: { currency: 'SEK', pricesIncludeVat: false, expiresInDays: 30, remind: false, allowDecline: false, senderSigns: false }, fields: {}, customFields: [],
  };
  const createdDraft = await call('signhere_create_draft', { draft, requestId: randomUUID() });
  const saved = await call('signhere_save_draft', { draftId: id, expectedRevision: createdDraft.revision, requestId: randomUUID() });
  assert.equal(saved.version, 1);
  await page.goto(createdDraft.url);
  await expect(page.getByLabel('Dokumentnamn')).toHaveValue(draft.title);
  await expect(page.locator('.ProseMirror').first()).toContainText('Vi skapar en webbplats');
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Support ingår.');
  await expect.poll(async () => (await (await api.get(`${baseURL}/api/drafts/${id}`)).json()).revision).toBeGreaterThan(createdDraft.revision);
  const stale = await client.callTool({ name: 'signhere_update_draft', arguments: { draftId: id, draft: { ...draft, title: 'Stale overwrite' }, expectedRevision: createdDraft.revision, requestId: randomUUID() } });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'revision_conflict');
  const latest = await call('signhere_get_draft', { draftId: id });
  assert.match(JSON.stringify(latest.draft), /Support ingår/);
  const updated = await call('signhere_update_draft', { draftId: id, draft: { ...latest.draft, title: 'Offert med support' }, expectedRevision: latest.revision, requestId: randomUUID() });
  await call('signhere_save_draft', { draftId: id, expectedRevision: updated.revision, requestId: randomUUID() });
  await page.reload();
  await expect(page.getByLabel('Dokumentnamn')).toHaveValue('Offert med support');
  await expect(page.locator('.ProseMirror').first()).toContainText('Support ingår');

  await page.goto(baseURL + '/settings/agents');
  const skill = await api.get(baseURL + '/skills/signhere/signhere.zip');
  assert.equal(skill.status(), 200);
  assert.ok((await skill.body()).byteLength > 1000);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Skapa API-nyckel', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: output + '/02-agent-settings-mobile.png', fullPage: true });
  const keys = page.getByRole('region', { name: 'Dina API-nycklar' });
  await keys.getByRole('button', { name: 'Återkalla', exact: true }).click();
  await keys.getByRole('button', { name: 'Återkalla nyckel', exact: true }).click();
  await expect(keys.getByText('Återkallad', { exact: true })).toBeVisible();
  await assert.rejects(client.callTool({ name: 'signhere_workspace', arguments: {} }));
  assert.deepEqual(errors, []);
  console.log('Agent journey passed: UI-issued key, real MCP create/save, editor visibility, conflict reconciliation, skill download, mobile settings and immediate revocation. Screenshots: ' + output);
} finally {
  await client.close().catch(() => {});
  await browser.close();
  await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
  await runtime.close();
  await new Promise(resolve => server.close(resolve));
}
