import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import type { Pool } from 'pg';
import { appendEvent, canonical, createDatabase, transaction, uid } from './db.js';
import { sha256 } from './pdf.js';
import {
  claimFinalization, countLegacyPendingDocuments, createFinalizationWorker, enqueueFinalization,
  FinalizationActionRequiredError, FinalizationRetryableError, loadFinalizationSnapshot, publishFinalization, retryFinalization,
} from './finalization.js';

try { loadEnvFile('.local/postgres.env'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Finalization tests require PostgreSQL.');
const fixedTime = '2026-09-24T10:00:00.000Z';
const protectionPolicy = { version: 1, seal: 'local', timestamp: 'off' };
const artifact = { bytes: Buffer.from('%PDF-final-artifact'), sealMetadata: { certificateFingerprint: 'a'.repeat(64), cryptographicPdfSeal: true } };
const identity = { keyId: 'key-one', fingerprint: 'a'.repeat(64) };
async function fixture(t: TestContext) {
  const schema = 'test_' + uid().replaceAll('-', '');
  const pool = await createDatabase(databaseUrl!, schema);
  t.after(async () => { await pool.query('DROP SCHEMA "' + schema + '" CASCADE'); await pool.end(); });
  const teamId = uid(), userId = uid();
  await pool.query("INSERT INTO teams(id,name) VALUES($1,'Finalization test')", [teamId]);
  await pool.query("INSERT INTO users(id,team_id,name,email,password_hash,role,created_at) VALUES($1,$2,'Owner','owner@example.test','test-only','owner',$3)", [userId, teamId, fixedTime]);
  async function document(version = 2, recipients = 1) {
    const documentId = uid();
    const original = Buffer.from('%PDF-original');
    await pool.query(`INSERT INTO documents(id,team_id,created_by,title,file_name,original,original_hash,size,pages,status,sender,method_id,method_version,created_at,evidence_version,protection_policy)
      VALUES($1,$2,$3,'Contract','contract.pdf',$4,$5,$6,1,'pending',$7,'draw','1',$8,$9,$10)`, [documentId, teamId, userId, original, sha256(original), original.length, { name: 'Owner' }, fixedTime, version, version === 2 ? protectionPolicy : null]);
    const recipientIds = [];
    for (let index = 0; index < recipients; index++) {
      const id = uid(); recipientIds.push(id);
      await pool.query(`INSERT INTO recipients(id,document_id,position,name,email,method_id,method_version,token_hash,expires_at,signing_intent)
        VALUES($1,$2,$3,'Signer','signer@example.test','draw','1',$4,9999999999999,$5)`, [id, documentId, index, sha256(id), version === 2 ? Buffer.from('exact intent ' + id) : null]);
    }
    await transaction(pool, client => appendEvent(client, documentId, 'document.created', fixedTime, { recipients: recipientIds }));
    return { id: documentId, recipientIds, original };
  }
  async function accept(documentId: string, recipientId: string, maxAttempts = 5) {
    return transaction(pool, async client => {
      await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [documentId]);
      await client.query("UPDATE recipients SET signed_at=$2,claimed_name='Signer',signature=$3,evidence=$4,submission_hash=$5 WHERE id=$1", [recipientId, fixedTime, { strokes: [] }, { consent: 'I agree' }, sha256(recipientId)]);
      const checkpoint = await appendEvent(client, documentId, 'recipient.signed', fixedTime, { recipientId, consent: 'I agree' });
      const recipients = (await client.query('SELECT * FROM recipients WHERE document_id=$1 ORDER BY position', [documentId])).rows;
      if (recipients.every(recipient => recipient.signed_at)) {
        const core = Buffer.from(canonical({ documentId, checkpoint, recipients: recipients.map(recipient => ({ id: recipient.id, signedAt: recipient.signed_at })) }));
        await enqueueFinalization(client, { documentId, checkpoint, evidenceCore: core, maxAttempts });
      }
      return checkpoint;
    });
  }
  return { pool, schema, document, accept };
}
async function status(pool: Pool, id: string) { return (await pool.query('SELECT * FROM documents WHERE id=$1', [id])).rows[0]; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

test('accepted final signature survives artifact failure, immutable core is retried, and PDF work holds no document lock', async t => {
  const f = await fixture(t); const doc = await f.document();
  await f.accept(doc.id, doc.recipientIds[0]);
  const frozen = await status(f.pool, doc.id);
  let calls = 0;
  const worker = createFinalizationWorker(f.pool, { signingIdentity: identity, buildArtifact: async snapshot => {
    calls++;
    assert.deepEqual(snapshot.evidenceCore, frozen.evidence_core);
    await transaction(f.pool, async client => {
      await client.query("SET LOCAL lock_timeout='200ms'");
      await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [doc.id]);
    });
    if (calls === 1) throw new Error('secret request content must not be retained');
    return artifact;
  } }, { retryBaseMs: 0, now: () => Date.parse(fixedTime) });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'retry');
  const afterFailure = await status(f.pool, doc.id);
  assert.equal(afterFailure.status, 'finalizing'); assert.equal(afterFailure.completed, null);
  assert.deepEqual(afterFailure.evidence_core, frozen.evidence_core);
  assert.equal((await f.pool.query('SELECT signed_at FROM recipients WHERE id=$1', [doc.recipientIds[0]])).rows[0].signed_at, fixedTime);
  assert.equal((await f.pool.query('SELECT last_error_code FROM finalization_jobs WHERE document_id=$1', [doc.id])).rows[0].last_error_code, 'artifact_build_failed');
  assert.equal((await worker.runOnce()).status, 'completed');
  const completed = await status(f.pool, doc.id);
  assert.equal(completed.completed_hash, sha256(artifact.bytes)); assert.equal(completed.completed_at, fixedTime);
  const events = (await f.pool.query('SELECT * FROM events WHERE document_id=$1 ORDER BY sequence', [doc.id])).rows;
  assert.deepEqual(events.map(event => event.type), ['document.created', 'recipient.signed', 'document.completed']);
  assert.equal(events[2].data.evidenceCoreHash, sha256(frozen.evidence_core));
  assert.ok(events.every(event => /^[A-Za-z0-9_-]{43}$/.test(event.data.eventNonce)));
  assert.equal(new Set(events.map(event => event.data.eventNonce)).size, events.length);
  assert.equal((await worker.runOnce()).status, 'idle');
  const attempts = (await f.pool.query('SELECT * FROM finalization_attempts WHERE document_id=$1 ORDER BY generation', [doc.id])).rows;
  assert.deepEqual(attempts.map(attempt => attempt.status), ['retry', 'completed']);
  assert.deepEqual(attempts[0].signing_identity, identity);
  assert.equal(attempts[0].error_code, 'artifact_build_failed');
  await assert.rejects(f.pool.query("UPDATE finalization_attempts SET error_code='changed' WHERE document_id=$1", [doc.id]), /immutable/);
});

