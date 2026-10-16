import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { registerMcp } from './mcp.js';
import { AgentConflict, type AgentService } from './agent-api.js';
import { ApiError, hashPassword } from './security.js';
import { createApp } from './app.js';
import { uid } from './db.js';
import { createDraft, templateBlocks } from '../web/editor/model.js';

const origin = 'http://127.0.0.1:3000';
async function listen(app: ReturnType<typeof express>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}
async function connect(url: URL, token: string) {
  const client = new Client({ name: 'signhere-integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
  await client.connect(transport);
  return { client, transport };
}

test('official MCP client discovers the full shared schemas and calls a stateless bearer endpoint', async t => {
  let calls = 0;
  const service: AgentService = {
    authenticate: async req => {
      if (req.get('Authorization') !== 'Bearer test-key') throw new ApiError(401, 'Invalid API key.');
      return { keyId: uid(), userId: uid(), teamId: uid(), userName: 'Owner', teamName: 'Workspace', scopes: [] };
    },
    execute: async (_principal, operation) => {
      calls++;
      if (operation === 'get_draft') throw new AgentConflict(7);
      if (operation === 'get_discussion') throw new Error('do not leak private server internals');
      return { operation, calls };
    },
  };
  const app = express();
  registerMcp(app, service, { origin, rateLimit: false });
  const { server, url } = await listen(app);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const { client, transport } = await connect(url, 'test-key');
  t.after(() => client.close());
  const tools = await client.listTools();
  t.diagnostic('Official SDK negotiated MCP protocol ' + transport.protocolVersion);
  assert.equal(tools.tools.length, 8);
  assert.ok(!tools.tools.some(tool => /sign(?:ature)?_|send|revoke|create_review/.test(tool.name.replace('signhere_', ''))));
  assert.ok(tools.tools.find(tool => tool.name === 'signhere_create_draft')?.inputSchema.properties?.draft, 'the existing recursive draft schema converts successfully to a discoverable input schema');
  assert.equal(transport.sessionId, undefined, 'no reusable transport session can cross user identities');
  const result = await client.callTool({ name: 'signhere_workspace', arguments: {} });
  assert.deepEqual(result.structuredContent, { operation: 'workspace', calls: 1 });
  const conflict = await client.callTool({ name: 'signhere_get_draft', arguments: { draftId: 'existingdraft' } });
  assert.equal(conflict.isError, true);
  assert.deepEqual(conflict.structuredContent, { error: { code: 'revision_conflict', message: 'The draft changed. Fetch the latest draft and reconcile your changes.', currentRevision: 7 } });
  const internal = await client.callTool({ name: 'signhere_get_discussion', arguments: { draftId: 'existingdraft' } });
  assert.equal(internal.isError, true);
  assert.ok(!JSON.stringify(internal).includes('private server internals'));
  const invalid = await client.callTool({ name: 'signhere_get_draft', arguments: { draftId: '../not-a-draft' } });
  assert.equal(invalid.isError, true);
  assert.equal(calls, 3, 'invalid tool input never reaches the application service');
  const malformed = await client.callTool({ name: 'signhere_workspace', arguments: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['untrusted-private-key-' + i, 'private text'])) });
  assert.equal(malformed.isError, true);
  assert.ok(JSON.stringify(malformed).length < 2000, 'SDK schema errors are bounded regardless of invalid argument count');
  assert.ok(!JSON.stringify(malformed).includes('untrusted-private-key'));
  await assert.rejects(client.callTool({ name: 'signhere_send_for_signing', arguments: {} }), /not found|Unknown tool/i);
  assert.equal(calls, 3, 'sending and signing are absent from the MCP surface');
  const base = url.toString();
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const missing = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer realm="Signhere"');
  const cookieOnly = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'session=test' }, body: JSON.stringify(body) });
  assert.equal(cookieOnly.status, 401);
  const evil = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(body) });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const wrongHost = await request(app).post('/mcp').set('Host', 'evil.example').set('Authorization', 'Bearer test-key').send(body);
  assert.equal(wrongHost.status, 403);
  const legacy = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } } }) });
  assert.equal(legacy.status, 200);
  assert.match(await legacy.text(), /2025-06-18/);
  const oversized = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ padding: 'x'.repeat(10_000_000) }) });
  assert.equal(oversized.status, 413);
  assert.ok((await oversized.text()).length < 1000);
  assert.equal((await client.callTool({ name: 'signhere_workspace', arguments: {} })).isError, undefined, 'validation and body-limit failures release request resources');
});

