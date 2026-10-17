import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport, discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams } from '@modelcontextprotocol/client';
import { registerMcp } from './mcp.js';
import type { AgentContext, AgentService } from './agent-api.js';
import { ApiError, token } from './security.js';
import { uid } from './db.js';
import { createApp } from './app.js';
import { createDraft } from '../web/editor/model.js';

async function rawResult(response: Response) {
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
  const frame = text.split('\n').find(line => line.startsWith('data: '));
  assert.ok(frame, 'the SDK returns a JSON-RPC SSE frame');
  return JSON.parse(frame.slice(6));
}

test('OAuth MCP requires linking, advertises each tool policy and signals expiry without changing manual authentication', async t => {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = new URL('/mcp/oauth', origin);
  const metadataUrl = origin + '/.well-known/oauth-protected-resource/mcp/oauth';
  const principal: AgentContext = { keyId: uid(), userId: uid(), teamId: uid(), userName: 'Owner', teamName: 'OAuth workspace', scopes: ['drafts:read'] };
  let revoked = false, expireDuringExecution = false;
  const service = (kind: 'manual' | 'oauth'): AgentService => ({
    authenticate: async req => {
      if (req.get('Authorization') !== 'Bearer ' + kind + '-token' || kind === 'oauth' && revoked) throw new ApiError(401, 'Access is missing, expired or revoked.');
      return principal;
    },
    execute: async (_auth, operation) => {
      if (kind === 'oauth' && expireDuringExecution) { revoked = true; throw new ApiError(401, 'Access expired during the request.'); }
      return { operation, workspace: { name: principal.teamName } };
    },
  });
  app.get('/.well-known/oauth-protected-resource/mcp/oauth', (_req, res) => res.json({ resource: endpoint.href, authorization_servers: [origin], scopes_supported: ['drafts:read', 'drafts:write', 'discussion:read', 'discussion:write', 'reviews:share'] }));
  registerMcp(app, service('manual'), { origin, rateLimit: false, oauthService: service('oauth'), oauthResourceMetadataUrl: metadataUrl });
  const call = (body: unknown, authorization?: string, path = '/mcp/oauth', headers: Record<string, string> = {}) => fetch(new URL(path, origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(authorization ? { Authorization: authorization } : {}), ...headers }, body: JSON.stringify(body),
  });
  for (const body of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]) {
    const missing = await call(body);
    assert.equal(missing.status, 401, 'both initialization and discovery require OAuth');
    const challenge = missing.headers.get('www-authenticate')!;
    assert.ok(challenge.includes('resource_metadata="' + metadataUrl + '"'));
    assert.match(challenge, /error="invalid_token"/);
    const params = extractWWWAuthenticateParams(missing);
    assert.equal(params.resourceMetadataUrl?.href, metadataUrl);
    const metadata = await discoverOAuthProtectedResourceMetadata(endpoint, { resourceMetadataUrl: params.resourceMetadataUrl });
    assert.equal(metadata.resource, endpoint.href);
    assert.deepEqual(metadata.authorization_servers, [origin]);
    await missing.text();
  }
  const cookie = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, undefined, '/mcp/oauth', { Cookie: 'session=browser-only' });
  assert.equal(cookie.status, 401, 'browser sessions never authenticate the MCP endpoint');
  assert.equal((await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'Bearer manual-token')).status, 401, 'manual tokens never enter the OAuth endpoint');
  const oauth = new Client({ name: 'signhere-oauth-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: 'Bearer oauth-token' } } });
  await oauth.connect(transport);
  t.after(() => oauth.close());
  assert.match(oauth.getInstructions()!, /browser sign-in and consent managed by the user's agent host/);
  assert.match(oauth.getInstructions()!, /Never ask for or use email\/password/);
  const tools = await oauth.listTools();
  assert.equal(tools.tools.length, 8);
  assert.deepEqual(tools.tools.find(tool => tool.name === 'signhere_workspace')?._meta?.securitySchemes, [{ type: 'oauth2', scopes: [] }]);
  assert.deepEqual(tools.tools.find(tool => tool.name === 'signhere_get_draft')?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['drafts:read'] }]);
  assert.deepEqual(tools.tools.find(tool => tool.name === 'signhere_create_draft')?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['drafts:write'] }]);
  assert.deepEqual(tools.tools.find(tool => tool.name === 'signhere_get_discussion')?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['discussion:read'] }]);
  assert.deepEqual(tools.tools.find(tool => tool.name === 'signhere_add_comment')?._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['discussion:write'] }]);
  assert.ok(!tools.tools.some(tool => tool.name.includes('send') || tool.name.includes('signature')));
  const rawTools = await rawResult(await call({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, 'Bearer oauth-token'));
  assert.equal(rawTools.result.tools.length, 8);
  for (const tool of rawTools.result.tools) assert.deepEqual(tool.securitySchemes, tool._meta.securitySchemes, 'top-level OAuth extensions appear on the wire as well as in SDK-preserved metadata');
  const workspace = await oauth.callTool({ name: 'signhere_workspace', arguments: {} });
  assert.equal(workspace.isError, undefined);
  assert.deepEqual(workspace.structuredContent, { operation: 'workspace', workspace: { name: 'OAuth workspace' } });
  expireDuringExecution = true;
  const expired = await oauth.callTool({ name: 'signhere_get_draft', arguments: { draftId: 'oauthdraft0001' } });
  assert.equal(expired.isError, true);
  assert.match((expired._meta?.['mcp/www_authenticate'] as string[])[0], /resource_metadata=.*error="invalid_token".*error_description=/);
  assert.ok((expired._meta?.['mcp/www_authenticate'] as string[])[0].includes(metadataUrl));
  await assert.rejects(oauth.callTool({ name: 'signhere_workspace', arguments: {} }), /401|Unauthorized|expired|revoked/i, 'the next request rechecks revocation rather than trusting a client session');
  const manual = new Client({ name: 'signhere-manual-test', version: '1' });
  await manual.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), { requestInit: { headers: { Authorization: 'Bearer manual-token' } } }));
  t.after(() => manual.close());
  assert.match(manual.getInstructions()!, /bearer token supplied by the user/);
  assert.ok(!(await manual.listTools()).tools.some(tool => tool._meta?.securitySchemes));
  assert.equal((await manual.callTool({ name: 'signhere_workspace', arguments: {} })).isError, undefined);
  const manualDenied = await call({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'Bearer oauth-token', '/mcp');
  assert.equal(manualDenied.status, 401);
  assert.equal(manualDenied.headers.get('www-authenticate'), 'Bearer realm="Signhere"', 'the manual endpoint does not redirect users into OAuth');
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('real OAuth browser consent issues an MCP-only token with scopes, expiry and revocation', { skip: !databaseUrl }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-oauth-mcp-'));
  const schema = 'oauthmcp_' + uid().replaceAll('-', '');
  const origin = 'http://127.0.0.1:3000';
  const clientId = 'https://chatgpt.com/oauth/client.json';
  const redirectUri = 'https://chatgpt.com/oauth/callback';
  let clock = Date.now();
  const runtime = await createApp({ databaseUrl: databaseUrl!, schema, dataDir, baseUrl: origin, setupToken: 'oauth-mcp-installation-tests-long-enough', legacyCreation: true, rateLimit: false, now: () => clock,
    oauth: { metadataLoader: async () => ({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) },
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE');
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp/oauth`);
  const owner = request.agent(runtime.app);
  const post = (path: string, body: unknown) => owner.post(path).set('Origin', origin).send(body);
  const setup = await post('/api/setup', { setupToken: 'oauth-mcp-installation-tests-long-enough', name: 'Owner', email: 'oauth-owner@example.test', password: 'correct horse battery staple', teamName: 'OAuth workspace' });
  assert.equal(setup.status, 201, setup.text);
  async function authorize(scopes: string[]) {
    const verifier = token();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await owner.get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, resource: origin + '/mcp/oauth', scope: scopes.join(' '), state: token(), code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal(start.status, 302, start.text);
    const pending = new URL(start.headers.location).searchParams.get('request');
    assert.ok(pending);
    const details = await owner.get('/api/oauth/authorization/' + pending);
    assert.equal(details.status, 200, details.text);
    const approval = await post('/api/oauth/authorization/' + pending, { approved: true, expiresInMinutes: 15 });
    assert.equal(approval.status, 200, approval.text);
    const callback = new URL(approval.body.redirectUrl);
    assert.equal(callback.searchParams.get('iss'), origin);
    const exchange = await request(runtime.app).post('/oauth/token').type('form').send({ grant_type: 'authorization_code', client_id: clientId, code: callback.searchParams.get('code'), redirect_uri: redirectUri, resource: origin + '/mcp/oauth', code_verifier: verifier });
    assert.equal(exchange.status, 200, exchange.text);
    assert.match(exchange.body.access_token, /^sho_[A-Za-z0-9_-]{43}$/);
    assert.equal(exchange.body.refresh_token, undefined);
    const client = new Client({ name: 'real-signhere-oauth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: 'Bearer ' + exchange.body.access_token } } }));
    t.after(() => client.close());
    return { client, accessToken: exchange.body.access_token as string };
  }
  const linked = await authorize(['drafts:read', 'drafts:write', 'discussion:read', 'discussion:write']);
  const workspace = await linked.client.callTool({ name: 'signhere_workspace', arguments: {} });
  assert.equal((workspace.structuredContent as any).workspace.name, 'OAuth workspace');
  assert.equal((workspace.structuredContent as any).expiresAt, new Date(clock + 15 * 60000).toISOString());
  const draft = createDraft('realoauthdraft', setup.body.user);
  draft.title = 'Created through linked OAuth MCP';
  const created = await linked.client.callTool({ name: 'signhere_create_draft', arguments: { draft, requestId: uid() } });
  assert.equal(created.isError, undefined);
  assert.equal((created.structuredContent as any).revision, 1);
  assert.equal((await owner.get('/api/drafts/' + draft.id)).body.draft.title, draft.title);
  const saved = await linked.client.callTool({ name: 'signhere_save_draft', arguments: { draftId: draft.id, expectedRevision: 1, requestId: uid() } });
  assert.equal(saved.isError, undefined);
  assert.equal((saved.structuredContent as any).version, 1);
  assert.equal((await request(runtime.app).get('/api/v1/workspace').set('Authorization', 'Bearer ' + linked.accessToken)).status, 401, 'OAuth tokens cannot enter the manual API');
  assert.equal((await owner.get('/api/agent-keys')).body.keys.length, 0, 'linking creates no manual API keys');
  const limited = await authorize(['drafts:read']);
  const forbidden = await limited.client.callTool({ name: 'signhere_create_draft', arguments: { draft: { ...draft, id: 'deniedoauthdraft' }, requestId: uid() } });
  assert.equal(forbidden.isError, true);
  assert.equal((forbidden.structuredContent as any).error.code, 'forbidden');
  const connections = await owner.get('/api/oauth/connections');
  assert.equal(connections.body.connections.length, 2);
  const full = connections.body.connections.find((connection: any) => connection.scopes.includes('drafts:write'));
  assert.ok(full);
  assert.equal((await post('/api/oauth/connections/' + full.id + '/revoke', {})).status, 200);
  await assert.rejects(linked.client.callTool({ name: 'signhere_workspace', arguments: {} }), /expired|revoked|401|Unauthorized/i);
  assert.equal((await limited.client.callTool({ name: 'signhere_workspace', arguments: {} })).isError, undefined, 'revoking one grant does not affect another');
  clock += 15 * 60000;
  await assert.rejects(limited.client.callTool({ name: 'signhere_workspace', arguments: {} }), /expired|revoked|401|Unauthorized/i);
});
