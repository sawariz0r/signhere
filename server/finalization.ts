import type { Pool, PoolClient } from 'pg';
import { appendEvent, canonical, transaction, type Row } from './db.js';
import { sha256 } from './pdf.js';

export interface SigningCheckpoint { sequence: number; hash: string }
export interface FinalizationJob extends Row {
  document_id: string; generation: string; attempts: number; max_attempts: number;
  status: string; signing_identity: Row | null;
}
export interface FinalizationSnapshot {
  document: Row; recipients: Row[]; events: Row[]; checkpoint: SigningCheckpoint;
  evidenceCore: Buffer; job: FinalizationJob; signingIdentity: Row | null;
}
export interface FinalizationArtifact { bytes: Buffer; sealMetadata: Row }
export interface FinalizationServices {
  buildArtifact(snapshot: FinalizationSnapshot): Promise<FinalizationArtifact>;
  signingIdentity?: Row | (() => Promise<Row>);
  /** Called after the completed artifact is committed. Must not throw. */
  onPublished?(documentId: string): void;
}
export interface FinalizationOptions {
  leaseMs?: number; pollMs?: number; retryBaseMs?: number; retryMaxMs?: number;
  /** Application time controls displayed completion time; lease fencing always uses PostgreSQL time. */
  now?: () => number;
}
export class FinalizationRetryableError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'FinalizationRetryableError'; }
}
export class FinalizationActionRequiredError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'FinalizationActionRequiredError'; }
}
export type FinalizationResult = { status: 'idle' | 'completed' | 'retry' | 'action_required' | 'superseded'; documentId?: string; attempt?: number };
const MAX_CORE_BYTES = 32 * 1024 * 1024;
function errorCode(error: unknown) {
  return (error instanceof FinalizationActionRequiredError || error instanceof FinalizationRetryableError) && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'artifact_build_failed';
}
function leaseDuration(options: FinalizationOptions) {
  const value = options.leaseMs ?? 120000;
  if (!Number.isSafeInteger(value) || value < 300 || value > 3600000) throw new Error('Invalid finalization lease duration.');
  return value;
}

/** Call in the transaction that accepts the last signature, while holding its document lock. */
export async function enqueueFinalization(client: PoolClient, input: {
  documentId: string; checkpoint: SigningCheckpoint; evidenceCore: Buffer; maxAttempts?: number;
}) {
  if (!Buffer.isBuffer(input.evidenceCore) || !input.evidenceCore.length || input.evidenceCore.length > MAX_CORE_BYTES) throw new Error('Evidence core exceeds supported bounds.');
  if (!Number.isSafeInteger(input.checkpoint.sequence) || input.checkpoint.sequence < 1 || !/^[a-f0-9]{64}$/.test(input.checkpoint.hash)) throw new Error('Invalid signing checkpoint.');
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('Invalid finalization attempt limit.');
  const document = (await client.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [input.documentId])).rows[0];
  if (!document || document.evidence_version !== 2) throw new Error('Durable finalization requires schema-v2 evidence.');
  if (document.status === 'finalizing') {
    if (!document.evidence_core.equals(input.evidenceCore) || canonical(document.signing_checkpoint) !== canonical(input.checkpoint)) throw new Error('Finalization was already frozen with different evidence.');
    return document;
  }
  if (document.status !== 'pending') throw new Error('Document cannot enter finalization.');
  const updated = (await client.query("UPDATE documents SET status='finalizing',signing_checkpoint=$2,evidence_core=$3 WHERE id=$1 RETURNING *", [input.documentId, input.checkpoint, input.evidenceCore])).rows[0];
  await client.query('INSERT INTO finalization_jobs(document_id,max_attempts) VALUES($1,$2)', [input.documentId, maxAttempts]);
  return updated;
}

export async function countLegacyPendingDocuments(pool: Pool) {
  return Number((await pool.query("SELECT count(*) AS count FROM documents WHERE evidence_version=1 AND status='pending'")).rows[0].count);
}

