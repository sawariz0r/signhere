import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import {
  Client, StreamableHTTPClientTransport, type OAuthClientProvider,
  type StoredOAuthClientInformation, type StoredOAuthTokens, type OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
import { createApp } from './app.js';
import { uid } from './db.js';
import { createDraft, templateBlocks } from '../web/editor/model.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const clientId = 'https://chatgpt.com/oauth/client.json';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';

test('official SDK completes registration-free OAuth discovery, issuer validation, PKCE and document access', { skip: !databaseUrl }, async t => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const schema = 'oauth_sdk_' + uid().replaceAll('-', '');
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-oauth-sdk-'));
  const setupToken = 'oauth-sdk-disposable-installation-secret';
  const runtime = await createApp({
    databaseUrl: databaseUrl!, schema, dataDir, baseUrl: origin, setupToken,
    legacyCreation: true, rateLimit: false,
    oauth: { metadataLoader: async url => {
      assert.equal(url, clientId);
      // ChatGPT's real metadata declares a legacy preference as well as its
      // accepted methods. The negotiated public-client method remains valid.
      return { client_id: clientId, redirect_uris: [redirectUri], client_name: 'ChatGPT',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
    } },
  });
  t.after(async () => {
    await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE');
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  server.on('request', runtime.app);
  const browser = request.agent(runtime.app);
  const owner = await browser.post('/api/setup').set('Origin', origin).send({
    setupToken, name: 'SDK Owner', email: 'oauth-sdk@example.test',
    password: 'disposable correct horse password', teamName: 'SDK Workspace',
  });
  assert.equal(owner.status, 201, owner.text);

  let clientInfo: StoredOAuthClientInformation | undefined;
  let tokens: StoredOAuthTokens | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let verifier = '';
  let authorizationUrl: URL | undefined;
  const state = uid();
  const network: string[] = [];
  const provider: OAuthClientProvider = {
    redirectUrl: redirectUri, clientMetadataUrl: clientId,
    clientMetadata: { redirect_uris: [redirectUri], client_name: 'ChatGPT',
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] },
    state: () => state,
    clientInformation: () => clientInfo,
    saveClientInformation: value => { clientInfo = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    redirectToAuthorization: url => { authorizationUrl = url; },
    discoveryState: () => discovery,
    saveDiscoveryState: value => { discovery = value; },
  };
  const makeTransport = () => new StreamableHTTPClientTransport(new URL('/mcp/oauth', origin), {
    authProvider: provider,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, origin, 'the SDK only contacts this Signhere installation');
      network.push((init?.method ?? 'GET') + ' ' + url.pathname);
      return fetch(input, init);
    },
  });
  const initial = new Client({ name: 'signhere-oauth-discovery-test', version: '1' });
  t.after(() => initial.close());
  const transport = makeTransport();
  await assert.rejects(initial.connect(transport), /unauthorized|authorization|authenticate/i);
  assert.ok(authorizationUrl, 'the SDK discovers OAuth and asks the human to authorize');
  const authorize: URL = authorizationUrl;
  assert.equal(authorize.origin, origin);
  assert.equal(authorize.pathname, '/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), clientId);
  assert.equal(authorize.searchParams.get('resource'), origin + '/mcp/oauth');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(clientInfo?.client_id, clientId, 'CIMD identifies the client without registration');
  assert.equal(tokens, undefined, 'discovery and an existing login do not grant access');

  const landing = await browser.get(authorize.pathname + authorize.search);
  assert.equal(landing.status, 302, landing.text);
  const pending = new URL(landing.headers.location).searchParams.get('request');
  assert.ok(pending);
  const details = await browser.get('/api/oauth/authorization/' + pending);
  assert.equal(details.status, 200, details.text);
  assert.equal(details.body.workspace.name, 'SDK Workspace');
  assert.deepEqual(details.body.scopes, authorize.searchParams.get('scope')!.split(' '));
  const consent = await browser.post('/api/oauth/authorization/' + pending).set('Origin', origin)
    .send({ approved: true, expiresInMinutes: 15 });
  assert.equal(consent.status, 200, consent.text);
  const callback = new URL(consent.body.redirectUrl);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), state);
  assert.equal(callback.searchParams.get('iss'), origin);
  const wrongIssuer = new URLSearchParams(callback.searchParams);
  wrongIssuer.set('iss', 'https://different-instance.example');
  await assert.rejects(transport.finishAuth(wrongIssuer), /issuer/i);
  assert.equal(tokens, undefined, 'an issuer mismatch is rejected before token exchange');
  await transport.finishAuth(callback.searchParams);
  assert.ok(tokens);
  assert.equal('refresh_token' in tokens, false, 'access is fixed-duration with human reconnection');
  await initial.close();

  const client = new Client({ name: 'signhere-oauth-document-test', version: '1' });
  t.after(() => client.close());
  await client.connect(makeTransport());
  const workspace = await client.callTool({ name: 'signhere_workspace', arguments: {} });
  assert.equal(workspace.isError, undefined);
  assert.equal((workspace.structuredContent?.workspace as { name: string }).name, 'SDK Workspace');
  const draft = createDraft(uid().replaceAll('-', '').slice(0, 16), owner.body.user);
  draft.title = 'Created through registration-free OAuth';
  draft.blocks = templateBlocks('agreement');
  const args = { draft, requestId: uid() };
  const created = await client.callTool({ name: 'signhere_create_draft', arguments: args });
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
  const retried = await client.callTool({ name: 'signhere_create_draft', arguments: args });
  assert.deepEqual(retried.structuredContent, created.structuredContent);
  assert.equal((await runtime.db.query('SELECT count(*) FROM drafts')).rows[0].count, '1');
  assert.equal((await browser.get('/api/agent-keys')).body.keys.length, 0, 'OAuth grants are separate from manual keys');
  const connections = await browser.get('/api/oauth/connections');
  assert.equal(connections.body.connections.length, 1);
  const revoked = await browser.post('/api/oauth/connections/' + connections.body.connections[0].id + '/revoke').set('Origin', origin).send({});
  assert.equal(revoked.status, 200, revoked.text);
  const denied = await fetch(origin + '/mcp/oauth', { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens.access_token,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate')!, /resource_metadata=/);
  assert.ok(network.includes('GET /.well-known/oauth-protected-resource/mcp/oauth'));
  assert.ok(network.includes('GET /.well-known/oauth-authorization-server'));
  assert.ok(network.includes('POST /oauth/token'));
  assert.ok(!network.some(path => /register|registration/.test(path)), 'no client registration request occurs');
});
