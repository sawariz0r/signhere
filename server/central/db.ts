import { Pool } from 'pg';
import { transaction } from '../db.js';

/**
 * Central state is short-lived workflow state, not a document archive: no PDF bytes,
 * drawings or audit bundles. Rows are deleted after the retention window (see app.ts).
 */
export async function createCentralDatabase(databaseUrl: string, schema = 'central') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema.');
  const pool = new Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    options: '-c search_path=' + schema + ' -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000' });
  pool.on('error', error => console.error('signhere-central: database connection failed', (error as { code?: string }).code ?? 'connection'));
  try {
    await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('signhere-central-schema'))");
      await client.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
      await client.query('CREATE TABLE IF NOT EXISTS central_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const version = Number((await client.query('SELECT max(version) AS version FROM central_migrations')).rows[0].version ?? 0);
      if (version > 1) throw new Error('Central database schema is newer than this application.');
      if (version < 1) await client.query(`
        CREATE TABLE instances (
          id text PRIMARY KEY CHECK(id ~ '^ins_[A-Za-z0-9_-]{22}$'), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
          origin text NOT NULL, status text NOT NULL CHECK(status IN ('active','suspended')),
          scopes text[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE instance_credentials (
          id text PRIMARY KEY, instance_id text NOT NULL REFERENCES instances(id),
          secret_hash text NOT NULL UNIQUE CHECK(secret_hash ~ '^[a-f0-9]{64}$'),
          created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
        );
        CREATE TABLE approvals (
          id text PRIMARY KEY CHECK(id ~ '^apr_[A-Za-z0-9_-]{22}$'), instance_id text NOT NULL REFERENCES instances(id),
          document_id text NOT NULL, revision_id text NOT NULL, recipient_id text NOT NULL,
          email text NOT NULL, claimed_name text NOT NULL, title text NOT NULL,
          prepared_sha256 text NOT NULL, prepared_size integer NOT NULL, intent_sha256 text NOT NULL, policy_sha256 text NOT NULL,
          document_url text NOT NULL, return_url text, request_fingerprint text NOT NULL,
          capability_hash text NOT NULL UNIQUE CHECK(capability_hash ~ '^[a-f0-9]{64}$'),
          status text NOT NULL CHECK(status IN ('pending','email_confirmed','approved','cancelled')),
          created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
          email_confirmed_at timestamptz, approved_at timestamptz, receipt text, receipt_id uuid,
          UNIQUE(instance_id,document_id,revision_id,recipient_id),
          CHECK((status='approved')=(receipt IS NOT NULL AND receipt_id IS NOT NULL AND approved_at IS NOT NULL)),
          CHECK(status IN ('pending','cancelled') OR email_confirmed_at IS NOT NULL)
        );
        CREATE INDEX approvals_open ON approvals(instance_id) WHERE status IN ('pending','email_confirmed');
        CREATE INDEX approvals_expiry ON approvals(expires_at);
        CREATE TABLE email_challenges (
          approval_id text PRIMARY KEY REFERENCES approvals(id) ON DELETE CASCADE,
          code_hash text NOT NULL, sent_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
          attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), sends integer NOT NULL DEFAULT 1 CHECK(sends>=1)
        );
        -- An issued receipt is final: it cannot be altered, replaced or reopened (deletion by retention only).
        CREATE FUNCTION guard_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.status IN ('approved','cancelled') AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Closed approval is immutable'; END IF;
          IF ROW(OLD.id,OLD.instance_id,OLD.document_id,OLD.revision_id,OLD.recipient_id,OLD.email,OLD.claimed_name,OLD.title,OLD.prepared_sha256,OLD.prepared_size,OLD.intent_sha256,OLD.policy_sha256,OLD.document_url,OLD.return_url,OLD.request_fingerprint,OLD.capability_hash,OLD.created_at,OLD.expires_at)
            IS DISTINCT FROM ROW(NEW.id,NEW.instance_id,NEW.document_id,NEW.revision_id,NEW.recipient_id,NEW.email,NEW.claimed_name,NEW.title,NEW.prepared_sha256,NEW.prepared_size,NEW.intent_sha256,NEW.policy_sha256,NEW.document_url,NEW.return_url,NEW.request_fingerprint,NEW.capability_hash,NEW.created_at,NEW.expires_at)
            THEN RAISE EXCEPTION 'Approval context is immutable'; END IF;
          IF OLD.status='email_confirmed' AND NEW.status='pending' THEN RAISE EXCEPTION 'Confirmation cannot be undone'; END IF;
          RETURN NEW; END $$;
        CREATE TRIGGER approvals_immutable BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION guard_approval();
      `);
      await client.query('INSERT INTO central_migrations(version) VALUES(1) ON CONFLICT DO NOTHING');
    });
  } catch (error) { await pool.end(); throw error; }
  return pool;
}