test('simultaneous final recipients enqueue one job and concurrent workers publish one artifact', async t => {
  const f = await fixture(t); const doc = await f.document(2, 2);
  await Promise.all(doc.recipientIds.map(id => f.accept(doc.id, id)));
  assert.equal((await f.pool.query('SELECT count(*) FROM finalization_jobs')).rows[0].count, '1');
  const entered = deferred(), release = deferred(); let builds = 0;
  const services = { buildArtifact: async () => { builds++; entered.resolve(); await release.promise; return artifact; } };
  const first = createFinalizationWorker(f.pool, services); const second = createFinalizationWorker(f.pool, services);
  t.after(async () => { release.resolve(); await Promise.all([first.stop(), second.stop()]); });
  const work = first.runOnce(); await entered.promise;
  assert.equal((await second.runOnce()).status, 'idle');
  release.resolve(); assert.equal((await work).status, 'completed'); assert.equal(builds, 1);
  assert.equal((await f.pool.query("SELECT count(*) FROM events WHERE type='document.completed'")).rows[0].count, '1');
});

test('expired lease recovery fences stale workers and protects frozen evidence and accepted recipients', async t => {
  const f = await fixture(t); const doc = await f.document(); await f.accept(doc.id, doc.recipientIds[0]);
  const old = (await claimFinalization(f.pool))!; const oldSnapshot = await loadFinalizationSnapshot(f.pool, old);
  await assert.rejects(f.pool.query("UPDATE documents SET status='cancelled' WHERE id=$1", [doc.id]), /cannot be cancelled/);
  await assert.rejects(f.pool.query(`INSERT INTO recipients(id,document_id,position,name,email,method_id,method_version,token_hash,expires_at)
    VALUES($1,$2,2,'Extra','extra@example.test','draw','1',$3,9999999999999)`, [uid(), doc.id, sha256(uid())]), /immutable/);
  await assert.rejects(f.pool.query("UPDATE documents SET evidence_core=$2 WHERE id=$1", [doc.id, Buffer.from('replacement')]), /immutable/);
  await assert.rejects(f.pool.query("UPDATE recipients SET signing_intent=$2 WHERE id=$1", [doc.recipientIds[0], Buffer.from('replacement')]), /immutable/);
  await assert.rejects(transaction(f.pool, client => appendEvent(client, doc.id, 'recipient.viewed', fixedTime, {})), /immutable/);
  await f.pool.query("UPDATE finalization_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE document_id=$1", [doc.id]);
  const replacement = (await claimFinalization(f.pool))!;
  assert.notEqual(replacement.generation, old.generation);
  assert.equal(await publishFinalization(f.pool, oldSnapshot, artifact), false);
  const snapshot = await loadFinalizationSnapshot(f.pool, replacement);
  assert.equal(await publishFinalization(f.pool, snapshot, artifact), true);
  assert.equal(await publishFinalization(f.pool, oldSnapshot, artifact), false);
  await assert.rejects(f.pool.query("UPDATE documents SET completed=$2 WHERE id=$1", [doc.id, Buffer.from('replacement')]), /immutable/);
});

