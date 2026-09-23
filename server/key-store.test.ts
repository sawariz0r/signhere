import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { mkdtemp, mkdir, readFile, writeFile, rename, readdir, access, rm, chmod, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDatabase, uid } from './db.js';
import { createKeyStore } from './key-store.js';
import { createLocalIdentity, inspectIdentity } from './seal.js';
import { sha256 } from './pdf.js';
import { FinalizationActionRequiredError, FinalizationRetryableError } from './finalization.js';

try { loadEnvFile('.local/postgres.env'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Key lifecycle tests require PostgreSQL.');
const label = (installation: string, key: string) => sha256('signhere/key-provisioning/v1:' + installation + ':' + key).slice(0, 48);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'signhere-keystore-test-'));
  const keysDir = join(directory, 'keys');
  const schema = 'test_' + uid().replaceAll('-', '');
  const pool = await createDatabase(databaseUrl!, schema);
  t.after(async () => { await pool.query('DROP SCHEMA "' + schema + '" CASCADE'); await pool.end(); await rm(directory, { recursive: true, force: true }); });
  const store = () => createKeyStore(pool, { keysDir });
  const marker = async () => (await pool.query('SELECT * FROM sealing_identity')).rows[0];
  async function provisional() {
    const installationId = uid(), keyId = uid(), at = new Date().toISOString();
    await pool.query('INSERT INTO sealing_identity(installation_id,key_id,created_at,updated_at) VALUES($1,$2,$3,$3)', [installationId, keyId, at]);
    await mkdir(join(keysDir, keyId), { recursive: true, mode: 0o700 });
    return { installationId, keyId, directory: join(keysDir, keyId), p12: join(keysDir, keyId, 'identity.p12') };
  }
  return { pool, directory, keysDir, store, marker, provisional };
}

test('concurrent first boots and restarts provision exactly one identity and keep the key bytes unchanged', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.store(), f.store()]);
  assert.equal(first.status().ready, true, first.status().reason);
  assert.deepEqual(first.status(), second.status());
  const identity = await first.signingIdentity();
  const options = await first.keyFor(identity.fingerprintSha256);
  const bytes = await readFile(options.p12File);
  const restarted = await f.store();
  assert.deepEqual(await restarted.signingIdentity(), identity);
  assert.equal(sha256(await readFile(options.p12File)), sha256(bytes));
  assert.equal((await f.pool.query('SELECT count(*) FROM sealing_certificates')).rows[0].count, '1');
  assert.equal((await f.pool.query('SELECT count(*) FROM sealing_key_events')).rows[0].count, '1');
  assert.equal((await readdir(f.keysDir)).length, 1);
  const receipt = JSON.parse(await readFile(join(f.keysDir, identity.keyId, 'provisioning.json'), 'utf8'));
  assert.equal(receipt.installationId, identity.installationId);
  assert.equal(receipt.fingerprintSha256, identity.fingerprintSha256);
});

test('lost or substituted private keys cannot regenerate silently; explicit recovery preserves public history', async t => {
  const f = await fixture(t); const store = await f.store();
  const identity = await store.signingIdentity(), key = await store.keyFor(identity.fingerprintSha256);
  const original = await readFile(key.p12File);
  await rename(key.p12File, key.p12File + '.retained-for-test');
  const missing = await f.store();
  assert.equal(missing.status().ready, false);
  assert.equal((await f.marker()).fingerprint, identity.fingerprintSha256);
  await assert.rejects(access(key.p12File));
  await assert.rejects(missing.signingIdentity(), error => error instanceof FinalizationRetryableError && error.code === 'key_unavailable');
  await assert.rejects(missing.keyFor(identity.fingerprintSha256), error => error instanceof FinalizationRetryableError && error.code === 'key_unavailable');
  await assert.rejects(missing.rotate('rotation'));
  await rename(key.p12File + '.retained-for-test', key.p12File);
  assert.equal((await missing.refresh()).ready, true);
  const foreign = join(f.directory, 'foreign');
  await createLocalIdentity(foreign, 'foreign-installation');
  await writeFile(key.p12File, await readFile(join(foreign, 'identity.p12')), { mode: 0o600 });
  const mismatched = await store.refresh();
  assert.equal(mismatched.reason, 'key_mismatch'); assert.equal(mismatched.chainPem, undefined);
  await assert.rejects(store.signingIdentity(), error => error instanceof FinalizationActionRequiredError && error.code === 'key_mismatch');
  await assert.rejects(store.rotate('rotation'), /does not match/);
  const recovered = await store.rotate('lost-key');
  assert.equal(recovered.ready, true);
  assert.notEqual(recovered.fingerprintSha256, identity.fingerprintSha256);
  assert.equal(recovered.installationId, identity.installationId);
  const certificates = (await f.pool.query('SELECT * FROM sealing_certificates')).rows;
  assert.equal(certificates.length, 2);
  assert.ok(certificates.some(cert => cert.fingerprint === identity.fingerprintSha256));
  const events = (await f.pool.query('SELECT * FROM sealing_key_events ORDER BY at,id')).rows;
  assert.equal(events.at(-1).previous_fingerprint, identity.fingerprintSha256);
  assert.equal(events.at(-1).reason, 'lost-key');
  await assert.rejects(f.pool.query("UPDATE sealing_certificates SET certificate_pem='replacement'"), /append-only/);
  assert.ok(original.length > 0);
});

