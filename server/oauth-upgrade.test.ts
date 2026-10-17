import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from './app.js';
import { uid } from './db.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('schema 9 upgrades preserve existing manual credentials, sessions and audit history', { skip: !databaseUrl }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'signhere-oauth-upgrade-'));
  const schema = 'oauth_upgrade_' + uid().replaceAll('-', '');
  const origin = 'http://localhost:3000';
  const config = { databaseUrl: databaseUrl!, schema, dataDir, baseUrl: origin,
    setupToken: 'oauth-upgrade-disposable-installation-key', legacyCreation: true, rateLimit: false };
  let runtime = await createApp(config);
  t.after(async () => {
    await runtime.db.query('DROP SCHEMA "' + schema + '" CASCADE');
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const owner = request.agent(runtime.app);
  const setup = await owner.post('/api/setup').set('Origin', origin).send({
    setupToken: config.setupToken, name: 'Existing Owner', email: 'upgrade@example.test',
    password: 'existing disposable password', teamName: 'Existing Workspace',
  });
  assert.equal(setup.status, 201, setup.text);
  const session = setup.headers['set-cookie'][0].split(';')[0];
  const issued = await owner.post('/api/agent-keys').set('Origin', origin)
    .send({ name: 'Existing manual key', scopes: ['drafts:read'], expiresInMinutes: 1440 });
  assert.equal(issued.status, 201, issued.text);
  const audit = (await runtime.db.query('SELECT * FROM agent_audit ORDER BY id')).rows;
  const oldKey = (await runtime.db.query('SELECT token_hash,expires_at,created_at FROM agent_keys WHERE id=$1', [issued.body.key.id])).rows[0];
  // Restore precisely the schema-9 credential shape with an existing key,
  // session and immutable audit row. Only the disposable test schema is changed.
  await runtime.db.query(`
    DROP TABLE oauth_pending,oauth_codes,oauth_access_tokens;
    ALTER TABLE agent_keys DROP COLUMN kind,DROP COLUMN resource,DROP COLUMN client_id;
    DELETE FROM migrations WHERE version=10;
  `);
  await runtime.close();
  runtime = await createApp(config);
  assert.equal((await runtime.db.query('SELECT max(version) AS version FROM migrations')).rows[0].version, 10);
  const current = (await runtime.db.query('SELECT token_hash,expires_at,created_at,kind FROM agent_keys WHERE id=$1', [issued.body.key.id])).rows[0];
  assert.equal(current.kind, 'manual');
  assert.deepEqual({ token_hash: current.token_hash, expires_at: current.expires_at, created_at: current.created_at }, oldKey);
  assert.deepEqual((await runtime.db.query('SELECT * FROM agent_audit ORDER BY id')).rows, audit);
  const workspace = await request(runtime.app).get('/api/v1/workspace').set('Authorization', 'Bearer ' + issued.body.token);
  assert.equal(workspace.status, 200, workspace.text);
  assert.equal(workspace.body.workspace.name, 'Existing Workspace');
  assert.equal(workspace.body.expiresAt, issued.body.key.expiresAt);
  const keys = await request(runtime.app).get('/api/agent-keys').set('Cookie', session);
  assert.equal(keys.status, 200, keys.text);
  assert.equal(keys.body.keys[0].id, issued.body.key.id);
  assert.equal((await request(runtime.app).get('/api/oauth/connections').set('Cookie', session)).body.connections.length, 0);
});