test('failed publication rolls back artifact and completion event, then retries without a new signature', async t => {
  const f = await fixture(t); const doc = await f.document(); await f.accept(doc.id, doc.recipientIds[0]);
  await f.pool.query(`CREATE FUNCTION simulate_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.type='document.completed' THEN RAISE EXCEPTION 'simulated storage failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER completion_failure BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION simulate_completion_failure()`);
  const worker = createFinalizationWorker(f.pool, { buildArtifact: async () => artifact }, { retryBaseMs: 0 });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'retry');
  assert.equal((await status(f.pool, doc.id)).status, 'finalizing');
  assert.equal((await f.pool.query("SELECT count(*) FROM events WHERE type='document.completed'")).rows[0].count, '0');
  await f.pool.query('DROP TRIGGER completion_failure ON events');
  assert.equal((await worker.runOnce()).status, 'completed');
  assert.equal((await f.pool.query("SELECT count(*) FROM events WHERE type='recipient.signed'")).rows[0].count, '1');
});

test('bounded retries and permanent failures require operator action while preserving approvals', async t => {
  const f = await fixture(t); const doc = await f.document(); await f.accept(doc.id, doc.recipientIds[0], 2);
  const worker = createFinalizationWorker(f.pool, { buildArtifact: async () => { throw new Error('temporary'); } }, { retryBaseMs: 0 });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'retry');
  assert.equal((await worker.runOnce()).status, 'action_required');
  assert.equal((await worker.runOnce()).status, 'idle');
  assert.equal(await retryFinalization(f.pool, doc.id), true);
  const permanent = createFinalizationWorker(f.pool, { buildArtifact: async () => { throw new FinalizationActionRequiredError('key_missing'); } });
  t.after(() => permanent.stop());
  assert.equal((await permanent.runOnce()).status, 'action_required');
  assert.equal((await status(f.pool, doc.id)).status, 'finalizing');
  const job = (await f.pool.query('SELECT * FROM finalization_jobs WHERE document_id=$1', [doc.id])).rows[0];
  assert.equal(job.last_error_code, 'key_missing');
});