test('normal local rotation preserves the installation and all old public certificates', async t => {
  const f = await fixture(t); const store = await f.store();
  const before = await store.signingIdentity();
  const oldKey = await store.keyFor(before.fingerprintSha256);
  const bytes = await readFile(oldKey.p12File);
  const after = await store.rotate('rotation');
  assert.equal(after.ready, true); assert.equal(after.installationId, before.installationId);
  assert.notEqual(after.fingerprintSha256, before.fingerprintSha256);
  const nextKey = await store.keyFor(after.fingerprintSha256!);
  if (process.platform !== 'win32') {
    assert.equal((await stat(resolve(nextKey.p12File, '..'))).mode & 0o077, 0, 'rotation creates a private directory regardless of default umask');
    assert.equal((await stat(nextKey.p12File)).mode & 0o077, 0);
  }
  assert.deepEqual(await readFile(oldKey.p12File), bytes);
  await assert.rejects(store.keyFor(before.fingerprintSha256), /signing_identity_changed/);
  assert.equal((await f.pool.query('SELECT count(*) FROM sealing_certificates')).rows[0].count, '2');
  assert.equal((await f.pool.query("SELECT count(*) FROM sealing_key_events WHERE reason='rotation'")).rows[0].count, '1');
});

test('missing database identity marker with retained public history refuses fresh provisioning in an empty key directory', async t => {
  const f = await fixture(t); const store = await f.store();
  const before = await store.signingIdentity();
  await f.pool.query('DELETE FROM sealing_identity');
  const empty = join(f.directory, 'empty-key-volume');
  const recovered = await createKeyStore(f.pool, { keysDir: empty });
  assert.equal(recovered.status().ready, false);
  assert.equal(recovered.status().reason, 'identity_marker_missing');
  assert.equal(await f.marker(), undefined);
  assert.deepEqual(await readdir(empty), []);
  assert.equal((await f.pool.query('SELECT fingerprint FROM sealing_certificates')).rows[0].fingerprint, before.fingerprintSha256);
});

test('unregistered key files are never adopted as a fresh installation', async t => {
  const f = await fixture(t); await mkdir(f.keysDir, { recursive: true, mode: 0o700 });
  await writeFile(join(f.keysDir, 'unexpected-private-key'), 'test fixture', { mode: 0o600 });
  const store = await f.store();
  assert.equal(store.status().ready, false); assert.equal(store.status().reason, 'unregistered_key_files');
  assert.equal(await f.marker(), undefined);
});

test('a crash after key publication resumes only the matching provisional installation and key slot', async t => {
  const f = await fixture(t); const provisional = await f.provisional();
  const identity = await createLocalIdentity(provisional.directory, label(provisional.installationId, provisional.keyId));
  const key = await readFile(provisional.p12);
  const store = await f.store();
  assert.equal(store.status().ready, true, store.status().reason);
  assert.equal(store.status().installationId, provisional.installationId);
  assert.equal(store.status().fingerprintSha256, identity.fingerprintSha256);
  assert.deepEqual(await readFile(provisional.p12), key);
  assert.equal(JSON.parse(await readFile(join(provisional.directory, 'provisioning.json'), 'utf8')).keyId, provisional.keyId);
});

