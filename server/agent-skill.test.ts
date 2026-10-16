import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { unzipSync } from 'fflate';
import { draftSchema } from './draft-schema.js';
import { buildAgentSkillPackage, createAgentSkillRouter } from './agent-skill.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function app() { const app = express(); app.use('/skills/signhere', createAgentSkillRouter()); return app; }

test('downloadable skill package is deterministic and manifest verifies the exact archive and extracted files', async () => {
  const first = buildAgentSkillPackage(), second = buildAgentSkillPackage();
  assert.deepEqual(first.archive, second.archive);
  const response = await request(app()).get('/skills/signhere/signhere.zip').buffer(true).parse((res, done) => {
    const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
  }).expect(200).expect('Content-Type', /application\/zip/).expect('Content-Disposition', /attachment/);
  const manifest = (await request(app()).get('/skills/signhere/manifest.json').expect(200)).body;
  assert.equal(hash(response.body), manifest.packageSha256);
  const extracted = unzipSync(response.body);
  assert.deepEqual(Object.keys(extracted).sort(), Object.keys(manifest.files).map(path => 'signhere/' + path).sort());
  for (const [path, entry] of Object.entries(manifest.files) as [string, { sha256: string; bytes: number }][]) {
    const bytes = extracted['signhere/' + path];
    assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.bytes);
    const served = await request(app()).get('/skills/signhere/' + path).expect(200).expect('Content-Type', /text\/markdown/);
    assert.equal(hash(Buffer.from(served.text)), entry.sha256);
  }
  const skill = Buffer.from(extracted['signhere/SKILL.md']).toString('utf8');
  assert.equal(skill.match(/version: "([\d.]+)"/)?.[1], manifest.version);
  assert.deepEqual(manifest.compatibleApiVersions, ['v1']);
});

test('public skill URLs stay relative under hostile request headers and unknown files are rejected', async () => {
  const response = await request(app()).get('/skills/signhere/manifest.json').set('Host', 'attacker.example').set('X-Forwarded-Host', 'attacker.example').expect(200).expect('Cache-Control', 'no-cache');
  for (const key of ['skillUrl', 'packageUrl', 'changelogUrl']) assert.match(response.body[key], /^\/skills\/signhere\//);
  assert.equal(JSON.stringify(response.body).includes('attacker.example'), false);
  await request(app()).get('/skills/signhere/missing.md').expect(404).expect('Content-Type', /json/);
  await request(app()).get('/skills/signhere/%2e%2e%2fmanifest.json').expect(404);
});

test('portable draft example is accepted by the actual editor source schema', () => {
  const reference = buildAgentSkillPackage().files.find(file => file.path === 'references/draft-format.md')!.bytes.toString('utf8');
  const example = JSON.parse(reference.match(/```json\n([\s\S]+?)\n```/)![1]);
  assert.equal(draftSchema.safeParse(example).success, true);
});
