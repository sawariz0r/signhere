import type { PoolClient } from 'pg';

export async function migrateAgents(db: PoolClient) {
  await db.query(`
    CREATE TABLE agent_keys (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), team_id uuid NOT NULL REFERENCES teams(id),
      name text NOT NULL, prefix text NOT NULL, token_hash text NOT NULL UNIQUE,
      scopes jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      last_used_at timestamptz, revoked_at timestamptz,
      CHECK(expires_at>created_at)
    );
    CREATE INDEX agent_keys_user ON agent_keys(user_id,created_at DESC);
    CREATE TABLE agent_requests (
      key_id uuid NOT NULL REFERENCES agent_keys(id), request_id uuid NOT NULL, operation text NOT NULL,
      input_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY(key_id,request_id)
    );
    CREATE TABLE agent_audit (
      id uuid PRIMARY KEY, key_id uuid NOT NULL REFERENCES agent_keys(id),
      operation text NOT NULL, resource_id text, outcome text NOT NULL DEFAULT 'success' CHECK(outcome ~ '^(success|http_[0-9]{3}|internal_error)$'), created_at timestamptz NOT NULL
    );
    CREATE TRIGGER agent_audit_immutable BEFORE UPDATE OR DELETE ON agent_audit FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
  `);
}