test('foreign provisional keys and mismatched recovery receipts cannot be adopted or overwritten', async t => {
  const f = await fixture(t); const provisional = await f.provisional();
  await createLocalIdentity(provisional.directory, label(uid(), provisional.keyId));
  const bytes = await readFile(provisional.p12);
  const foreign = await f.store();
  assert.equal(foreign.status().reason, 'provisional_key_mismatch');
  assert.equal((await f.marker()).fingerprint, null);
  assert.deepEqual(await readFile(provisional.p12), bytes);
  assert.equal((await f.pool.query('SELECT count(*) FROM sealing_certificates')).rows[0].count, '0');
  assert.equal((await foreign.rotate('lost-key')).ready, true);
  const g = await fixture(t); const next = await g.provisional();
  await createLocalIdentity(next.directory, label(next.installationId, next.keyId));
  await writeFile(join(next.directory, 'provisioning.json'), JSON.stringify({ schema: 'signhere-key-provisioning-v1', installationId: next.installationId, keyId: next.keyId, fingerprintSha256: 'f'.repeat(64) }), { mode: 0o600 });
  assert.equal((await g.store()).status().reason, 'provisional_key_mismatch');
  assert.equal((await g.marker()).fingerprint, null);
});

test('a published provisioning receipt prevents regeneration after the provisional key is lost', async t => {
  const f = await fixture(t); const provisional = await f.provisional();
  const identity = await createLocalIdentity(provisional.directory, label(provisional.installationId, provisional.keyId));
  await writeFile(join(provisional.directory, 'provisioning.json'), JSON.stringify({ schema: 'signhere-key-provisioning-v1', installationId: provisional.installationId, keyId: provisional.keyId, fingerprintSha256: identity.fingerprintSha256 }), { mode: 0o600 });
  await rename(provisional.p12, provisional.p12 + '.lost');
  const store = await f.store();
  assert.equal(store.status().ready, false); assert.equal(store.status().reason, 'key_unavailable');
  await assert.rejects(access(provisional.p12));
  assert.equal((await f.marker()).fingerprint, null);
});

test('imported identity registration is atomic and explicit import rotation adopts a new configured certificate', async t => {
  const f = await fixture(t);
  const importedDirectory = join(f.directory, 'imported');
  const identity = await createLocalIdentity(importedDirectory, 'operator-import');
  const p12File = join(importedDirectory, 'identity.p12');
  await f.pool.query(`CREATE FUNCTION fail_key_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
    CREATE TRIGGER fail_key_registration BEFORE INSERT ON sealing_key_events FOR EACH ROW EXECUTE FUNCTION fail_key_registration()`);
  const failed = await createKeyStore(f.pool, { keysDir: f.keysDir, p12File });
  assert.equal(failed.status().ready, false);
  assert.equal(await f.marker(), undefined);
  assert.equal((await f.pool.query('SELECT count(*) FROM sealing_certificates')).rows[0].count, '0');
  await f.pool.query('DROP TRIGGER fail_key_registration ON sealing_key_events');
  const first = await createKeyStore(f.pool, { keysDir: f.keysDir, p12File });
  assert.equal(first.status().fingerprintSha256, identity.fingerprintSha256);
  assert.equal(first.status().ready, true);
  const nextDirectory = join(f.directory, 'next-import');
  const replacement = await createLocalIdentity(nextDirectory, 'operator-import-next');
  const second = await createKeyStore(f.pool, { keysDir: f.keysDir, p12File: join(nextDirectory, 'identity.p12') });
  assert.equal(second.status().reason, 'key_mismatch');
  const after = await second.rotate('rotation');
  assert.equal(after.ready, true); assert.equal(after.fingerprintSha256, replacement.fingerprintSha256);
  assert.equal((await f.pool.query('SELECT count(*) FROM sealing_certificates')).rows[0].count, '2');
});

test('expired identity refuses new sealing while retaining its public verification metadata', async t => {
  const f = await fixture(t); const store = await f.store(); const original = store.status();
  const now = Date.now;
  try {
    Date.now = () => Date.parse(original.notAfter!) + 1000;
    const expired = await store.refresh();
    assert.equal(expired.ready, false); assert.equal(expired.reason, 'key_expired_or_not_yet_valid');
    assert.equal(expired.fingerprintSha256, original.fingerprintSha256);
    await assert.rejects(store.signingIdentity(), /key_expired_or_not_yet_valid/);
  } finally { Date.now = now; }
  assert.equal((await store.refresh()).ready, true);
});

test('POSIX broad key permissions and symbolic key directories fail closed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const store = await f.store(); const identity = await store.signingIdentity();
  const key = await store.keyFor(identity.fingerprintSha256);
  await chmod(key.p12File, 0o644);
  assert.equal((await store.refresh()).reason, 'unsafe_key_permissions');
  await chmod(key.p12File, 0o600);
  await chmod(f.keysDir, 0o755);
  assert.equal((await store.refresh()).reason, 'unsafe_key_permissions');
  await chmod(f.keysDir, 0o700);
  const keyDirectory = join(f.keysDir, identity.keyId), moved = join(f.directory, 'moved-key');
  await rename(keyDirectory, moved); await symlink(moved, keyDirectory, 'dir');
  assert.equal((await store.refresh()).reason, 'unsafe_key_path');
});