test('a key change cannot silently change a queued attempt identity and requires explicit recovery', async t => {
  const f = await fixture(t); const doc = await f.document(); await f.accept(doc.id, doc.recipientIds[0]);
  const old = createFinalizationWorker(f.pool, { signingIdentity: identity, buildArtifact: async () => { throw new Error('retry'); } }, { retryBaseMs: 0 });
  t.after(() => old.stop()); assert.equal((await old.runOnce()).status, 'retry');
  let builds = 0;
  const next = createFinalizationWorker(f.pool, { signingIdentity: { ...identity, keyId: 'key-two' }, buildArtifact: async () => { builds++; return artifact; } });
  t.after(() => next.stop());
  assert.equal((await next.runOnce()).status, 'action_required'); assert.equal(builds, 0);
  assert.equal(await retryFinalization(f.pool, doc.id), true);
  assert.equal((await next.runOnce()).status, 'action_required');
  assert.equal(await retryFinalization(f.pool, doc.id, { resetSigningIdentity: true }), true);
  assert.equal((await next.runOnce()).status, 'completed'); assert.equal(builds, 1);
});

test('worker death at the last allowed attempt becomes action required and missing identity never invokes PDF work', async t => {
  const f = await fixture(t); const doc = await f.document(); await f.accept(doc.id, doc.recipientIds[0], 1);
  assert.ok(await claimFinalization(f.pool));
  await f.pool.query("UPDATE finalization_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE document_id=$1", [doc.id]);
  assert.equal(await claimFinalization(f.pool), null);
  assert.equal((await f.pool.query('SELECT status FROM finalization_jobs WHERE document_id=$1', [doc.id])).rows[0].status, 'action_required');
  await retryFinalization(f.pool, doc.id);
  const worker = createFinalizationWorker(f.pool, { signingIdentity: async () => { throw new FinalizationActionRequiredError('key_missing'); }, buildArtifact: async () => { assert.fail('must not build without the key'); } });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'action_required');
});

test('v2-to-v3 database migration preserves pending legacy records, completed bytes, and events', async t => {
  const f = await fixture(t); const doc = await f.document(1); assert.equal(await countLegacyPendingDocuments(f.pool), 1);
  await transaction(f.pool, async client => {
    await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [doc.id]);
    await client.query('UPDATE recipients SET signed_at=$2 WHERE id=$1', [doc.recipientIds[0], fixedTime]);
    const checkpoint = await appendEvent(client, doc.id, 'recipient.signed', fixedTime, {});
    await client.query("UPDATE documents SET status='completed',completed=$2,completed_hash=$3,completed_at=$4,signing_checkpoint=$5 WHERE id=$1", [doc.id, artifact.bytes, sha256(artifact.bytes), fixedTime, checkpoint]);
    await appendEvent(client, doc.id, 'document.completed', fixedTime, { completedHash: sha256(artifact.bytes), signingCheckpoint: checkpoint });
  });
  assert.equal(await countLegacyPendingDocuments(f.pool), 0);
  const pending = await f.document(1);
  const oldEvents = (await f.pool.query('SELECT * FROM events ORDER BY document_id,sequence')).rows;
  assert.ok(oldEvents.every(event => !Object.hasOwn(event.data, 'eventNonce')), 'legacy audit bytes retain their original data shape');
  // Reconstruct the previous storage shape in this disposable schema, preserving
  // actual legacy documents/events, then execute the real version-3 migration.
  await f.pool.query(`
    DROP TABLE email_deliveries; DROP FUNCTION guard_email_delivery();
    DROP TRIGGER documents_attachment ON documents; DROP FUNCTION guard_attachment();
    DROP TRIGGER recipients_parent_valid ON recipients; DROP FUNCTION guard_recipient_parent();
    ALTER TABLE recipients DROP COLUMN parent_recipient_id;
    ALTER TABLE documents DROP COLUMN parent_id, DROP COLUMN attachment_number;
    DROP TABLE completed_copy_access,finalization_attempts,finalization_jobs,sealing_key_events,sealing_certificates,sealing_identity;
    DROP FUNCTION guard_completed_copy_access();
    ALTER TABLE recipients DROP CONSTRAINT recipients_id_document_unique;
    DROP FUNCTION guard_finalization_attempt();
    ALTER TABLE recipients DROP COLUMN signing_intent;
    ALTER TABLE documents DROP COLUMN evidence_version, DROP COLUMN evidence_core, DROP COLUMN protection_policy, DROP COLUMN seal_metadata;
    ALTER TABLE documents DROP CONSTRAINT documents_status_check;
    ALTER TABLE documents ADD CONSTRAINT documents_status_check CHECK(status IN ('pending','completed','cancelled'));
    DELETE FROM migrations WHERE version>=3;
  `);
  const reopened = await createDatabase(databaseUrl!, f.schema);
  t.after(() => reopened.end());
  const row = await status(reopened, doc.id);
  assert.deepEqual(row.completed, artifact.bytes); assert.equal(row.evidence_version, 1); assert.equal(row.seal_metadata, null);
  assert.equal((await reopened.query('SELECT count(*) FROM finalization_jobs')).rows[0].count, '0');
  assert.equal(await countLegacyPendingDocuments(reopened), 1);
  assert.equal((await status(reopened, pending.id)).status, 'pending');
  assert.deepEqual((await reopened.query('SELECT * FROM events ORDER BY document_id,sequence')).rows, oldEvents);
});


