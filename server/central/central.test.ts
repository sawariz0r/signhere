import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { centralFixture, centralOrigin, registerInstance, capabilityToken, sha256, lastCode, trustFixture } from './test-support.js';
import { CENTRAL_CONSENT, RECEIPT_TYP, base64url, fromBase64url, parseJws, receiptMismatches, utf8, verifyReceipt, verifyTrustBundle, canonicalJson } from './protocol.js';
import { generateSigner, newBundle, signJws, signTrustBundle, trustKey } from './keys.js';

const instanceOrigin = 'http://localhost:3000';
function approvalBody(overrides: Record<string, unknown> = {}, capability = capabilityToken()) {
  return {
    body: {
      documentId: '11111111-1111-4111-8111-111111111111', revisionId: '11111111-1111-4111-8111-111111111111', recipientId: '22222222-2222-4222-8222-222222222222',
      email: 'Anna@Example.test', name: 'Anna Andersson', title: 'Avtal', preparedSha256: 'a'.repeat(64), preparedSize: 1234,
      intentSha256: 'b'.repeat(64), policySha256: 'c'.repeat(64), participantCapabilitySha256: sha256(capability),
      documentUrl: instanceOrigin + '/api/central/prepared/x', returnUrl: instanceOrigin + '/sign', expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ...overrides,
    }, capability,
  };
}
async function setup(t: Parameters<typeof centralFixture>[0]) {
  const f = await centralFixture(t);
  const instance = await registerInstance(f.pool);
  const api = (method: 'get' | 'post', path: string, body?: unknown, key = instance.apiKey) => {
    const call = request(f.app)[method](path).set('Authorization', 'Bearer ' + key);
    return body === undefined ? call : call.send(body);
  };
  const participant = (method: 'get' | 'post', path: string, approvalId: string, capability: string, body?: unknown) => {
    const call = request(f.app)[method](path).set('Authorization', 'Capability ' + approvalId + '.' + capability).set('Origin', centralOrigin);
    return body === undefined ? call : call.send(body);
  };
  return { ...f, instance, api, participant };
}

test('trust bundles and receipts are strict, domain-separated JWS values', async () => {
  const trust = await trustFixture();
  // Root pinning: another root cannot vouch for the bundle, and a service key cannot sign bundles.
  const other = await generateSigner();
  await assert.rejects(verifyTrustBundle(trust.trustBundle.jws, other.signer.publicKey), /bundle_root_mismatch/);
  const forged = await signTrustBundle(other.signer, trust.trustBundle.bundle);
  await assert.rejects(verifyTrustBundle(forged, trust.root.publicKey), /bundle_root_mismatch/);
  // Tampered payload, trailing whitespace and non-canonical JSON fail.
  const [h, p, s] = trust.trustBundle.jws.split('.');
  const tampered = base64url(utf8(canonicalJson({ ...trust.trustBundle.bundle, sequence: 2 })));
  await assert.rejects(verifyTrustBundle([h, tampered, s].join('.'), trust.root.publicKey), /bundle_signature_invalid/);
  const spaced = base64url(utf8(JSON.stringify(trust.trustBundle.bundle, null, 1)));
  await assert.rejects(verifyTrustBundle([h, spaced, s].join('.'), trust.root.publicKey), /non_canonical_json/);
  assert.throws(() => fromBase64url(p + '='), /invalid_base64url/);
  // A bundle JWS is never accepted as a receipt and vice versa.
  assert.throws(() => parseJws(trust.trustBundle.jws, RECEIPT_TYP), /jws_type/);
  // An extra header member (e.g. an embedded key) is rejected.
  const header = base64url(utf8(canonicalJson({ alg: 'EdDSA', jwk: {}, kid: trust.receiptSigner.kid, typ: RECEIPT_TYP })));
  assert.throws(() => parseJws([header, p, s].join('.'), RECEIPT_TYP), /jws_header/);
});

test('an installation cannot mint, alter or reuse approval evidence', async t => {
  const f = await setup(t);
  const { body, capability } = approvalBody();
  const created = await f.api('post', '/v1/approvals', body);
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.status, 'pending');
  const id = created.body.approvalId;
  // Identical retry is idempotent; a changed request for the same assignment conflicts.
  assert.equal((await f.api('post', '/v1/approvals', body)).body.approvalId, id);
  assert.equal((await f.api('post', '/v1/approvals', { ...body, preparedSha256: 'd'.repeat(64) })).status, 409);
  // The installation cannot set confirmation flags or supply extra fields.
  assert.equal((await f.api('post', '/v1/approvals', { ...body, recipientId: 'x2', emailVerified: true })).status, 400);
  // Documents are fetched by the participant's browser from the registered origin only.
  assert.equal((await f.api('post', '/v1/approvals', { ...body, recipientId: 'x3', documentUrl: 'https://evil.example/pdf' })).status, 400);
  // The installation key cannot drive participant steps: the capability hash is all it gave us.
  assert.equal((await request(f.app).post('/v1/participant/approve').set('Authorization', 'Bearer ' + f.instance.apiKey).set('Origin', centralOrigin).send({})).status, 401);
  // Approval requires a confirmed email first.
  const approve = { preparedSha256: 'a'.repeat(64), consentVersion: CENTRAL_CONSENT.version, accepted: true, documentSource: 'installation-transfer' };
  assert.equal((await f.participant('post', '/v1/participant/approve', id, capability, approve)).status, 409);
  // Another tenant sees nothing.
  const other = await registerInstance(f.pool, 'http://localhost:4000');
  assert.equal((await f.api('get', '/v1/approvals/' + id, undefined, other.apiKey)).status, 404);
  assert.equal((await f.api('post', '/v1/approvals/' + id + '/cancel', {}, other.apiKey)).status, 404);
});

