import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicBankIdMethod, ticBankIdConfigFromEnv, TicBankIdError } from './tic-bankid.js';
import { BANKID_CONSENT, bankIdQrData, signedBinding, visibleText } from './bankid-shared.js';
import { CONSENT, type SignatureContext } from './plugins.js';

const context: SignatureContext = {
  documentId: '0b8f7c1e-2c4f-4c7e-9f5e-1d2a3b4c5d6e', documentHash: 'a'.repeat(64), recipientId: '5f0e1d2c-3b4a-4958-8776-655443322110',
  name: 'Test Testsson', consent: BANKID_CONSENT, documentTitle: 'Hyresavtal *Storgatan* 1', signingIntentHash: 'b'.repeat(64),
  endUserIp: '192.0.2.10', userAgent: 'Test browser',
};
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const signatureXml = (nonVisible: string, visible: string) => b64('<?xml version="1.0" encoding="UTF-8"?><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><Object>'
  + '<bankIdSignedData xmlns="http://www.bankid.com/signature/v1.0.0/types" Id="bidSignedData"><usrVisibleData charset="UTF-8" visible="wysiwys">' + b64(visible)
  + '</usrVisibleData><usrNonVisibleData>' + b64(nonVisible) + '</usrNonVisibleData><srvInfo/></bankIdSignedData></Object></Signature>');
const user = { personalNumber: '199001011234', givenName: 'Test', surname: 'Testsson', name: 'Test Testsson' };

function fake(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? assert.fail('Unexpected TIC request');
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, method: createTicBankIdMethod({ apiKey: 'secret-api-key', fetch }) };
}

test('animated QR data matches the BankID reference vector', () => {
  assert.equal(bankIdQrData('67df3917-fa0d-44e5-b327-edcc928297f8', 'd28db9a7-4cde-429e-a983-359be676944c', 0),
    'bankid.67df3917-fa0d-44e5-b327-edcc928297f8.0.dc69358e712458a66a7525beef148ae8526b1c71610eff2c16cdffb4cdac9bf8');
});

test('begin starts a sign order bound to the frozen intent and keeps the QR secret server-side', async () => {
  const { calls, method } = fake([{ body: { sessionId: 'sess-1', orderRef: 'order-1', autoStartToken: 'auto-1', qrStartToken: 'qr-1', qrStartSecret: 'qr-secret', sessionExpiresAt: '2026-09-24T12:05:00Z' } }]);
  const started = await method.begin(context);
  assert.equal(calls[0].url, 'https://id.tic.io/api/v1/auth/bankid/sign');
  assert.equal((calls[0].init.headers as Record<string, string>)['X-Api-Key'], 'secret-api-key');
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.userNonVisibleData, signedBinding(context));
  assert.equal(body.userVisibleDataFormat, 'simpleMarkdownV1');
  assert.match(body.userVisibleData, /Dokument: Hyresavtal Storgatan 1/);
  assert.match(body.userVisibleData, new RegExp('SHA-256: ' + 'a'.repeat(64)));
  assert.equal(body.endUserIp, '192.0.2.10');
  assert.deepEqual(started.client, { attemptId: 'sess-1', autoStartToken: 'auto-1', expiresAt: '2026-09-24T12:05:00Z' });
  assert.ok(!JSON.stringify(started.client).includes('qr-secret'));
  assert.equal(started.persist.qrStartSecret, 'qr-secret');
});

test('begin refuses contexts that cannot be bound safely', async () => {
  const { calls, method } = fake([]);
  await assert.rejects(method.begin({ ...context, consent: CONSENT }), /BankID consent/);
  await assert.rejects(method.begin({ ...context, endUserIp: undefined }), /IP address/);
  await assert.rejects(method.begin({ ...context, signingIntentHash: undefined }), /signing intent/);
  assert.equal(calls.length, 0);
});

test('complete reports pending orders with the BankID hint', async () => {
  const { calls, method } = fake([{ body: { status: 'pending', hintCode: 'userSign' } }]);
  const result = await method.complete(context, { attemptId: 'sess-1' });
  assert.equal(calls[0].url, 'https://id.tic.io/api/v1/auth/sess-1/poll');
  assert.equal(result.status, 'pending');
  assert.equal(result.status === 'pending' && result.providerEvidence.hintCode, 'userSign');
});

test('complete accepts a signature over this exact binding and retains the raw proof', async () => {
  const signature = signatureXml(signedBinding(context), visibleText(context));
  const { method } = fake([{ body: { status: 'complete', user, signature: { value: signature, ocspResponse: b64('ocsp') }, completedAt: '2026-09-24T12:01:00Z' } }]);
  const result = await method.complete(context, { attemptId: 'sess-1' });
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') return;
  assert.equal(result.providerEvidence.identityVerified, true);
  assert.deepEqual(result.providerEvidence.user, user);
  assert.equal(result.rawProof?.signatureBase64, signature);
  assert.ok(Buffer.byteLength(JSON.stringify(result.providerEvidence)) < 16384);
});

test('complete rejects a completed order signed for another recipient or document', async () => {
  for (const other of [{ ...context, recipientId: 'another-recipient' }, { ...context, documentHash: 'c'.repeat(64) }]) {
    const { method } = fake([{ body: { status: 'complete', user, signature: { value: signatureXml(signedBinding(other), visibleText(other)), ocspResponse: b64('ocsp') } } }]);
    assert.deepEqual(await method.complete(context, { attemptId: 'sess-1' }), { status: 'failed', reason: 'BankID-signaturen gäller inte detta dokument.' });
  }
});

test('complete maps cancellation and rejects unknown states', async () => {
  const { method } = fake([{ body: { status: 'failed', hintCode: 'userCancel' } }, { body: { status: 'failed', hintCode: 'expiredTransaction' } }, { body: { status: 'complete', user } }]);
  assert.equal((await method.complete(context, { attemptId: 'sess-1' })).status, 'cancelled');
  assert.equal((await method.complete(context, { attemptId: 'sess-1' })).status, 'failed');
  await assert.rejects(method.complete(context, { attemptId: 'sess-1' }), TicBankIdError);
  await assert.rejects(method.complete(context, { attemptId: '../admin' }));
});

test('provider errors expose the TIC error code but not the API key', async () => {
  const { method } = fake([{ status: 400, body: { error: { code: 'invalid_request', message: 'Missing required parameter: endUserIp' } } }]);
  const error = await method.begin(context).catch(error => error);
  assert.ok(error instanceof TicBankIdError);
  assert.equal(error.code, 'invalid_request');
  assert.ok(!String(error.message).includes('secret-api-key'));
});

test('configuration requires an API key and an https endpoint', () => {
  assert.equal(ticBankIdConfigFromEnv({}), undefined);
  assert.deepEqual(ticBankIdConfigFromEnv({ TIC_API_KEY: ' key ' }), { apiKey: 'key', baseUrl: 'https://id.tic.io/api/v1/' });
  assert.throws(() => ticBankIdConfigFromEnv({ TIC_API_KEY: 'key', TIC_BASE_URL: 'http://id.tic.io/api/v1/' }), /https/);
});