test('completed copy tokens require a signed recipient of that exact completed document', async t => {
  const f = await fixture(t); const doc = await f.document(); const other = await f.document();
  const insert = (documentId: string, recipientId: string) => f.pool.query('INSERT INTO completed_copy_access(token_hash,document_id,recipient_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [sha256(uid()), documentId, recipientId, Date.now()+86400000, fixedTime]);
  await assert.rejects(insert(doc.id, doc.recipientIds[0]), /requires a signed recipient/);
  await f.accept(doc.id, doc.recipientIds[0]);
  await assert.rejects(insert(doc.id, doc.recipientIds[0]), /requires a signed recipient/);
  const worker = createFinalizationWorker(f.pool, { buildArtifact: async () => artifact });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'completed');
  await assert.rejects(insert(doc.id, other.recipientIds[0]), /requires a signed recipient/);
  assert.equal((await insert(doc.id, doc.recipientIds[0])).rowCount, 1);
  await assert.rejects(f.pool.query('UPDATE completed_copy_access SET recipient_id=$1', [other.recipientIds[0]]), /append-only/);
  assert.equal((await f.pool.query('DELETE FROM completed_copy_access')).rowCount, 1, 'expired or revoked access can be removed without altering signature evidence');
});


test('a transient key failure retries automatically and retains its sanitized cause', async t => {
  const f = await fixture(t); const doc = await f.document(); await f.accept(doc.id, doc.recipientIds[0]);
  let available = false;
  const worker = createFinalizationWorker(f.pool, {
    signingIdentity: async () => { if (!available) throw new FinalizationRetryableError('key_unavailable'); return identity; },
    buildArtifact: async () => artifact,
  }, { retryBaseMs: 0 });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'retry');
  assert.equal((await f.pool.query('SELECT last_error_code FROM finalization_jobs WHERE document_id=$1', [doc.id])).rows[0].last_error_code, 'key_unavailable');
  available = true;
  assert.equal((await worker.runOnce()).status, 'completed');
  assert.equal((await f.pool.query("SELECT count(*) FROM events WHERE document_id=$1 AND type='recipient.signed'", [doc.id])).rows[0].count, '1');
});

test('the publish hook runs inside the completion transaction', async t => {
  const f = await fixture(t); const doc = await f.document();
  await f.accept(doc.id, doc.recipientIds[0]);
  const seen: string[] = [];
  const worker = createFinalizationWorker(f.pool, { signingIdentity: identity, buildArtifact: async () => artifact }, {
    now: () => Date.parse(fixedTime),
    onPublished: async (client, documentId) => { seen.push((await client.query('SELECT status FROM documents WHERE id=$1', [documentId])).rows[0].status); },
  });
  t.after(() => worker.stop());
  assert.equal((await worker.runOnce()).status, 'completed');
  assert.deepEqual(seen, ['completed']);
  const failing = await f.document();
  await f.accept(failing.id, failing.recipientIds[0]);
  const rollback = createFinalizationWorker(f.pool, { signingIdentity: identity, buildArtifact: async () => artifact }, {
    now: () => Date.parse(fixedTime), onPublished: async () => { throw new FinalizationRetryableError('delivery_enqueue_failed'); },
  });
  t.after(() => rollback.stop());
  assert.equal((await rollback.runOnce()).status, 'retry');
  assert.equal((await status(f.pool, failing.id)).status, 'finalizing');
});