test('MCP bounds in-flight work per key and releases capacity after responses complete', { timeout: 10_000 }, async t => {
  let arrived = 0;
  let unblock!: () => void, ready!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const principal = { keyId: uid(), userId: uid(), teamId: uid(), userName: 'Owner', teamName: 'Workspace', scopes: [] };
  const service: AgentService = {
    authenticate: async () => principal,
    execute: async () => { if (++arrived === 4) ready(); await blocked; return { ok: true }; },
  };
  const app = express();
  registerMcp(app, service, { origin, rateLimit: false });
  const { server, url } = await listen(app);
  t.after(() => { unblock(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const call = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'signhere_workspace', arguments: {} } }) });
  const pending = Array.from({ length: 4 }, call);
  await started;
  const excess = await call();
  assert.equal(excess.status, 429);
  assert.equal(excess.headers.get('retry-after'), '1');
  unblock();
  for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); await response.text(); }
  const recovered = await call();
  assert.equal(recovered.status, 200);
  await recovered.text();
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('MCP calls use real workspace services with revision conflicts, discussion, scope checks and immediate revocation', { skip: !databaseUrl }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-mcp-'));
  const schema = 'mcp_' + uid().replaceAll('-', '');
  let clock = Date.now();
  const runtime = await createApp({ databaseUrl: databaseUrl!, schema, dataDir, baseUrl: origin, setupToken: 'mcp-tests-installation-key-long-enough', legacyCreation: true, rateLimit: false, now: () => clock });
  const { server, url } = await listen(runtime.app);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE');
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const owner = request.agent(runtime.app);
  const post = (path: string, data: unknown) => owner.post(path).set('Origin', origin).send(data);
  const setup = await post('/api/setup', { setupToken: 'mcp-tests-installation-key-long-enough', name: 'Owner', email: 'owner@example.test', password: 'correct horse battery staple', teamName: 'MCP workspace' });
  assert.equal(setup.status, 201, setup.text);
  const key = await post('/api/agent-keys', { name: 'Integration agent', scopes: ['drafts:read', 'drafts:write', 'discussion:read', 'discussion:write'], expiresInDays: 1 });
  assert.equal(key.status, 201, key.text);
  const { client } = await connect(url, key.body.token);
  t.after(() => client.close());
  const call = async (operation: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: 'signhere_' + operation, arguments: args });
    return { ...result, data: result.structuredContent as any };
  };
  const identity = await call('workspace');
  assert.equal(identity.data.workspace.name, 'MCP workspace');
  const draft = createDraft('mcpdraft000001', setup.body.user);
  draft.title = 'MCP service proposal';
  draft.blocks = templateBlocks('agreement');
  const createInput = { draft, requestId: uid() };
  const created = await call('create_draft', createInput);
  assert.equal(created.isError, undefined);
  assert.equal(created.data.revision, 1);
  assert.equal((await call('create_draft', createInput)).data.revision, 1, 'identical request retry returns the original result');
  assert.equal((await owner.get('/api/drafts/' + draft.id)).body.draft.title, draft.title);
  assert.equal((await call('list_drafts')).data.drafts[0].id, draft.id);
  const latest = await call('get_draft', { draftId: draft.id });
  assert.equal(latest.data.revision, 1);
  const updated = { ...draft, title: 'Agent revision' };
  assert.equal((await call('update_draft', { draftId: draft.id, expectedRevision: 1, draft: updated, requestId: uid() })).data.revision, 2);
  const stale = await call('update_draft', { draftId: draft.id, expectedRevision: 1, draft: { ...draft, title: 'Stale edit' }, requestId: uid() });
  assert.equal(stale.isError, true);
  assert.equal(stale.data.error.code, 'revision_conflict');
  assert.equal(stale.data.error.currentRevision, 2);
  assert.equal((await owner.get('/api/drafts/' + draft.id)).body.draft.title, 'Agent revision');
  const saved = await call('save_draft', { draftId: draft.id, expectedRevision: 2, requestId: uid() });
  assert.equal(saved.isError, undefined);
  assert.equal(saved.data.version, 1);
  const comment = await call('add_comment', { draftId: draft.id, version: 1, blockId: draft.blocks[0].id, body: 'Please review this section.', requestId: uid() });
  assert.equal(comment.isError, undefined);
  const reply = await call('add_comment', { draftId: draft.id, version: 1, threadId: comment.data.threadId, body: 'This is a follow-up.', requestId: uid() });
  assert.equal(reply.isError, undefined);
  assert.equal((await call('get_discussion', { draftId: draft.id })).data.threads[0].comments.length, 2);
  const otherTeam = uid(), otherUser = uid();
  await runtime.db.query('INSERT INTO teams(id,name) VALUES($1,$2)', [otherTeam, 'Other workspace']);
  await runtime.db.query("INSERT INTO users(id,team_id,name,email,password_hash,role,created_at) VALUES($1,$2,'Other','other-mcp@example.test',$3,'owner',$4)", [otherUser, otherTeam, await hashPassword('other correct horse password'), new Date(clock).toISOString()]);
  const otherDraft = { ...draft, id: 'othermcpdraft' };
  await runtime.db.query('INSERT INTO drafts(id,team_id,created_by,revision,content,updated_at) VALUES($1,$2,$3,1,$4,$5)', [otherDraft.id, otherTeam, otherUser, otherDraft, new Date(clock).toISOString()]);
  const denied = await call('get_draft', { draftId: otherDraft.id });
  assert.equal(denied.isError, true);
  assert.equal(denied.data.error.code, 'not_found');
  assert.equal((await call('list_drafts')).data.drafts.length, 1);
  const readKey = await post('/api/agent-keys', { name: 'Read only', scopes: ['drafts:read'] });
  const read = await connect(url, readKey.body.token);
  t.after(() => read.client.close());
  const forbidden = await read.client.callTool({ name: 'signhere_update_draft', arguments: { draftId: draft.id, expectedRevision: 2, draft, requestId: uid() } });
  assert.equal(forbidden.isError, true);
  assert.equal((forbidden.structuredContent as any).error.code, 'forbidden');
  assert.equal((await post('/api/agent-keys/' + key.body.key.id + '/revoke', {})).status, 200);
  await assert.rejects(call('workspace'), /401|Unauthorized|invalid|revoked/i, 'an established client loses access immediately on key revocation');
  clock += 366 * 86400000;
  await assert.rejects(read.client.callTool({ name: 'signhere_workspace', arguments: {} }), /401|Unauthorized|invalid|expired/i, 'expired keys are rejected independently of MCP sessions');
});
