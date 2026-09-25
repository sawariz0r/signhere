/**
 * Central signing keys (Node only). Two roles with separate files:
 * - trust root: signs trust bundles only. Generate it, publish its public key through an
 *   independent channel, then keep the private file offline. The service never loads it.
 * - receipt key: signs approval receipts only, loaded by the running service.
 * Production deployments may replace FileSigner with a KMS/HSM-backed Signer.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLE_SCHEMA, BUNDLE_TYP, RECEIPT_TYP, base64url, canonicalJson, fromBase64url, keyId, trustBundleSchema, utf8, type TrustBundle, type TrustKey } from './protocol.js';

export interface Signer { kid: string; publicKey: string; sign(message: Uint8Array): Promise<Uint8Array> }

function rawPublicKey(key: KeyObject) {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new Error('Expected an Ed25519 key.');
  return jwk.x;
}
export async function signerFromPrivateKey(privateKey: KeyObject): Promise<Signer> {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Central signing keys must be Ed25519.');
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  return { kid: await keyId(fromBase64url(publicKey)), publicKey, async sign(message) { return new Uint8Array(sign(null, message, privateKey)); } };
}
export async function generateSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { signer: await signerFromPrivateKey(privateKey), pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}
/** Key files must be regular, owner-only files; a readable private key is a configuration error. */
export async function loadSigner(file: string): Promise<Signer> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Central key file must be a regular file.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Central key file must not be readable by group or others (use chmod 600).');
  return signerFromPrivateKey(createPrivateKey(await readFile(file, 'utf8')));
}

export async function signJws(signer: Signer, typ: typeof RECEIPT_TYP | typeof BUNDLE_TYP, payload: unknown) {
  const header = base64url(utf8(canonicalJson({ alg: 'EdDSA', kid: signer.kid, typ })));
  const body = base64url(utf8(canonicalJson(payload)));
  const signature = await signer.sign(utf8(header + '.' + body));
  return header + '.' + body + '.' + base64url(signature);
}

export async function signTrustBundle(root: Signer, bundle: TrustBundle) {
  const checked = trustBundleSchema.parse(bundle);
  if (checked.keys.some(key => key.kid === root.kid)) throw new Error('The trust root must not also be a listed service key.');
  return signJws(root, BUNDLE_TYP, checked);
}
export function trustKey(signer: Signer, validFrom: string): TrustKey {
  return { kid: signer.kid, alg: 'Ed25519', publicKey: signer.publicKey, purposes: ['approval-receipt'], validFrom, validUntil: null, status: 'active' };
}
export function newBundle(service: string, sequence: number, keys: TrustKey[], issuedAt = new Date().toISOString()): TrustBundle {
  return { schema: BUNDLE_SCHEMA, service, sequence, issuedAt, keys };
}

/** Creates the key directory layout used by the admin CLI. Refuses to overwrite existing keys. */
export async function writeKeyFile(directory: string, name: string, pem: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  await writeFile(path, pem, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
  return path;
}