test('production sealing keys cannot be located in a parser-readable public runtime path', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const prior = process.env.SIGNHERE_REQUIRE_PDF_SANDBOX;
  try {
    process.env.SIGNHERE_REQUIRE_PDF_SANDBOX = 'true';
    const exposed = await createKeyStore(f.pool, { keysDir: '/usr' });
    assert.equal(exposed.status().ready, false);
    assert.equal(exposed.status().reason, 'key_path_exposed_to_parser');
    assert.equal(await f.marker(), undefined);
  } finally {
    if (prior === undefined) delete process.env.SIGNHERE_REQUIRE_PDF_SANDBOX;
    else process.env.SIGNHERE_REQUIRE_PDF_SANDBOX = prior;
  }
});


test('public status refresh is bounded, single-flight, and notices restored or missing keys after its TTL', async t => {
  const f = await fixture(t); const store = await f.store();
  const identity = await store.signingIdentity(), key = await store.keyFor(identity.fingerprintSha256);
  await rename(key.p12File, key.p12File + '.temporarily-removed');
  const originalNow = Date.now;
  let clock = originalNow();
  try {
    Date.now = () => clock;
    assert.equal((await store.cachedRefresh()).ready, true, 'the public cache has a documented bounded stale interval');
    clock += 30001;
    assert.equal((await store.cachedRefresh()).ready, false);
    await rename(key.p12File + '.temporarily-removed', key.p12File);
    assert.equal((await store.cachedRefresh()).ready, false);
    const originalQuery = f.pool.query.bind(f.pool);
    let inspections = 0;
    f.pool.query = ((...args: any[]) => {
      if (args[0] === 'SELECT * FROM sealing_identity WHERE singleton') inspections++;
      return (originalQuery as any)(...args);
    }) as typeof f.pool.query;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => store.cachedRefresh(0)));
      assert.ok(results.every(result => result.ready));
      assert.equal(inspections, 1, 'concurrent public checks perform a single actual key inspection');
    } finally { f.pool.query = originalQuery; }
  } finally { Date.now = originalNow; }
  const rotated = await store.rotate('rotation');
  assert.equal((await store.cachedRefresh()).fingerprintSha256, rotated.fingerprintSha256);
  await assert.rejects(store.cachedRefresh(60000), /cache duration/);
});


test('an imported certificate chain remains available to preflight only after successful identity inspection', async t => {
  const f = await fixture(t), importedDirectory = join(f.directory, 'imported-chain');
  await createLocalIdentity(importedDirectory, 'import-with-chain');
  const p12File = join(importedDirectory, 'identity.p12');
  const python = process.env.SIGNHERE_SEAL_PYTHON || resolve('.local/seal-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  // Create a real issuing CA and reissue this test key's leaf; no production key material is used.
  await promisify(execFile)(python, ['-c', String.raw`
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
path = Path(sys.argv[1])
key, old, _ = pkcs12.load_key_and_certificates(path.read_bytes(), None)
ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Signhere test CA')])
now = datetime.now(timezone.utc)
ca = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(ca_key.public_key())
      .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=30))
      .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True).sign(ca_key, hashes.SHA256()))
leaf = (x509.CertificateBuilder().subject_name(old.subject).issuer_name(subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=10))
        .add_extension(old.extensions.get_extension_for_class(x509.KeyUsage).value, critical=True).sign(ca_key, hashes.SHA256()))
path.write_bytes(pkcs12.serialize_key_and_certificates(b'test-chain', key, leaf, [ca], serialization.NoEncryption()))
`, p12File], { windowsHide: true });
  const inspected = await inspectIdentity(p12File);
  assert.equal(inspected.chainPem.match(/BEGIN CERTIFICATE/g)?.length, 2);
  const store = await createKeyStore(f.pool, { keysDir: f.keysDir, p12File });
  const status = store.status();
  assert.equal(status.ready, true, status.reason);
  assert.equal(status.chainPem, inspected.chainPem);
  assert.equal(status.certificatePem, inspected.certificatePem);
  assert.notEqual(status.chainPem, status.certificatePem);
  assert.equal((await store.cachedRefresh()).chainPem, inspected.chainPem);
  await rename(p12File, p12File + '.missing');
  const missing = await store.refresh();
  assert.equal(missing.ready, false); assert.equal(missing.chainPem, undefined);
});
