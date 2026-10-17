import type { PoolClient } from 'pg';

export async function migrateOAuth(db: PoolClient) {
  await db.query(`
    ALTER TABLE agent_keys ADD COLUMN kind text NOT NULL DEFAULT 'manual' CHECK(kind IN ('manual','oauth')),
      ADD COLUMN resource text, ADD COLUMN client_id text,
      ADD CHECK((kind='oauth')=(resource IS NOT NULL AND client_id IS NOT NULL));
    CREATE TABLE oauth_pending (
      request_hash text PRIMARY KEY, browser_hash text NOT NULL, client_id text NOT NULL,
      redirect_uri text NOT NULL, resource text NOT NULL, scope jsonb NOT NULL, state text NOT NULL,
      challenge text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      user_id uuid REFERENCES users(id), session_hash text, consumed_at timestamptz,
      CHECK((user_id IS NULL)=(session_hash IS NULL))
    );
    CREATE TABLE oauth_codes (
      code_hash text PRIMARY KEY, key_id uuid NOT NULL REFERENCES agent_keys(id),
      client_id text NOT NULL, redirect_uri text NOT NULL, resource text NOT NULL,
      challenge text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
    );
    CREATE TABLE oauth_access_tokens (
      token_hash text PRIMARY KEY, key_id uuid NOT NULL REFERENCES agent_keys(id),
      resource text NOT NULL, expires_at timestamptz NOT NULL
    );
    CREATE INDEX oauth_pending_expiry ON oauth_pending(expires_at);
    CREATE INDEX oauth_codes_key ON oauth_codes(key_id);
    CREATE INDEX oauth_access_key ON oauth_access_tokens(key_id);
  `);
}
