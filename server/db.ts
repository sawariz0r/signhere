import { Pool, type PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256 } from './pdf.js';

export type Row = Record<string, any>;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}';
}
export const uid = () => randomUUID();
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let connectionFailure: Error | undefined;
  const onError = (error: Error) => { connectionFailure = error; };
  client.on('error', onError);
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackError) { connectionFailure = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed'); }
    throw error;
  } finally { client.removeListener('error', onError); client.release(connectionFailure); }
}
export async function createDatabase(databaseUrl: string, schema = 'public', migrationDatabaseUrl?: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema.');
  const poolOptions = { max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, options: '-c search_path=' + schema + ' -c statement_timeout=30000 -c idle_in_transaction_session_timeout=45000' };
  const pool = new Pool({ ...poolOptions, connectionString: migrationDatabaseUrl ?? databaseUrl });
  pool.on('error', error => console.error('signhere: database connection failed', (error as Row).code ?? 'connection'));
  try {
    await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('signhere-schema-v1'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
      await client.query('CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at text NOT NULL)');
      const existing = await client.query('SELECT max(version) AS version FROM migrations');
      const version = Number(existing.rows[0].version);
      if (version > 4) throw new Error('Database schema is newer than this application.');
      await client.query(`
        CREATE TABLE IF NOT EXISTS teams (id uuid PRIMARY KEY, name text NOT NULL);
        CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), name text NOT NULL, email text NOT NULL UNIQUE, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('owner','member')), created_at text NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at bigint NOT NULL);
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS invitations (id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), email text NOT NULL, token_hash text NOT NULL UNIQUE, expires_at bigint NOT NULL, accepted_at text, created_at text NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (
          id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), created_by uuid NOT NULL REFERENCES users(id), title text NOT NULL, file_name text NOT NULL,
          original bytea NOT NULL, original_hash text NOT NULL, size integer NOT NULL, pages integer NOT NULL, status text NOT NULL CHECK(status IN ('pending','completed','cancelled')),
          sender jsonb NOT NULL, method_id text NOT NULL, method_version text NOT NULL, created_at text NOT NULL, completed_at text, completed bytea, completed_hash text, signing_checkpoint jsonb,
          CHECK ((status = 'completed') = (completed IS NOT NULL AND completed_hash IS NOT NULL AND completed_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS documents_team ON documents(team_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS documents_completed_hash ON documents(completed_hash) WHERE status='completed';
        CREATE TABLE IF NOT EXISTS recipients (
          id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id), position integer NOT NULL, name text NOT NULL, email text NOT NULL, method_id text NOT NULL, method_version text NOT NULL,
          token_hash text NOT NULL UNIQUE, expires_at bigint NOT NULL, viewed_at text, signed_at text, claimed_name text, signature jsonb, evidence jsonb, submission_hash text,
          UNIQUE(document_id,position)
        );
        CREATE INDEX IF NOT EXISTS recipients_document ON recipients(document_id);
        CREATE TABLE IF NOT EXISTS events (
          document_id uuid NOT NULL REFERENCES documents(id), sequence integer NOT NULL, type text NOT NULL, at text NOT NULL, data jsonb NOT NULL, previous_hash text NOT NULL, hash text NOT NULL,
          PRIMARY KEY(document_id,sequence)
        );
        CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit events are append-only'; END $$;
        DROP TRIGGER IF EXISTS events_immutable ON events;
        CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

        CREATE OR REPLACE FUNCTION guard_event_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE current_status text; previous_record record; BEGIN
          SELECT status INTO current_status FROM documents WHERE id=NEW.document_id FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'Audit document does not exist'; END IF;
          SELECT sequence,hash,type INTO previous_record FROM events WHERE document_id=NEW.document_id ORDER BY sequence DESC LIMIT 1;
          IF NEW.sequence <> COALESCE(previous_record.sequence,0)+1 OR NEW.previous_hash <> COALESCE(previous_record.hash,repeat('0',64))
            THEN RAISE EXCEPTION 'Audit sequence or previous hash is invalid'; END IF;
          IF (previous_record.sequence IS NULL AND NEW.type <> 'document.created') OR (previous_record.sequence IS NOT NULL AND NEW.type = 'document.created')
            THEN RAISE EXCEPTION 'Audit creation event is invalid'; END IF;
          IF previous_record.type IN ('document.completed','document.cancelled') THEN RAISE EXCEPTION 'Closed audit is immutable'; END IF;
          IF NEW.type NOT IN ('document.created','recipient.viewed','recipient.signed','link.rotated','document.cancelled','document.completed')
            THEN RAISE EXCEPTION 'Unknown audit event'; END IF;
          IF current_status <> 'pending' AND NOT (current_status='completed' AND NEW.type='document.completed' AND previous_record.type='recipient.signed')
            THEN RAISE EXCEPTION 'Closed audit is immutable'; END IF;
          IF NEW.type='document.completed' AND current_status <> 'completed' THEN RAISE EXCEPTION 'Completion has no artifact'; END IF;
          RETURN NEW; END $$;
        DROP TRIGGER IF EXISTS events_ordered ON events;
        CREATE TRIGGER events_ordered BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION guard_event_insert();
        DROP TRIGGER IF EXISTS recipients_no_delete ON recipients;
        CREATE TRIGGER recipients_no_delete BEFORE DELETE ON recipients FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
        DROP TRIGGER IF EXISTS documents_no_delete ON documents;
        CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
        DROP TRIGGER IF EXISTS events_no_truncate ON events;
        CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
        DROP TRIGGER IF EXISTS recipients_no_truncate ON recipients;
        CREATE TRIGGER recipients_no_truncate BEFORE TRUNCATE ON recipients FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
        DROP TRIGGER IF EXISTS documents_no_truncate ON documents;
        CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
        CREATE OR REPLACE FUNCTION guard_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF ROW(OLD.id,OLD.team_id,OLD.created_by,OLD.title,OLD.file_name,OLD.original,OLD.original_hash,OLD.size,OLD.pages,OLD.sender,OLD.method_id,OLD.method_version,OLD.created_at,OLD.uploaded,OLD.preparation,OLD.evidence_version,OLD.protection_policy,OLD.parent_id,OLD.attachment_number)
            IS DISTINCT FROM ROW(NEW.id,NEW.team_id,NEW.created_by,NEW.title,NEW.file_name,NEW.original,NEW.original_hash,NEW.size,NEW.pages,NEW.sender,NEW.method_id,NEW.method_version,NEW.created_at,NEW.uploaded,NEW.preparation,NEW.evidence_version,NEW.protection_policy,NEW.parent_id,NEW.attachment_number)
            THEN RAISE EXCEPTION 'Document source and protection policy are immutable'; END IF;
          IF OLD.status IN ('completed','cancelled') AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Closed document is immutable'; END IF;
          IF OLD.evidence_version=1 THEN
            IF NEW.status='finalizing' OR NEW.evidence_core IS NOT NULL OR NEW.seal_metadata IS NOT NULL THEN RAISE EXCEPTION 'Legacy evidence cannot be upgraded in place'; END IF;
          ELSE
            IF OLD.status='pending' AND NEW.status='completed' THEN RAISE EXCEPTION 'Sealed documents require durable finalization'; END IF;
            IF OLD.status='pending' AND NEW.status<>'finalizing' AND ROW(OLD.evidence_core,OLD.signing_checkpoint,OLD.seal_metadata) IS DISTINCT FROM ROW(NEW.evidence_core,NEW.signing_checkpoint,NEW.seal_metadata)
              THEN RAISE EXCEPTION 'Evidence freezes only at finalization'; END IF;
            IF OLD.status='pending' AND NEW.status='finalizing' THEN
              IF NEW.evidence_core IS NULL OR NEW.signing_checkpoint IS NULL OR NOT EXISTS(SELECT 1 FROM recipients WHERE document_id=OLD.id)
                OR EXISTS(SELECT 1 FROM recipients WHERE document_id=OLD.id AND signed_at IS NULL)
                THEN RAISE EXCEPTION 'Finalization requires every signature and frozen evidence'; END IF;
              IF NOT EXISTS(SELECT 1 FROM events WHERE document_id=OLD.id AND type='recipient.signed' AND sequence=(NEW.signing_checkpoint->>'sequence')::integer AND hash=NEW.signing_checkpoint->>'hash'
                AND sequence=(SELECT max(sequence) FROM events WHERE document_id=OLD.id))
                THEN RAISE EXCEPTION 'Invalid finalization checkpoint'; END IF;
            END IF;
            IF OLD.status='finalizing' THEN
              IF ROW(OLD.evidence_core,OLD.signing_checkpoint) IS DISTINCT FROM ROW(NEW.evidence_core,NEW.signing_checkpoint) THEN RAISE EXCEPTION 'Frozen evidence is immutable'; END IF;
              IF NEW.status NOT IN ('finalizing','completed') THEN RAISE EXCEPTION 'Accepted signatures cannot be cancelled'; END IF;
              IF NEW.status='finalizing' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Finalizing document is immutable'; END IF;
              IF NEW.status='completed' AND (NEW.seal_metadata IS NULL OR NOT EXISTS(SELECT 1 FROM finalization_jobs WHERE document_id=OLD.id AND status='running'))
                THEN RAISE EXCEPTION 'Sealed completion requires an active job and seal metadata'; END IF;
            END IF;
          END IF;
          RETURN NEW; END $$;
        DROP TRIGGER IF EXISTS documents_immutable ON documents;
        CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION guard_document();
        CREATE OR REPLACE FUNCTION guard_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE current_status text; BEGIN
          SELECT status INTO current_status FROM documents WHERE id=OLD.document_id FOR UPDATE;
          IF current_status <> 'pending' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Closed recipient is immutable'; END IF;
          IF ROW(OLD.id,OLD.document_id,OLD.position,OLD.name,OLD.email,OLD.method_id,OLD.method_version,OLD.signing_intent,OLD.parent_recipient_id) IS DISTINCT FROM ROW(NEW.id,NEW.document_id,NEW.position,NEW.name,NEW.email,NEW.method_id,NEW.method_version,NEW.signing_intent,NEW.parent_recipient_id)
            THEN RAISE EXCEPTION 'Recipient assignment is immutable'; END IF;
          IF OLD.signed_at IS NOT NULL AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Completed signature is immutable'; END IF;
          RETURN NEW; END $$;
        CREATE OR REPLACE FUNCTION guard_recipient_insert() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE current_status text; BEGIN
          SELECT status INTO current_status FROM documents WHERE id=NEW.document_id FOR UPDATE;
          IF current_status <> 'pending' OR EXISTS(SELECT 1 FROM events WHERE document_id=NEW.document_id)
            THEN RAISE EXCEPTION 'Recipient assignment is immutable after document creation'; END IF;
          RETURN NEW; END $$;
        DROP TRIGGER IF EXISTS recipients_assignment ON recipients;
        CREATE TRIGGER recipients_assignment BEFORE INSERT ON recipients FOR EACH ROW EXECUTE FUNCTION guard_recipient_insert();
        DROP TRIGGER IF EXISTS recipients_immutable ON recipients;
        CREATE TRIGGER recipients_immutable BEFORE UPDATE ON recipients FOR EACH ROW EXECUTE FUNCTION guard_recipient();
      `);
      if (version < 2) await client.query(`
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded bytea;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS preparation jsonb;
        ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_preparation_pair;
        ALTER TABLE documents ADD CONSTRAINT documents_preparation_pair CHECK ((uploaded IS NULL) = (preparation IS NULL));
      `);
      if (version < 3) await client.query(`
        ALTER TABLE recipients ADD COLUMN IF NOT EXISTS signing_intent bytea;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS evidence_version integer NOT NULL DEFAULT 1 CHECK(evidence_version IN (1,2));
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS evidence_core bytea;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS protection_policy jsonb;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS seal_metadata jsonb;
        ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
        ALTER TABLE documents ADD CONSTRAINT documents_status_check CHECK(status IN ('pending','finalizing','completed','cancelled'));
        ALTER TABLE documents ADD CONSTRAINT documents_v2_policy CHECK(evidence_version=1 OR protection_policy IS NOT NULL);
        ALTER TABLE documents ADD CONSTRAINT documents_v2_core CHECK(evidence_version=1 OR (status IN ('finalizing','completed'))=(evidence_core IS NOT NULL AND signing_checkpoint IS NOT NULL));
        ALTER TABLE documents ADD CONSTRAINT documents_v2_seal CHECK(evidence_version=1 OR (status='completed')=(seal_metadata IS NOT NULL));
        CREATE TABLE finalization_jobs (
          document_id uuid PRIMARY KEY REFERENCES documents(id), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retry','action_required','completed')),
          generation bigint NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
          available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_until timestamptz, signing_identity jsonb,
          created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,64}$'),
          CHECK((status='running')=(lease_until IS NOT NULL))
        );
        CREATE TABLE finalization_attempts (
          document_id uuid NOT NULL REFERENCES finalization_jobs(document_id), generation bigint NOT NULL,
          attempt integer NOT NULL CHECK(attempt>0), started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
          status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','retry','action_required','superseded')),
          signing_identity jsonb, error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z_]{1,64}$'),
          PRIMARY KEY(document_id,generation), CHECK((status='running')=(finished_at IS NULL))
        );
        CREATE FUNCTION guard_finalization_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.status<>'running' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Finished finalization attempt is immutable'; END IF;
          IF ROW(OLD.document_id,OLD.generation,OLD.attempt,OLD.started_at) IS DISTINCT FROM ROW(NEW.document_id,NEW.generation,NEW.attempt,NEW.started_at)
            OR (OLD.signing_identity IS NOT NULL AND OLD.signing_identity IS DISTINCT FROM NEW.signing_identity)
            THEN RAISE EXCEPTION 'Finalization attempt identity is immutable'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER finalization_attempts_immutable BEFORE UPDATE ON finalization_attempts FOR EACH ROW EXECUTE FUNCTION guard_finalization_attempt();
        CREATE TRIGGER finalization_attempts_no_delete BEFORE DELETE ON finalization_attempts FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
        CREATE TRIGGER finalization_attempts_no_truncate BEFORE TRUNCATE ON finalization_attempts FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
        CREATE INDEX finalization_jobs_available ON finalization_jobs(available_at) WHERE status IN ('queued','retry','running');
        ALTER TABLE recipients ADD CONSTRAINT recipients_id_document_unique UNIQUE(id,document_id);
        CREATE TABLE completed_copy_access (
          token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'), document_id uuid NOT NULL REFERENCES documents(id),
          recipient_id uuid NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>0), created_at text NOT NULL,
          FOREIGN KEY(recipient_id,document_id) REFERENCES recipients(id,document_id)
        );
        CREATE INDEX completed_copy_access_expiry ON completed_copy_access(expires_at);
        CREATE FUNCTION guard_completed_copy_access() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NOT EXISTS(SELECT 1 FROM recipients r JOIN documents d ON d.id=r.document_id
            WHERE r.id=NEW.recipient_id AND r.document_id=NEW.document_id AND r.signed_at IS NOT NULL AND d.status='completed')
            THEN RAISE EXCEPTION 'Completed copy access requires a signed recipient and completed document'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER completed_copy_access_valid BEFORE INSERT ON completed_copy_access FOR EACH ROW EXECUTE FUNCTION guard_completed_copy_access();
        CREATE TRIGGER completed_copy_access_immutable BEFORE UPDATE ON completed_copy_access FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
        CREATE TABLE sealing_identity (
          singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), installation_id uuid NOT NULL UNIQUE,
          fingerprint text, certificate_pem text, key_id uuid, created_at text NOT NULL, updated_at text NOT NULL,
          CHECK((fingerprint IS NULL)=(certificate_pem IS NULL)), CHECK(fingerprint IS NULL OR key_id IS NOT NULL)
        );
        CREATE TABLE sealing_certificates (
          fingerprint text PRIMARY KEY, certificate_pem text NOT NULL, key_id uuid NOT NULL, created_at text NOT NULL
        );
        CREATE TABLE sealing_key_events (
          id uuid PRIMARY KEY, installation_id uuid NOT NULL, at text NOT NULL,
          previous_fingerprint text, new_fingerprint text NOT NULL, reason text NOT NULL
        );
        CREATE TRIGGER sealing_key_events_immutable BEFORE UPDATE OR DELETE ON sealing_key_events FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
        CREATE TRIGGER sealing_key_events_no_truncate BEFORE TRUNCATE ON sealing_key_events FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
        CREATE TRIGGER sealing_certificates_immutable BEFORE UPDATE OR DELETE ON sealing_certificates FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
        CREATE TRIGGER sealing_certificates_no_truncate BEFORE TRUNCATE ON sealing_certificates FOR EACH STATEMENT EXECUTE FUNCTION reject_event_mutation();
      `);
      // Bilagor (attachments) are separate signing documents bound to a completed main document.
      // The main document's closed audit chain stays immutable; each attachment has its own chain.
      if (version < 4) await client.query(`
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES documents(id);
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS attachment_number integer;
        ALTER TABLE documents ADD CONSTRAINT documents_attachment_pair CHECK((parent_id IS NULL)=(attachment_number IS NULL) AND (attachment_number IS NULL OR attachment_number BETWEEN 1 AND 100));
        CREATE UNIQUE INDEX documents_attachment_number ON documents(parent_id,attachment_number) WHERE parent_id IS NOT NULL;
        ALTER TABLE recipients ADD COLUMN IF NOT EXISTS parent_recipient_id uuid REFERENCES recipients(id);
        CREATE UNIQUE INDEX recipients_parent_unique ON recipients(document_id,parent_recipient_id) WHERE parent_recipient_id IS NOT NULL;
        CREATE INDEX recipients_parent ON recipients(parent_recipient_id) WHERE parent_recipient_id IS NOT NULL;
        CREATE FUNCTION guard_attachment() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE main record; BEGIN
          IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
          SELECT team_id,status,parent_id INTO main FROM documents WHERE id=NEW.parent_id FOR SHARE;
          IF NOT FOUND OR main.parent_id IS NOT NULL OR main.status <> 'completed' OR main.team_id <> NEW.team_id
            THEN RAISE EXCEPTION 'An attachment requires a completed main document in the same team'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER documents_attachment BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION guard_attachment();
        CREATE FUNCTION guard_recipient_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.parent_recipient_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM recipients r JOIN documents d ON d.parent_id=r.document_id
            WHERE d.id=NEW.document_id AND r.id=NEW.parent_recipient_id)
            THEN RAISE EXCEPTION 'An attachment party must belong to the main document'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER recipients_parent_valid BEFORE INSERT ON recipients FOR EACH ROW EXECUTE FUNCTION guard_recipient_parent();
      `);
      await client.query('INSERT INTO migrations(version,applied_at) VALUES(1,$1),(2,$1),(3,$1),(4,$1) ON CONFLICT DO NOTHING', [new Date().toISOString()]);
    });
  } catch (error) { await pool.end(); throw legacyRoleHint(error, migrationDatabaseUrl); }
  if (!migrationDatabaseUrl) return pool;
  await pool.end();
  const runtime = new Pool({ ...poolOptions, connectionString: databaseUrl });
  runtime.on('error', error => console.error('signhere: database connection failed', (error as Row).code ?? 'connection'));
  try { await assertRestrictedRuntimeRole(runtime, schema); }
  catch (error) { await runtime.end(); throw legacyRoleHint(error, migrationDatabaseUrl); }
  return runtime;
}
const legacyUpgrade = 'A database created before separate migration and runtime roles must be upgraded with deploy/postgres/upgrade-legacy-roles.sh (docs/deployment.md).';
function legacyRoleHint(error: unknown, migrationDatabaseUrl?: string) {
  // 28P01 is also what PostgreSQL reports for a role that does not exist.
  if (!migrationDatabaseUrl || !['28P01', '28000'].includes((error as Row)?.code)) return error;
  return new Error('PostgreSQL rejected the migration or runtime login. ' + legacyUpgrade, { cause: error });
}
// Separate roles only protect the immutability triggers if the runtime role cannot own or alter tables.
async function assertRestrictedRuntimeRole(runtime: Pool, schema: string) {
  const { rows: [role] } = await runtime.query(`SELECT r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls AS privileged,
    has_schema_privilege(current_user, $1, 'CREATE') OR has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owns
    FROM pg_roles r WHERE r.rolname=current_user`, [schema]);
  if (role.privileged || role.can_create || role.owns) throw new Error('DATABASE_URL must use the restricted runtime role, but it can create or own database objects. ' + legacyUpgrade);
}
export async function appendEvent(client: PoolClient, documentId: string, type: string, at: string, data: Row) {
  data = JSON.parse(JSON.stringify(data)) as Row;
  const document = (await client.query('SELECT evidence_version FROM documents WHERE id=$1', [documentId])).rows[0];
  if (document?.evidence_version === 2) data.eventNonce = randomBytes(32).toString('base64url');
  const last = (await client.query('SELECT sequence,hash FROM events WHERE document_id=$1 ORDER BY sequence DESC LIMIT 1', [documentId])).rows[0];
  const sequence = last ? last.sequence + 1 : 1;
  const previousHash = last?.hash ?? '0'.repeat(64);
  const hash = sha256(canonical({ documentId, sequence, type, at, data, previousHash }));
  await client.query('INSERT INTO events(document_id,sequence,type,at,data,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [documentId, sequence, type, at, data, previousHash, hash]);
  return { sequence, hash };
}