test('email confirmation and approval are separate, bounded, and produce one stable receipt', async t => {
  const f = await setup(t);
  const { body, capability } = approvalBody();
  const id = (await f.api('post', '/v1/approvals', body)).body.approvalId;
  // Wrong capability and GET requests never change state.
  assert.equal((await f.participant('get', '/v1/participant/session', id, capabilityToken())).status, 404);
  const session = await f.participant('get', '/v1/participant/session', id, capability);
  assert.equal(session.status, 200);
  assert.equal(session.body.email, 'anna@example.test');
  assert.equal(session.body.installation.verifiedOrganisation, false);
  // Cross-origin POSTs are refused.
  assert.equal((await request(f.app).post('/v1/participant/code').set('Authorization', 'Capability ' + id + '.' + capability).set('Origin', 'https://evil.example').send({})).status, 403);
  assert.equal((await f.participant('post', '/v1/participant/code', id, capability, {})).status, 200);
  assert.equal(f.mailer.sent.length, 1);
  assert.equal(f.mailer.sent[0].to, 'anna@example.test');
  // Cooldown before a new code.
  assert.equal((await f.participant('post', '/v1/participant/code', id, capability, {})).status, 429);
  const code = lastCode(f.mailer);
  const wrong = code === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 5; i++) assert.equal((await f.participant('post', '/v1/participant/confirm', id, capability, { code: wrong })).status, 400);
  // The attempt limit also blocks the right code; a new code is needed.
  assert.equal((await f.participant('post', '/v1/participant/confirm', id, capability, { code })).status, 429);
  await f.pool.query('UPDATE email_challenges SET sent_at=sent_at - interval \'1 minute\'');
  assert.equal((await f.participant('post', '/v1/participant/code', id, capability, {})).status, 200);
  const confirmed = await f.participant('post', '/v1/participant/confirm', id, capability, { code: lastCode(f.mailer) });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.body.status, 'email_confirmed');
  // Approval binds the digest the participant's browser computed.
  const approve = { preparedSha256: 'e'.repeat(64), consentVersion: CENTRAL_CONSENT.version, accepted: true, documentSource: 'installation-transfer' };
  assert.equal((await f.participant('post', '/v1/participant/approve', id, capability, approve)).status, 409);
  const results = await Promise.all([1, 2, 3].map(() => f.participant('post', '/v1/participant/approve', id, capability, { ...approve, preparedSha256: 'a'.repeat(64) })));
  for (const result of results) assert.equal(result.status, 200, result.text);
  const receipts = new Set(results.map(result => result.body.receipt));
  assert.equal(receipts.size, 1, 'concurrent approvals yield one receipt');
  const [receipt] = receipts;
  const polled = await f.api('get', '/v1/approvals/' + id);
  assert.equal(polled.body.status, 'approved');
  assert.equal(polled.body.receipt, receipt);
  const verified = await verifyReceipt(receipt, f.trust.trustBundle.bundle);
  assert.equal(verified.keyTrust, 'trusted');
  assert.equal(verified.receipt.email.address, 'anna@example.test');
  assert.equal(verified.receipt.claims.nameVerified, false);
  assert.equal(verified.receipt.assurance.civilIdentityVerified, false);
  assert.deepEqual(receiptMismatches(verified.receipt, {
    service: centralOrigin, instanceId: f.instance.instanceId, documentId: body.documentId, revisionId: body.revisionId, recipientId: body.recipientId,
    preparedSha256: body.preparedSha256, preparedSize: body.preparedSize, intentSha256: body.intentSha256, policySha256: body.policySha256, email: body.email,
  }), []);
  assert.deepEqual(receiptMismatches(verified.receipt, {
    service: centralOrigin, instanceId: 'ins_other', documentId: body.documentId, revisionId: 'r2', recipientId: 'someone-else',
    preparedSha256: 'f'.repeat(64), preparedSize: body.preparedSize, intentSha256: body.intentSha256, policySha256: body.policySha256, email: 'x@example.test',
  }), ['instance', 'revision', 'recipient', 'prepared_hash', 'email']);
  // Closed approvals are immutable, even to the database role.
  await assert.rejects(f.pool.query("UPDATE approvals SET receipt='x' WHERE id=$1", [id]), /immutable/);
  assert.equal((await f.api('post', '/v1/approvals/' + id + '/cancel', {})).body.status, 'approved');
});

