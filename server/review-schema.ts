import type { PoolClient } from 'pg';

export async function migrateReviews(db: PoolClient) {
  await db.query(`
    CREATE TABLE drafts (
      id text PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), created_by uuid NOT NULL REFERENCES users(id),
      revision integer NOT NULL CHECK(revision>0), content jsonb NOT NULL, updated_at text NOT NULL, archived_at text
    );
    CREATE INDEX drafts_team ON drafts(team_id,updated_at DESC);
    CREATE TABLE draft_revisions (
      draft_id text NOT NULL REFERENCES drafts(id), revision integer NOT NULL, content jsonb NOT NULL,
      PRIMARY KEY(draft_id,revision)
    );
    CREATE TRIGGER draft_revisions_immutable BEFORE UPDATE OR DELETE ON draft_revisions FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
    CREATE TABLE review_versions (
      draft_id text NOT NULL REFERENCES drafts(id), version integer NOT NULL, source_revision integer NOT NULL,
      content jsonb NOT NULL, published_at text NOT NULL,
      PRIMARY KEY(draft_id,version), UNIQUE(draft_id,source_revision),
      FOREIGN KEY(draft_id,source_revision) REFERENCES draft_revisions(draft_id,revision)
    );
    CREATE TRIGGER review_versions_immutable BEFORE UPDATE OR DELETE ON review_versions FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
    CREATE TABLE review_links (
      id uuid PRIMARY KEY, draft_id text NOT NULL REFERENCES drafts(id), name text NOT NULL,
      token_hash text NOT NULL UNIQUE, expires_at bigint NOT NULL, revoked_at text, created_at text NOT NULL
    );
    CREATE INDEX review_links_draft ON review_links(draft_id);
    CREATE TABLE review_threads (
      id uuid PRIMARY KEY, draft_id text NOT NULL REFERENCES drafts(id), version integer, signing_document_id uuid REFERENCES documents(id),
      block_id text, resolved boolean NOT NULL DEFAULT false, created_at text NOT NULL,
      FOREIGN KEY(draft_id,version) REFERENCES review_versions(draft_id,version),
      CHECK(version IS NOT NULL OR signing_document_id IS NOT NULL)
    );
    CREATE INDEX review_threads_draft ON review_threads(draft_id,created_at);
    CREATE TABLE review_comments (
      id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES review_threads(id), request_id uuid NOT NULL,
      author_key text NOT NULL, author_name text NOT NULL, body text NOT NULL, created_at text NOT NULL,
      UNIQUE(author_key,request_id)
    );
    CREATE INDEX review_comments_thread ON review_comments(thread_id,created_at);
    CREATE TRIGGER review_comments_immutable BEFORE UPDATE OR DELETE ON review_comments FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
    CREATE TABLE draft_signings (
      draft_id text NOT NULL, revision integer NOT NULL, document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
      PRIMARY KEY(draft_id,revision), FOREIGN KEY(draft_id,revision) REFERENCES draft_revisions(draft_id,revision)
    );
  `);
}

export async function migrateReviewSharing(db: PoolClient) {
  await db.query(`
    CREATE TABLE review_publications (
      draft_id text NOT NULL, version integer NOT NULL, shared_at text NOT NULL,
      PRIMARY KEY(draft_id,version), FOREIGN KEY(draft_id,version) REFERENCES review_versions(draft_id,version)
    );
    CREATE TRIGGER review_publications_immutable BEFORE UPDATE OR DELETE ON review_publications FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
    -- Existing versions were created by the explicit "Dela" action.
    INSERT INTO review_publications SELECT draft_id,version,published_at FROM review_versions;
    ALTER TABLE review_links ADD COLUMN client_id text, ADD COLUMN client_name text, ADD COLUMN contact_id text,
      ADD COLUMN recipient_email text, ADD COLUMN first_version integer NOT NULL DEFAULT 1,
      ADD FOREIGN KEY(draft_id,first_version) REFERENCES review_versions(draft_id,version);
    -- Only bind a legacy link when its name identifies exactly one saved contact.
    WITH latest AS (
      SELECT DISTINCT ON (draft_id) draft_id,content FROM review_versions ORDER BY draft_id,version DESC
    ), candidates AS (
      SELECT l.id,v.content#>>'{company,id}' AS client_id,v.content#>>'{company,name}' AS client_name,c->>'id' AS contact_id,
        lower(btrim(c->>'email')) AS email,count(*) OVER (PARTITION BY l.id) AS matches
      FROM review_links l JOIN latest v ON v.draft_id=l.draft_id
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.content#>'{company,contacts}','[]'::jsonb)) c
      WHERE l.name=btrim(c->>'name') AND coalesce(v.content#>>'{company,id}','')<>'' AND coalesce(c->>'email','')<>''
    ) UPDATE review_links l SET client_id=c.client_id,client_name=c.client_name,contact_id=c.contact_id,recipient_email=c.email
      FROM candidates c WHERE c.id=l.id AND c.matches=1;
  `);
}
