import test from 'node:test';
import assert from 'node:assert/strict';
import { bankIdConfigFromEnv, BankIdError, createBankIdMethod, mtlsTransport, type BankIdTransport } from './bankid.js';
import { BANKID_CONSENT, signedBinding, visibleText } from './bankid-shared.js';
import { CONSENT, type SignatureContext } from './plugins.js';

const context: SignatureContext = {
  documentId: '0b8f7c1e-2c4f-4c7e-9f5e-1d2a3b4c5d6e', documentHash: 'a'.repeat(64), recipientId: '5f0e1d2c-3b4a-4958-8776-655443322110',
  name: 'Test Testsson', consent: BANKID_CONSENT, documentTitle: 'Hyresavtal', signingIntentHash: 'b'.repeat(64),
  endUserIp: '192.0.2.10', userAgent: 'Test browser',
};
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const unb64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');
const signatureXml = (nonVisible: string, visible: string) => b64('<?xml version="1.0" encoding="UTF-8"?><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><Object>'
  + '<bankIdSignedData xmlns="http://www.bankid.com/signature/v1.0.0/types" Id="bidSignedData"><usrVisibleData charset="UTF-8" visible="wysiwys">' + b64(visible)
  + '</usrVisibleData><usrNonVisibleData>' + b64(nonVisible) + '</usrNonVisibleData><srvInfo/></bankIdSignedData></Object></Signature>');
const completion = (signature: string) => ({
  user: { personalNumber: '199001011234', name: 'Test Testsson', givenName: 'Test', surname: 'Testsson' },
  device: { ipAddress: '192.0.2.10', uhi: 'OZvYM9VvyiAmG7NA5jU5zqGcVpo=' }, bankIdIssueDate: '2026-01-15', signature, ocspResponse: b64('ocsp'),
});

function fake(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: BankIdTransport = async (path, body) => {
    calls.push({ path, body });
    const next = responses.shift() ?? assert.fail('Unexpected BankID request');
    return { status: next.status ?? 200, body: next.body };
  };
  return { calls, method: createBankIdMethod({ transport, referringDomain: 'sign.example.test' }) };
}

test('begin sends base64 visible text and binding and keeps the QR secret server-side', async () => {
  const { calls, method } = fake([{ body: { orderRef: 'order-1', autoStartToken: 'auto-1', qrStartToken: 'qr-1', qrStartSecret: 'qr-secret' } }]);
  const started = await method.begin(context);
  assert.equal(calls[0].path, 'sign');
  assert.equal(unb64(calls[0].body.userNonVisibleData as string), signedBinding(context));
  assert.equal(unb64(calls[0].body.userVisibleData as string), visibleText(context));
  assert.equal(calls[0].body.userVisibleDataFormat, 'simpleMarkdownV1');
  assert.deepEqual(calls[0].body.web, { referringDomain: 'sign.example.test', userAgent: 'Test browser' });
  assert.deepEqual(started.client, { attemptId: 'order-1', autoStartToken: 'auto-1' });
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

test('complete reports pending orders and maps failures', async () => {
  const { calls, method } = fake([
    { body: { orderRef: 'order-1', status: 'pending', hintCode: 'outstandingTransaction' } },
    { body: { orderRef: 'order-1', status: 'failed', hintCode: 'userCancel' } },
    { body: { orderRef: 'order-1', status: 'failed', hintCode: 'certificateErr' } },
  ]);
  const pending = await method.complete(context, { attemptId: 'order-1' });
  assert.deepEqual(calls[0], { path: 'collect', body: { orderRef: 'order-1' } });
  assert.equal(pending.status === 'pending' && pending.providerEvidence.message, 'Starta BankID-appen.');
  assert.equal((await method.complete(context, { attemptId: 'order-1' })).status, 'cancelled');
  assert.match(String((await method.complete(context, { attemptId: 'order-1' }) as { reason: string }).reason), /för gammalt eller spärrat/);
});

test('complete accepts a signature over this exact binding and retains the raw proof', async () => {
  const signature = signatureXml(signedBinding(context), visibleText(context));
  const { method } = fake([{ body: { orderRef: 'order-1', status: 'complete', completionData: completion(signature) } }]);
  const result = await method.complete(context, { attemptId: 'order-1' });
  assert.equal(result.status, 'completed');
  if (result.status !== 'completed') return;
  assert.equal(result.providerEvidence.identityVerified, true);
  assert.equal((result.providerEvidence.user as { personalNumber: string }).personalNumber, '199001011234');
  assert.equal(result.providerEvidence.bankIdIssueDate, '2026-01-15');
  assert.equal(result.rawProof?.signatureBase64, signature);
  assert.ok(Buffer.byteLength(JSON.stringify(result.providerEvidence)) < 16384);
});

test('complete rejects signatures for another binding and mismatched order references', async () => {
  const other = { ...context, recipientId: 'another-recipient' };
  const { method } = fake([
    { body: { orderRef: 'order-1', status: 'complete', completionData: completion(signatureXml(signedBinding(other), visibleText(other))) } },
    { body: { orderRef: 'order-2', status: 'pending' } },
    { body: { orderRef: 'order-1', status: 'complete' } },
  ]);
  assert.deepEqual(await method.complete(context, { attemptId: 'order-1' }), { status: 'failed', reason: 'BankID-signaturen gäller inte detta dokument.' });
  await assert.rejects(method.complete(context, { attemptId: 'order-1' }), /order_mismatch/);
  await assert.rejects(method.complete(context, { attemptId: 'order-1' }), /unexpected_order_state/);
  await assert.rejects(method.complete(context, { attemptId: '../x' }));
});

test('BankID error codes surface without response details', async () => {
  const { calls, method } = fake([{ status: 400, body: { errorCode: 'alreadyInProgress', details: 'Order already in progress for pno' } }, { body: {} }]);
  const error = await method.begin(context).catch(error => error);
  assert.ok(error instanceof BankIdError);
  assert.equal(error.code, 'alreadyInProgress');
  assert.ok(!error.message.includes('pno'));
  await method.cancel('order-1');
  assert.deepEqual(calls[1], { path: 'cancel', body: { orderRef: 'order-1' } });
});

test('configuration requires explicit environment, certificate files and https', () => {
  assert.equal(bankIdConfigFromEnv({}), undefined);
  assert.throws(() => bankIdConfigFromEnv({ BANKID_P12_FILE: 'rp.p12' }), /BANKID_ENV/);
  assert.throws(() => bankIdConfigFromEnv({ BANKID_P12_FILE: 'rp.p12', BANKID_ENV: 'test' }), /BANKID_CA_FILE/);
  assert.throws(() => mtlsTransport({ baseUrl: 'http://appapi2.test.bankid.com/rp/v6.0/', pfx: Buffer.alloc(0), passphrase: '', ca: Buffer.alloc(0) }), /https/);
});