/** Claim never locks a document or performs PDF/network work. An expired lease is recoverable. */
export async function claimFinalization(pool: Pool, options: FinalizationOptions = {}): Promise<FinalizationJob | null> {
  const leaseMs = leaseDuration(options);
  return transaction(pool, async client => {
    await client.query(`WITH exhausted AS (
      UPDATE finalization_jobs SET status='action_required',lease_until=NULL,last_error_code='attempts_exhausted',updated_at=clock_timestamp()
      WHERE status='running' AND lease_until<=clock_timestamp() AND attempts>=max_attempts RETURNING document_id,generation
    ) UPDATE finalization_attempts a SET status='action_required',finished_at=clock_timestamp(),error_code='attempts_exhausted'
      FROM exhausted WHERE a.document_id=exhausted.document_id AND a.generation=exhausted.generation AND a.status='running'`);
    const result = await client.query(`WITH candidate AS (
        SELECT document_id FROM finalization_jobs
        WHERE attempts<max_attempts AND ((status IN ('queued','retry') AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()))
        ORDER BY available_at,document_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE finalization_jobs j SET status='running',attempts=j.attempts+1,generation=j.generation+1,
        lease_until=clock_timestamp()+($1::integer * interval '1 millisecond'),updated_at=clock_timestamp(),last_error_code=NULL
      FROM candidate WHERE j.document_id=candidate.document_id RETURNING j.*`, [leaseMs]);
    const job = result.rows[0];
    if (!job) return null;
    await client.query("UPDATE finalization_attempts SET status='superseded',finished_at=clock_timestamp(),error_code='lease_expired' WHERE document_id=$1 AND status='running'", [job.document_id]);
    await client.query('INSERT INTO finalization_attempts(document_id,generation,attempt,signing_identity) VALUES($1,$2,$3,$4)', [job.document_id, job.generation, job.attempts, job.signing_identity]);
    return job;
  });
}

async function pinIdentity(pool: Pool, job: FinalizationJob, identity: Row | null) {
  if (job.signing_identity && canonical(job.signing_identity) !== canonical(identity)) throw new FinalizationActionRequiredError('signing_identity_changed');
  return transaction(pool, async client => {
    const result = await client.query(`UPDATE finalization_jobs SET signing_identity=$3,updated_at=clock_timestamp()
      WHERE document_id=$1 AND generation=$2 AND status='running' AND lease_until>clock_timestamp() RETURNING *`, [job.document_id, job.generation, identity]);
    if (result.rowCount) await client.query('UPDATE finalization_attempts SET signing_identity=$3 WHERE document_id=$1 AND generation=$2', [job.document_id, job.generation, identity]);
    return result.rows[0] as FinalizationJob | undefined;
  });
}

export async function loadFinalizationSnapshot(pool: Pool, job: FinalizationJob): Promise<FinalizationSnapshot> {
  const document = (await pool.query('SELECT * FROM documents WHERE id=$1', [job.document_id])).rows[0];
  if (!document || document.status !== 'finalizing' || !document.evidence_core || !document.signing_checkpoint) throw new FinalizationActionRequiredError('invalid_frozen_evidence');
  const recipients = (await pool.query('SELECT * FROM recipients WHERE document_id=$1 ORDER BY position', [job.document_id])).rows;
  const events = (await pool.query('SELECT * FROM events WHERE document_id=$1 ORDER BY sequence', [job.document_id])).rows;
  const last = events.at(-1);
  if (!recipients.length || recipients.some(recipient => !recipient.signed_at) || last?.type !== 'recipient.signed' || last.sequence !== document.signing_checkpoint.sequence || last.hash !== document.signing_checkpoint.hash) throw new FinalizationActionRequiredError('invalid_frozen_evidence');
  return { document, recipients, events, checkpoint: document.signing_checkpoint, evidenceCore: document.evidence_core, job, signingIdentity: job.signing_identity };
}

