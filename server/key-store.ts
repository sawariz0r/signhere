import { mkdir, access, lstat, readdir, readFile, open, link, unlink, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { uid, type Row } from './db.js';
import { createLocalIdentity, inspectIdentity, type SealIdentity, type SealKeyOptions } from './seal.js';
import { FinalizationActionRequiredError, FinalizationRetryableError } from './finalization.js';

export interface KeyStoreOptions { keysDir: string; p12File?: string; passwordFile?: string }
export interface SealingStatus { ready: boolean; installationId: string; fingerprintSha256: string | null; certificatePem: string | null; chainPem?: string; reason?: string; notAfter?: string }
export async function createKeyStore(pool: Pool, options: KeyStoreOptions) {
  const keysDir = resolve(options.keysDir);
  let state: SealingStatus = { ready: false, installationId: '', fingerprintSha256: null, certificatePem: null, reason: 'initializing' };
  let current: Row | undefined;
  let refreshPending: Promise<SealingStatus> | undefined;
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  let identityGeneration = 0;
  const provisioningLabel = (row: Row) => createHash('sha256').update('signhere/key-provisioning/v1:' + row.installation_id + ':' + row.key_id).digest('hex').slice(0, 48);
  const keyPath = (row: Row) => options.p12File ? resolve(options.p12File) : join(keysDir, row.key_id, 'identity.p12');
  async function privatePath(path: string, directory = false) {
    const stat = await lstat(path);
    if (process.env.SIGNHERE_REQUIRE_PDF_SANDBOX === 'true') {
      const resolved = await realpath(path);
      const publicRoots = ['/usr', '/lib', '/lib64', '/opt/signhere-seal', '/app/dist', '/app/node_modules', '/app/scripts'];
      if (resolved === '/app/package.json' || publicRoots.some(root => resolved === root || resolved.startsWith(root + '/'))) throw new FinalizationActionRequiredError('key_path_exposed_to_parser');
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new FinalizationActionRequiredError('unsafe_key_path');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new FinalizationActionRequiredError('unsafe_key_permissions');
    return stat;
  }
  async function keyDirectory(row?: Row) {
    await mkdir(keysDir, { recursive: true, mode: 0o700 });
    await privatePath(keysDir, true);
    if (row) {
      const directory = join(keysDir, row.key_id);
      await privatePath(directory, true);
      if (await realpath(directory) !== join(await realpath(keysDir), row.key_id)) throw new FinalizationActionRequiredError('unsafe_key_path');
    }
  }
  async function inspect(row: Row) {
    await keyDirectory(options.p12File ? undefined : row);
    await privatePath(keyPath(row));
    if (options.passwordFile) await privatePath(resolve(options.passwordFile));
    return inspectIdentity(keyPath(row), options.passwordFile);
  }
  function requireCurrent(identity: SealIdentity) {
    if (Date.now() < Date.parse(identity.notBefore) || Date.now() >= Date.parse(identity.notAfter)) throw new FinalizationActionRequiredError('key_expired_or_not_yet_valid');
  }
  async function locked<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    let locked = false, connectionFailure: Error | undefined;
    const onError = (error: Error) => { connectionFailure = error; };
    client.on('error', onError);
    try {
      await client.query("SELECT pg_advisory_lock(hashtext(current_schema() || ':signhere-sealing-identity'))");
      locked = true;
      return await work(client);
    } finally {
      if (locked) {
        try { await client.query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':signhere-sealing-identity'))"); }
        catch (error) { connectionFailure = error instanceof Error ? error : new Error('Sealing lock release failed.'); }
      }
      client.removeListener('error', onError); client.release(connectionFailure);
    }
  }
  async function register(client: PoolClient, row: Row, identity: SealIdentity, reason: string, previous: string | null, fresh = false) {
    const at = new Date().toISOString();
    await client.query('BEGIN');
    try {
      await client.query('INSERT INTO sealing_certificates(fingerprint,certificate_pem,key_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [identity.fingerprintSha256, identity.certificatePem, row.key_id, at]);
      const updated = fresh
        ? (await client.query('INSERT INTO sealing_identity(installation_id,key_id,fingerprint,certificate_pem,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) RETURNING *', [row.installation_id, row.key_id, identity.fingerprintSha256, identity.certificatePem, at])).rows[0]
        : (await client.query('UPDATE sealing_identity SET key_id=$1,fingerprint=$2,certificate_pem=$3,updated_at=$4 WHERE singleton RETURNING *', [row.key_id, identity.fingerprintSha256, identity.certificatePem, at])).rows[0];
      if (!updated) throw new Error('Sealing identity disappeared.');
      await client.query('INSERT INTO sealing_key_events(id,installation_id,at,previous_fingerprint,new_fingerprint,reason) VALUES($1,$2,$3,$4,$5,$6)', [uid(), row.installation_id, at, previous, identity.fingerprintSha256, reason]);
      await client.query('COMMIT'); return updated;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  async function hasHistory(client: PoolClient) {
    return (await client.query(`SELECT EXISTS(SELECT 1 FROM sealing_certificates) OR EXISTS(SELECT 1 FROM sealing_key_events)
      OR EXISTS(SELECT 1 FROM documents WHERE evidence_version=2) AS exists`)).rows[0].exists;
  }
  async function provisioningReceipt(row: Row, identity: SealIdentity) {
    // A provisional DB marker may only resume its own generated identity, not
    // accidentally adopt a PKCS12 restored from another installation or key slot.
    const expectedName = 'Signhere seal ' + provisioningLabel(row);
    if (new X509Certificate(identity.certificatePem).toLegacyObject().subject.CN !== expectedName) throw new FinalizationActionRequiredError('provisional_key_mismatch');
    const receipt = { schema: 'signhere-key-provisioning-v1', installationId: row.installation_id, keyId: row.key_id, fingerprintSha256: identity.fingerprintSha256 };
    const directory = join(keysDir, row.key_id), path = join(directory, 'provisioning.json');
    try {
      const stat = await privatePath(path);
      if (stat.size > 4096) throw new Error('Invalid provisioning receipt.');
      const bytes = await readFile(path);
      if (bytes.length > 4096) throw new Error('Invalid provisioning receipt.');
      const existing = JSON.parse(bytes.toString('utf8'));
      if (Object.keys(existing).length !== 4 || Object.entries(receipt).some(([key, value]) => existing[key] !== value)) throw new Error('Invalid provisioning receipt.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new FinalizationActionRequiredError('provisional_key_mismatch');
      const temporary = join(directory, '.provisioning-' + uid() + '.tmp');
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(receipt) + '\n', 'utf8'); await file.sync(); }
      finally { await file.close(); }
      try { await link(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
    }
  }
  async function initialize() {
    await locked(async client => {
      await keyDirectory();
      let row = (await client.query('SELECT * FROM sealing_identity WHERE singleton')).rows[0];
      if (!row) {
        if (await hasHistory(client)) throw new FinalizationActionRequiredError('identity_marker_missing');
        if (!options.p12File && (await readdir(keysDir)).length) throw new FinalizationActionRequiredError('unregistered_key_files');
        const at = new Date().toISOString();
        const fresh = { installation_id: uid(), key_id: uid() };
        if (options.p12File) {
          // An imported key already exists: registration is atomic, so there is
          // no ambiguous provisional import to adopt after a restart.
          const identity = await inspect(fresh); requireCurrent(identity);
          current = await register(client, fresh, identity, 'initial-provisioning', null, true);
          return;
        }
        row = (await client.query('INSERT INTO sealing_identity(installation_id,key_id,created_at,updated_at) VALUES($1,$2,$3,$3) RETURNING *', [fresh.installation_id, fresh.key_id, at])).rows[0];
      }
      current = row;
      state = { ready: false, installationId: row.installation_id, fingerprintSha256: row.fingerprint, certificatePem: row.certificate_pem };
      if (!row.fingerprint) {
        if (options.p12File || await hasHistory(client)) throw new FinalizationActionRequiredError('identity_recovery_required');
        const directory = join(keysDir, row.key_id);
        await mkdir(directory, { recursive: true, mode: 0o700 }); await keyDirectory(row);
        try { await access(keyPath(row)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // A receipt means key publication already happened. Its loss must be
          // explicit recovery, even if the final DB registration never committed.
          try { await access(join(directory, 'provisioning.json')); throw new FinalizationActionRequiredError('key_unavailable'); }
          catch (receiptError) { if ((receiptError as NodeJS.ErrnoException).code !== 'ENOENT') throw receiptError; }
          await createLocalIdentity(directory, provisioningLabel(row));
        }
        const identity = await inspect(row); requireCurrent(identity);
        await provisioningReceipt(row, identity);
        current = await register(client, row, identity, 'initial-provisioning', null);
      }
    });
  }
  async function inspectCurrent() {
    let row: Row | undefined;
    const result: SealingStatus = { ...state, ready: false };
    // Only a successful inspection may provide a chain for preflight. Do not
    // retain the previous key's chain across a mismatch or rotation failure.
    delete result.chainPem;
    try {
      row = (await pool.query('SELECT * FROM sealing_identity WHERE singleton')).rows[0];
      if (!row?.fingerprint) throw new FinalizationActionRequiredError('identity_recovery_required');
      Object.assign(result, { installationId: row.installation_id, fingerprintSha256: row.fingerprint, certificatePem: row.certificate_pem });
      delete result.reason; delete result.notAfter;
      const identity = await inspect(row);
      if (identity.fingerprintSha256 !== row.fingerprint) { result.reason = 'key_mismatch'; return { result, row }; }
      result.notAfter = identity.notAfter; requireCurrent(identity);
      result.chainPem = identity.chainPem; result.ready = true;
    } catch (error) { result.reason = error instanceof FinalizationActionRequiredError ? error.code : 'key_unavailable'; }
    return { result, row };
  }
  /** A signing call always checks current state; concurrent checks share one inspection. */
  function refresh(): Promise<SealingStatus> {
    if (!refreshPending) {
      refreshPending = (async () => {
        for (;;) {
          const generation = identityGeneration;
          const checked = await inspectCurrent();
          // An explicit local rotation may finish while inspection is awaiting
          // the subprocess. Never republish the preceding identity afterwards.
          if (generation !== identityGeneration) continue;
          current = checked.row; state = checked.result; lastCheckedAt = Date.now();
          return { ...state };
        }
      })().finally(() => { refreshPending = undefined; });
    }
    return refreshPending;
  }
  async function cachedRefresh(ttlMs = 30000): Promise<SealingStatus> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 30000) throw new Error('Invalid identity status cache duration.');
    if (refreshPending) return refreshPending;
    const age = Date.now() - lastCheckedAt;
    if (age >= 0 && age < ttlMs) return { ...state };
    return refresh();
  }

  try { await initialize(); await refresh(); }
  catch (error) { state.ready = false; state.reason = error instanceof FinalizationActionRequiredError ? error.code : 'key_initialization_required'; }
  function readyIdentity(): Row {
    if (!state.ready || !current) {
      const code = state.reason ?? 'key_unavailable';
      if (['key_unavailable', 'key_initialization_required', 'initializing'].includes(code)) throw new FinalizationRetryableError('key_unavailable');
      throw new FinalizationActionRequiredError(code);
    }
    return current;
  }
  return {
    status: () => ({ ...state }), refresh, cachedRefresh,
    async signingIdentity() {
      await refresh();
      const identity = readyIdentity();
      return { installationId: identity.installation_id, fingerprintSha256: identity.fingerprint, keyId: identity.key_id };
    },
    async keyFor(fingerprint: string): Promise<SealKeyOptions> {
      await refresh();
      const identity = readyIdentity();
      if (identity.fingerprint !== fingerprint) throw new FinalizationActionRequiredError('signing_identity_changed');
      return { p12File: keyPath(identity), passwordFile: options.passwordFile, expectedFingerprint: fingerprint };
    },
    async rotate(reason: 'rotation' | 'lost-key') {
      if (!['rotation', 'lost-key'].includes(reason)) throw new Error('Invalid identity recovery reason.');
      await locked(async client => {
        await keyDirectory();
        const old = (await client.query('SELECT * FROM sealing_identity WHERE singleton')).rows[0];
        if (!old) throw new Error('No installation identity to rotate.');
        if (reason !== 'lost-key' && !options.p12File) {
          const oldIdentity = await inspect(old);
          if (oldIdentity.fingerprintSha256 !== old.fingerprint) throw new Error('Existing key does not match; use explicit lost-key recovery.');
        }
        const next = { ...old, key_id: uid() };
        const identity = options.p12File ? await inspect(next) : await createLocalIdentity(join(keysDir, next.key_id), provisioningLabel(next));
        requireCurrent(identity);
        if (identity.fingerprintSha256 === old.fingerprint) throw new Error('Rotation needs a different certificate.');
        if (!options.p12File) { await keyDirectory(next); await provisioningReceipt(next, identity); }
        current = await register(client, next, identity, reason, old.fingerprint);
        identityGeneration++; lastCheckedAt = Number.NEGATIVE_INFINITY;
      });
      return refresh();
    },
  };
}
