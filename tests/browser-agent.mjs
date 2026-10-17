import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
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
  await context.addInitScript(() => {
    if (!Map.prototype.getOrInsertComputed) Map.prototype.getOrInsertComputed = function (key, make) { if (!this.has(key)) this.set(key, make(key)); return this.get(key); };
    if (!WeakMap.prototype.getOrInsertComputed) WeakMap.prototype.getOrInsertComputed = Map.prototype.getOrInsertComputed;
  });
  const api = context.request;
  assert.equal((await api.post(baseURL + '/api/setup', { headers: { Origin: baseURL }, data: { setupToken, name: 'Sara Sender', email: 'sara@example.test', password: 'correct horse battery staple', teamName: 'PRPL' } })).status(), 201);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack));
  await page.goto(baseURL + '/settings/agents');
  await expect(page.getByRole('heading', { name: 'Anslut din agent' })).toBeVisible();
  await expect(page.getByLabel('MCP-adress', { exact: true })).toHaveValue(baseURL + '/mcp');
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
  const fixture = JSON.parse(await readFile(new URL('../server/assets/skills/signhere/examples/service-agreement.json', import.meta.url), 'utf8'));
  const draft = { ...fixture, id, createdAt: timestamp, updatedAt: timestamp };
  const createdDraft = await call('signhere_create_draft', { draft, requestId: randomUUID() });
  assert.deepEqual((await call('signhere_get_draft', { draftId: id })).draft, draft, 'MCP reads back every native block, mark, field reference and private value');
  const saved = await call('signhere_save_draft', { draftId: id, expectedRevision: createdDraft.revision, requestId: randomUUID() });
  assert.equal(saved.version, 1);
  assert.equal(saved.visibility, 'private');
  await page.goto(createdDraft.url);
  await expect(page.getByLabel('Dokumentnamn')).toHaveValue(draft.title);
  const scope = page.locator('[data-block="scope"] .ProseMirror');
  async function checkRichFormatting(hourlyRate = '') {
    await expect(page.locator('[data-block="cover"] .ed-cover-title')).toHaveValue(draft.blocks.find(block => block.id === 'cover').title);
    await expect(page.locator('[data-block="fixed-price"] .ed-totals .total strong')).toHaveText(/3\s000\s(?:kr|SEK)/);
    await expect(page.locator('[data-block="new-page"]')).toBeVisible();
    await expect.poll(() => page.locator('[data-block="illustration"] img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(scope.locator('h3')).toHaveText('Arbetssätt');
    await expect(scope.locator('em')).toHaveText('Omfattningen bekräftas före start.');
    await expect(scope.locator('p').filter({ hasText: /^Alternativ A:/ }).locator('strong')).toHaveText('Alternativ A: ');
    await expect(scope.locator('p').filter({ hasText: /^Alternativ B:/ }).locator('strong')).toHaveText('Alternativ B: ');
    await expect(scope.locator('ul > li')).toHaveCount(2);
    await expect(scope.locator('ol > li')).toHaveCount(2);
    await expect(scope.locator('a')).toHaveAttribute('href', 'https://example.com/project');
    await expect(page.locator('[data-block="delivery-plan"] table th')).toHaveCount(2);
    await expect(page.locator('[data-block="delivery-plan"] table td')).toHaveCount(2);
    await expect(page.locator('[data-block="delivery-plan"] .ProseMirror > p').first()).toHaveCSS('text-align', 'center');
    await expect(page.locator('[data-block="parties"]')).toContainText('Fylls i från mottagarlistan');
    await expect(page.locator('[data-block="parties"]')).toContainText(draft.fields['sender.company']);
    if (hourlyRate) await expect(page.locator('.ed-field.filled').filter({ hasText: hourlyRate })).toHaveCount(2);
    else await expect(page.locator('.ed-field.empty').filter({ hasText: 'Timpris' })).toHaveCount(2);
  }
  await checkRichFormatting();
  await scope.locator(':scope > p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Support ingår.');
  await expect.poll(async () => JSON.stringify((await (await api.get(`${baseURL}/api/drafts/${id}`)).json()).draft)).toContain('Support ingår.');
  const stale = await client.callTool({ name: 'signhere_update_draft', arguments: { draftId: id, draft: { ...draft, title: 'Stale overwrite' }, expectedRevision: createdDraft.revision, requestId: randomUUID() } });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'revision_conflict');
  const latest = await call('signhere_get_draft', { draftId: id });
  assert.match(JSON.stringify(latest.draft), /Support ingår/);
  assert.deepEqual(latest.draft.blocks.filter(block => block.id !== 'scope'), draft.blocks.filter(block => block.id !== 'scope'), 'editor edit preserves unrelated blocks exactly');
  assert.deepEqual(latest.draft.fields, draft.fields, 'blank and private values survive editor edits');
  assert.deepEqual(latest.draft.customFields, draft.customFields);
  assert.equal(latest.draft.company, null, 'no fictitious recipient was created');
  // Tiptap adds default attributes when serializing an edited block. Check every
  // original node, explicit attribute, mark and text without rejecting defaults.
  function preservesRichNode(actual, expected) {
    assert.equal(actual.type, expected.type);
    if (expected.text !== undefined) assert.equal(actual.text, expected.text);
    for (const [key, value] of Object.entries(expected.attrs ?? {})) assert.deepEqual(actual.attrs[key], value);
    assert.equal((actual.marks ?? []).length, (expected.marks ?? []).length);
    for (const [index, mark] of (expected.marks ?? []).entries()) preservesRichNode(actual.marks[index], mark);
    assert.equal((actual.content ?? []).length, (expected.content ?? []).length);
    for (const [index, child] of (expected.content ?? []).entries()) preservesRichNode(actual.content[index], child);
  }
  const expectedScope = structuredClone(draft.blocks.find(block => block.id === 'scope').content);
  expectedScope.content.at(-1).content.at(-1).text += ' Support ingår.';
  preservesRichNode(latest.draft.blocks.find(block => block.id === 'scope').content, expectedScope);
  // Filling a reusable value once must update both references, without replacing
  // either field node or turning the unknown original fixture rate into zero.
  const edited = { ...latest.draft, title: 'Serviceavtal med support', updatedAt: new Date().toISOString(), fields: { ...latest.draft.fields, 'custom.hourlyRate': '1250' } };
  const updated = await call('signhere_update_draft', { draftId: id, draft: edited, expectedRevision: latest.revision, requestId: randomUUID() });
  const savedAgain = await call('signhere_save_draft', { draftId: id, expectedRevision: updated.revision, requestId: randomUUID() });
  assert.equal(savedAgain.version, 2);
  assert.equal(savedAgain.visibility, 'private');
  assert.deepEqual((await call('signhere_get_draft', { draftId: id })).draft, edited, 'MCP edit and save preserve source exactly');
  const snapshot = await (await api.get(`${baseURL}/api/drafts/${id}/versions/${savedAgain.version}`)).json();
  assert.deepEqual(snapshot.draft.blocks, edited.blocks, 'immutable version retains all formatting and field references');
  assert.equal(snapshot.draft.fields['custom.hourlyRate'], '1250');
  assert.equal(snapshot.draft.fields['custom.internalNote'], undefined, 'unused private values stay out of review snapshots');
  await page.reload();
  await expect(page.getByLabel('Dokumentnamn')).toHaveValue('Serviceavtal med support');
  await expect(scope).toContainText('Support ingår');
  await checkRichFormatting('1250');
  await page.screenshot({ path: output + '/03-agreement-fixture.png', fullPage: true });

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
  console.log('Agent journey passed: UI-issued key, native agreement MCP create/read/edit/save, editor formatting and field preservation, immutable snapshot, conflict reconciliation, skill download, mobile settings and immediate revocation. Screenshots: ' + output);
} finally {
  await client.close().catch(() => {});
  await browser.close();
  await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
  await runtime.close();
  await new Promise(resolve => server.close(resolve));
}
