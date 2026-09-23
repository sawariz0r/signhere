import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
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
export async function createDatabase(databaseUrl: string, schema = 'public') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema.');
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, options: '-c search_path=' + schema + ' -c statement_timeout=30000 -c idle_in_transaction_session_timeout=45000' });
  pool.on('error', error => console.error('signhere: database connection failed', (error as Row).code ?? 'connection'));
  try {
    await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('signhere-schema-v1'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
      await client.query('CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, applied_at text NOT NULL)');
      const existing = await client.query('SELECT max(version) AS version FROM migrations');
      const version = Number(existing.rows[0].version);
      if (version > 2) throw new Error('Database schema is newer than this application.');
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
          IF ROW(OLD.id,OLD.team_id,OLD.created_by,OLD.title,OLD.file_name,OLD.original,OLD.original_hash,OLD.size,OLD.pages,OLD.sender,OLD.method_id,OLD.method_version,OLD.created_at,OLD.uploaded,OLD.preparation)
            IS DISTINCT FROM ROW(NEW.id,NEW.team_id,NEW.created_by,NEW.title,NEW.file_name,NEW.original,NEW.original_hash,NEW.size,NEW.pages,NEW.sender,NEW.method_id,NEW.method_version,NEW.created_at,NEW.uploaded,NEW.preparation)
            THEN RAISE EXCEPTION 'Document source is immutable'; END IF;
          IF OLD.status <> 'pending' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Closed document is immutable'; END IF;
          RETURN NEW; END $$;
        DROP TRIGGER IF EXISTS documents_immutable ON documents;
        CREATE TRIGGER documents_immutable BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION guard_document();
        CREATE OR REPLACE FUNCTION guard_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF ROW(OLD.id,OLD.document_id,OLD.position,OLD.name,OLD.email,OLD.method_id,OLD.method_version) IS DISTINCT FROM ROW(NEW.id,NEW.document_id,NEW.position,NEW.name,NEW.email,NEW.method_id,NEW.method_version)
            THEN RAISE EXCEPTION 'Recipient assignment is immutable'; END IF;
          IF OLD.signed_at IS NOT NULL AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Completed signature is immutable'; END IF;
          RETURN NEW; END $$;
        DROP TRIGGER IF EXISTS recipients_immutable ON recipients;
        CREATE TRIGGER recipients_immutable BEFORE UPDATE ON recipients FOR EACH ROW EXECUTE FUNCTION guard_recipient();
      `);
      if (version < 2) await client.query(`
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded bytea;
        ALTER TABLE documents ADD COLUMN IF NOT EXISTS preparation jsonb;
        ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_preparation_pair;
        ALTER TABLE documents ADD CONSTRAINT documents_preparation_pair CHECK ((uploaded IS NULL) = (preparation IS NULL));
      `);
      await client.query('INSERT INTO migrations(version,applied_at) VALUES(1,$1),(2,$1) ON CONFLICT DO NOTHING', [new Date().toISOString()]);
    });
    return pool;
  } catch (error) { await pool.end(); throw error; }
}
export async function appendEvent(client: PoolClient, documentId: string, type: string, at: string, data: Row) {
  data = JSON.parse(JSON.stringify(data)) as Row;
  const last = (await client.query('SELECT sequence,hash FROM events WHERE document_id=$1 ORDER BY sequence DESC LIMIT 1', [documentId])).rows[0];
  const sequence = last ? last.sequence + 1 : 1;
  const previousHash = last?.hash ?? '0'.repeat(64);
  const hash = sha256(canonical({ documentId, sequence, type, at, data, previousHash }));
  await client.query('INSERT INTO events(document_id,sequence,type,at,data,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7)', [documentId, sequence, type, at, data, previousHash, hash]);
  return { sequence, hash };
}


