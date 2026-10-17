import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { unzipSync } from 'fflate';
import { draftSchema } from './draft-schema.js';
import { buildAgentSkillPackage, createAgentSkillRouter } from './agent-skill.js';
import { allFields, BUILTIN_FIELDS, contentFields, fieldLabel, fieldValue, type Draft } from '../web/editor/model.js';

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
    const served = await request(app()).get('/skills/signhere/' + path).expect(200).expect('Content-Type', path.endsWith('.json') ? /application\/json/ : /text\/markdown/);
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

function agreement(): Draft {
  const file = buildAgentSkillPackage().files.find(file => file.path === 'examples/service-agreement.json')!;
  return draftSchema.parse(JSON.parse(file.bytes.toString('utf8'))) as Draft;
}

test('documented block and rich-text examples compose into valid editable source', () => {
  const source = agreement();
  for (const file of buildAgentSkillPackage().files.filter(file => file.path.startsWith('references/'))) {
    for (const match of file.bytes.toString('utf8').matchAll(/```json\n([\s\S]+?)\n```/g)) {
      const example = JSON.parse(match[1]);
      const candidate = Array.isArray(example) ? { ...source, blocks: example }
        : example.type === 'doc' ? { ...source, blocks: [{ id: 'rich-example', type: 'text', title: '', content: example }] }
        : example.type === 'field' ? { ...source, blocks: [{ id: 'field-example', type: 'text', title: '', content: { type: 'doc', content: [{ type: 'paragraph', content: [example] }] } }] }
        : example.contacts ? { ...source, company: example }
        : example.version ? example : { ...source, ...example };
      assert.deepEqual(draftSchema.parse(candidate), candidate, file.path);
    }
  }
  assert.deepEqual(new Set(source.blocks.map(block => block.type)), new Set(['header', 'parties', 'text', 'pricing', 'image', 'break', 'terms']));
  assert.equal(source.company, null);
  assert.equal(fieldValue(source, 'custom.hourlyRate'), '');
  assert.match(fieldLabel(source, 'custom.hourlyRate'), /Timpris/);
  const keys = source.blocks.flatMap(block => block.type === 'text' || block.type === 'terms' ? [...contentFields(block.content)] : []);
  assert.equal(keys.filter(key => key === 'custom.hourlyRate').length, 2, 'the rate is reused across body and terms');
  assert.ok(keys.every(key => allFields(source).some(field => field.key === key)), 'every inline field is built-in or registered');
  const richReference = buildAgentSkillPackage().files.find(file => file.path === 'references/rich-text.md')!.bytes.toString('utf8');
  const richExamples = [...richReference.matchAll(/```json\n([\s\S]+?)\n```/g)].map(match => JSON.parse(match[1]));
  assert.deepEqual(richExamples, ['scope', 'delivery-plan'].map(id => {
    const block = source.blocks.find(block => block.id === id)!;
    assert.ok(block.type === 'text');
    return block.content;
  }), 'the documented rich-text shapes must be the ones exercised by the browser fixture');
  const reference = buildAgentSkillPackage().files.find(file => file.path === 'references/draft-format.md')!.bytes.toString('utf8');
  const documentedKeys = [...reference.matchAll(/^\| `(customer\.[\w]+|sender\.[\w]+|document\.[\w]+)` \|/gm)].map(match => match[1]);
  assert.deepEqual(documentedKeys.sort(), BUILTIN_FIELDS.map(field => field.key).sort(), 'the built-in field table must stay complete');
  for (const block of source.blocks) if (block.type === 'pricing') {
    assert.ok(block.packages.every(pkg => pkg.priceForm === 'fixed' && pkg.items.every(item => item.price > 0)), 'the example prices only known fixed charges, never an unknown zero hourly rate');
  }
});

test('field resolution matches the documented company, contact and computed-field fallbacks', () => {
  const source = agreement();
  source.fields['customer.company'] = ' Inline customer ';
  source.fields['customer.name'] = 'Fallback signer';
  assert.equal(fieldValue(source, 'customer.company'), 'Inline customer');
  source.company = { id: 'known-company', name: 'Real supplied company', orgNr: '', address: '', zip: '', city: '', contacts: [
    { id: 'not-signing', name: 'Observer', email: 'observer@example.test', role: '', signs: false },
    { id: 'signing-one', name: 'First signer', email: 'first@example.test', role: '', signs: true },
    { id: 'signing-two', name: 'Second signer', email: 'second@example.test', role: '', signs: true },
  ] };
  assert.equal(fieldValue(source, 'customer.company'), 'Real supplied company');
  assert.equal(fieldValue(source, 'customer.name'), 'First signer');
  assert.equal(fieldValue(source, 'customer.email'), 'first@example.test');
  source.company.name = '   ';
  assert.equal(fieldValue(source, 'customer.company'), '', 'fallback is selected before trimming');
  source.company.name = '';
  assert.equal(fieldValue(source, 'customer.company'), 'Inline customer');
  source.company.contacts.forEach(contact => { contact.signs = false; });
  assert.equal(fieldValue(source, 'customer.name'), 'Fallback signer');
  source.fields['custom.hourlyRate'] = ' 1250 ';
  assert.equal(fieldValue(source, 'custom.hourlyRate'), '1250');
  assert.equal(fieldValue(source, 'unknown.key'), '');
  source.frozenAt = new Date(2026, 9, 16, 12).toISOString();
  source.fields['document.title'] = 'Ignored';
  source.fields['document.sentAt'] = 'Ignored';
  assert.equal(fieldValue(source, 'document.title'), source.title);
  assert.equal(fieldValue(source, 'document.sentAt'), '16 oktober 2026');
  assert.equal(fieldValue(source, 'document.expiresAt'), '15 november 2026');
});