/** Only the current live lease can publish. This is the sole transaction around artifact persistence. */
export async function publishFinalization(pool: Pool, snapshot: FinalizationSnapshot, artifact: FinalizationArtifact, options: FinalizationOptions = {}) {
  if (!Buffer.isBuffer(artifact.bytes) || !artifact.bytes.length || !artifact.sealMetadata || typeof artifact.sealMetadata !== 'object' || Array.isArray(artifact.sealMetadata)) throw new Error('Invalid finalization artifact.');
  const completedHash = sha256(artifact.bytes);
  const evidenceCoreHash = sha256(snapshot.evidenceCore);
  const completedAt = new Date((options.now ?? Date.now)()).toISOString();
  return transaction(pool, async client => {
    const document = (await client.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE', [snapshot.job.document_id])).rows[0];
    const job = (await client.query("SELECT *,lease_until>clock_timestamp() AS lease_live FROM finalization_jobs WHERE document_id=$1 FOR UPDATE", [snapshot.job.document_id])).rows[0];
    if (!job || job.status !== 'running' || job.generation !== snapshot.job.generation || !job.lease_live || document?.status !== 'finalizing') return false;
    if (!document.evidence_core.equals(snapshot.evidenceCore) || canonical(document.signing_checkpoint) !== canonical(snapshot.checkpoint) || canonical(document.protection_policy) !== canonical(snapshot.document.protection_policy) || canonical(job.signing_identity) !== canonical(snapshot.signingIdentity)) throw new FinalizationActionRequiredError('frozen_input_changed');
    await client.query("UPDATE documents SET status='completed',completed=$2,completed_hash=$3,completed_at=$4,seal_metadata=$5 WHERE id=$1", [document.id, artifact.bytes, completedHash, completedAt, artifact.sealMetadata]);
    await appendEvent(client, document.id, 'document.completed', completedAt, {
      originalHash: document.original_hash, completedHash, signingCheckpoint: snapshot.checkpoint,
      evidenceVersion: 2, evidenceCoreHash, seal: artifact.sealMetadata,
    });
    await client.query("UPDATE finalization_jobs SET status='completed',lease_until=NULL,last_error_code=NULL,updated_at=clock_timestamp() WHERE document_id=$1 AND generation=$2", [document.id, job.generation]);
    await client.query("UPDATE finalization_attempts SET status='completed',finished_at=clock_timestamp() WHERE document_id=$1 AND generation=$2", [document.id, job.generation]);
    return true;
  });
}

export async function failFinalization(pool: Pool, job: FinalizationJob, error: unknown, options: FinalizationOptions = {}): Promise<FinalizationResult> {
  const actionRequired = error instanceof FinalizationActionRequiredError || job.attempts >= job.max_attempts;
  const status = actionRequired ? 'action_required' : 'retry';
  const delay = Math.min(options.retryMaxMs ?? 300000, (options.retryBaseMs ?? 1000) * 2 ** Math.max(0, job.attempts - 1));
  return transaction(pool, async client => {
    const result = await client.query(`UPDATE finalization_jobs SET status=$3,lease_until=NULL,last_error_code=$4,
      available_at=clock_timestamp()+($5::integer * interval '1 millisecond'),updated_at=clock_timestamp()
      WHERE document_id=$1 AND generation=$2 AND status='running' AND lease_until>clock_timestamp()`, [job.document_id, job.generation, status, errorCode(error), delay]);
    if (result.rowCount) await client.query('UPDATE finalization_attempts SET status=$3,finished_at=clock_timestamp(),error_code=$4 WHERE document_id=$1 AND generation=$2', [job.document_id, job.generation, status, errorCode(error)]);
    return { status: result.rowCount ? status : 'superseded', documentId: job.document_id, attempt: job.attempts };
  });
}

/** The caller must authorize the owner. Changing a pinned identity requires an explicit recovery action. */
export async function retryFinalization(pool: Pool, documentId: string, options: { resetSigningIdentity?: boolean } = {}) {
  const result = await pool.query(`UPDATE finalization_jobs SET status='queued',attempts=0,generation=generation+1,
    available_at=clock_timestamp(),updated_at=clock_timestamp(),last_error_code=NULL,
    signing_identity=CASE WHEN $2 THEN NULL ELSE signing_identity END
    WHERE document_id=$1 AND status='action_required' RETURNING document_id`, [documentId, options.resetSigningIdentity === true]);
  return !!result.rowCount;
}

export function createFinalizationWorker(pool: Pool, services: FinalizationServices, options: FinalizationOptions = {}) {
  const leaseMs = leaseDuration(options);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<FinalizationResult> | undefined;
  let stopping = false;
  let started = false;
  async function processOne(): Promise<FinalizationResult> {
    let job = await claimFinalization(pool, options);
    if (!job) return { status: 'idle' };
    let heartbeatPending: Promise<unknown> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = pool.query(`UPDATE finalization_jobs SET lease_until=clock_timestamp()+($3::integer * interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE document_id=$1 AND generation=$2 AND status='running' AND lease_until>clock_timestamp()`, [job!.document_id, job!.generation, leaseMs])
        .catch(() => { /* Publication still requires a live database lease. */ })
        .finally(() => { heartbeatPending = undefined; });
    }, Math.max(100, Math.floor(leaseMs / 3)));
    heartbeat.unref();
    try {
      const identity = typeof services.signingIdentity === 'function' ? await services.signingIdentity() : services.signingIdentity ?? null;
      const pinned = await pinIdentity(pool, job, identity);
      if (!pinned) return { status: 'superseded', documentId: job.document_id, attempt: job.attempts };
      job = pinned;
      const snapshot = await loadFinalizationSnapshot(pool, job);
      const artifact = await services.buildArtifact(snapshot);
      const published = await publishFinalization(pool, snapshot, artifact, options);
      if (published) services.onPublished?.(job.document_id);
      return { status: published ? 'completed' : 'superseded', documentId: job.document_id, attempt: job.attempts };
    } catch (error) {
      return await failFinalization(pool, job, error, options);
    } finally { clearInterval(heartbeat); await heartbeatPending; }
  }
  function runOnce(): Promise<FinalizationResult> {
    if (stopping) return Promise.resolve({ status: 'idle' });
    if (!active) active = processOne().finally(() => { active = undefined; });
    return active;
  }
  async function tick() {
    let result: FinalizationResult = { status: 'idle' };
    try { result = await runOnce(); }
    catch { console.error('signhere: finalization worker unavailable'); }
    if (!stopping) {
      timer = setTimeout(() => { void tick(); }, result.status === 'completed' ? 0 : (options.pollMs ?? 1000));
      timer.unref();
    }
  }
  return {
    runOnce,
    start() { if (started || stopping) return; started = true; void tick(); },
    async stop() { stopping = true; if (timer) clearTimeout(timer); await active; },
  };
}
