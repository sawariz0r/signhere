/** Shared fixtures for central-service tests (not shipped in the build: excluded by name below). */
import { loadEnvFile } from 'node:process';
import { randomBytes, createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createCentralApp, createInstance } from './app.js';
import { generateSigner, newBundle, signTrustBundle, trustKey } from './keys.js';
import { verifyTrustBundle } from './protocol.js';
import type { Mailer, MailMessage } from '../mail.js';

try { loadEnvFile('.local/postgres.env'); } catch {}
export const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Tests require TEST_DATABASE_URL (or DATABASE_URL) pointing to a disposable PostgreSQL database.');
export const centralOrigin = 'http://localhost:3100';
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const capabilityToken = () => randomBytes(32).toString('base64url');

export async function trustFixture(service = centralOrigin) {
  const root = await generateSigner();
  const receipt = await generateSigner();
  const bundle = newBundle(service, 1, [trustKey(receipt.signer, '2020-01-01T00:00:00.000Z')], '2020-01-01T00:00:00.000Z');
  const jws = await signTrustBundle(root.signer, bundle);
  return { root: root.signer, receiptSigner: receipt.signer, trustBundle: { jws, bundle: await verifyTrustBundle(jws, root.signer.publicKey), rootPublicKey: root.signer.publicKey } };
}

export function captureMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer & { sent: MailMessage[]; fail: boolean } = {
    provider: 'test', sent, fail: false,
    async send(message) { if (mailer.fail) throw new Error('down'); sent.push(message); return {}; },
  };
  return mailer;
}
export const lastCode = (mailer: { sent: MailMessage[] }) => /(\d{4}) (\d{4})/.exec(mailer.sent.at(-1)!.text)!.slice(1).join('');

export async function centralFixture(t: TestContext, options: { now?: () => number } = {}) {
  const schema = 'central_test_' + randomBytes(8).toString('hex');
  const trust = await trustFixture();
  const mailer = captureMailer();
  const runtime = await createCentralApp({ databaseUrl: databaseUrl!, schema, origin: centralOrigin, signer: trust.receiptSigner, trustBundle: trust.trustBundle,
    mailer, rateLimit: false, cleanup: { autoStart: false }, now: options.now });
  t.after(async () => { await runtime.pool.query('DROP SCHEMA "' + schema + '" CASCADE'); await runtime.close(); });
  return { ...runtime, trust, mailer, schema };
}
export async function registerInstance(pool: Parameters<typeof createInstance>[0], origin = 'http://localhost:3000') {
  return createInstance(pool, { name: 'Testinstallation', origin });
}