test('receipts from unknown, retired-after, revoked or other-service keys are not trusted', async t => {
  const f = await setup(t);
  const { body, capability } = approvalBody();
  const id = (await f.api('post', '/v1/approvals', body)).body.approvalId;
  await f.participant('post', '/v1/participant/code', id, capability, {});
  await f.participant('post', '/v1/participant/confirm', id, capability, { code: lastCode(f.mailer) });
  const receipt = (await f.participant('post', '/v1/participant/approve', id, capability, { preparedSha256: 'a'.repeat(64), consentVersion: CENTRAL_CONSENT.version, accepted: true, documentSource: 'local-file' })).body.receipt;
  const bundle = f.trust.trustBundle.bundle;
  assert.equal((await verifyReceipt(receipt, { ...bundle, keys: [] })).keyTrust, 'unknown-key');
  assert.equal((await verifyReceipt(receipt, { ...bundle, service: 'https://other.example' })).keyTrust, 'wrong-service');
  assert.equal((await verifyReceipt(receipt, { ...bundle, keys: bundle.keys.map(key => ({ ...key, status: 'revoked' as const, revokedAt: '2020-01-02T00:00:00.000Z' })) })).keyTrust, 'revoked');
  assert.equal((await verifyReceipt(receipt, { ...bundle, keys: bundle.keys.map(key => ({ ...key, status: 'retired' as const, validUntil: '2020-01-02T00:00:00.000Z' })) })).keyTrust, 'outside-validity');
  // A self-issued key with a forged payload does not verify against the real bundle.
  const attacker = await generateSigner();
  const forged = await signJws(attacker.signer, RECEIPT_TYP, parseJws(receipt, RECEIPT_TYP).payload);
  assert.equal((await verifyReceipt(forged, bundle)).keyTrust, 'unknown-key');
  // Same kid, different key: signature fails.
  const [h, p] = forged.split('.');
  const reKeyed = [receipt.split('.')[0], p, forged.split('.')[2]].join('.');
  await assert.rejects(verifyReceipt(reKeyed, bundle), /receipt_signature_invalid/);
  void h;
});

test('expiry, cancellation, suspension and retention', async t => {
  let clock = Date.now();
  const f = await centralFixture(t, { now: () => clock });
  const instance = await registerInstance(f.pool);
  const { body, capability } = approvalBody({ expiresAt: new Date(clock + 3600000).toISOString() });
  const id = (await request(f.app).post('/v1/approvals').set('Authorization', 'Bearer ' + instance.apiKey).send(body)).body.approvalId;
  const participant = (path: string, payload?: unknown) => payload === undefined
    ? request(f.app).get(path).set('Authorization', 'Capability ' + id + '.' + capability)
    : request(f.app).post(path).set('Authorization', 'Capability ' + id + '.' + capability).set('Origin', centralOrigin).send(payload);
  clock += 2 * 3600000;
  assert.equal((await participant('/v1/participant/session')).body.status, 'expired');
  assert.equal((await participant('/v1/participant/code', {})).status, 410);
  // Suspension blocks new use.
  const { setInstanceStatus } = await import('./app.js');
  await setInstanceStatus(f.pool, instance.instanceId, 'suspended');
  assert.equal((await request(f.app).post('/v1/approvals').set('Authorization', 'Bearer ' + instance.apiKey).send(approvalBody({ recipientId: 'r9', expiresAt: new Date(clock + 3600000).toISOString() }).body)).status, 403);
  clock += 31 * 86400000;
  assert.equal(await f.cleanup(), 1);
  assert.equal((await participant('/v1/participant/session')).status, 404);
});

test('trust bundle is published with its root, and rotation keeps old keys verifiable', async () => {
  const trust = await trustFixture();
  const next = await generateSigner();
  const rotated = newBundle(trust.trustBundle.bundle.service, 2, [
    { ...trust.trustBundle.bundle.keys[0], status: 'retired', validUntil: '2030-01-01T00:00:00.000Z' }, trustKey(next.signer, '2030-01-01T00:00:00.000Z'),
  ]);
  const verified = await verifyTrustBundle(await signTrustBundle(trust.root, rotated), trust.root.publicKey);
  assert.equal(verified.keys.length, 2);
  await assert.rejects(signTrustBundle(trust.root, newBundle(rotated.service, 3, [trustKey(trust.root, '2030-01-01T00:00:00.000Z')])), /trust root/);
});
