import type { Express, RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canonical, transaction, uid, type Row } from './db.js';
import { ApiError, token } from './security.js';
import { sha256 } from './pdf.js';
import { draftIdSchema, draftSchema } from './draft-schema.js';
import { brandOf } from './brand.js';

const integer = z.number().int().min(1).max(2_000_000_000);
const rawToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const commentSchema = z.object({ version: integer, blockId: z.string().max(80).nullable().default(null), threadId: z.uuid().optional(), body: z.string().trim().min(1).max(5000), requestId: z.uuid() }).strict();
type DB = Pick<PoolClient, 'query'>;

function snapshotForReview(content: Row, frozenAt: string) {
  const snapshot = structuredClone(content);
  snapshot.frozenAt = frozenAt;
  if (snapshot.company) snapshot.company.contacts = snapshot.company.contacts.filter((contact: Row) => contact.signs);
  const usedFields = new Set(['sender.name', 'sender.email', 'sender.company', ...Array.from(JSON.stringify(snapshot.blocks).matchAll(/\{\{([\w.-]+)\}\}/g), match => match[1])]);
  function findFields(node: any) { if (!node || typeof node !== 'object') return; if (node.type === 'field') usedFields.add(node.attrs?.key); for (const child of Array.isArray(node) ? node : Object.values(node)) findFields(child); }
  findFields(snapshot.blocks);
  snapshot.fields = Object.fromEntries(Object.entries(snapshot.fields).filter(([key]) => usedFields.has(key)));
  snapshot.customFields = snapshot.customFields.filter((field: Row) => usedFields.has(field.key));
  return snapshot;
}

export function installReviews(app: Express, pool: Pool, requireUser: RequestHandler, origin: string, now: () => number) {
  const at = () => new Date(now()).toISOString();
  async function own(db: DB, id: unknown, team: string, lock = false, optional = false) {
    const row = (await db.query('SELECT * FROM drafts WHERE id=$1 AND team_id=$2 AND archived_at IS NULL' + (lock ? ' FOR UPDATE' : ''), [draftIdSchema.parse(id), team])).rows[0];
    if (!row && !optional) throw new ApiError(404, 'Utkastet finns inte.');
    return row;
  }
  async function capability(db: DB, value: string) {
    const link = (await db.query('SELECT * FROM review_links WHERE token_hash=$1', [sha256(value)])).rows[0];
    if (!link) throw new ApiError(404, 'Granskningslänken är ogiltig eller har upphört att gälla.');
    // Lock the draft first, as do revocation, publication and all comment writes.
    const draft = (await db.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE', [link.draft_id])).rows[0];
    const current = (await db.query('SELECT * FROM review_links WHERE id=$1', [link.id])).rows[0];
    if (!draft || draft.archived_at || current.revoked_at || Number(current.expires_at) <= now()) throw new ApiError(404, 'Granskningslänken är ogiltig eller har upphört att gälla.');
    return { draft, link: current };
  }
  async function signingState(db: DB, draftId: string, sourceRevision: number, clientId?: string | null) {
    return (await db.query(`SELECT d.status AS state,d.created_at AS "sentAt" FROM draft_signings s JOIN documents d ON d.id=s.document_id
      JOIN draft_revisions r ON r.draft_id=s.draft_id AND r.revision=s.revision
      WHERE s.draft_id=$1 AND s.revision>=$2 AND d.status<>'cancelled' AND ($3::text IS NULL OR r.content#>>'{company,id}'=$3)
      ORDER BY d.created_at DESC LIMIT 1`, [draftId, sourceRevision, clientId ?? null])).rows[0] ?? null;
  }
  async function history(db: DB, draftId: string, signing?: { documentId: string; revision: number; clientId?: string | null }, owner = false, reviewLink?: Row) {
    const versions = (await db.query(`SELECT v.version,v.source_revision AS "sourceRevision",v.published_at AS "publishedAt",p.shared_at AS "sharedAt",v.content#>>'{company,id}' AS "clientId"
      FROM review_versions v LEFT JOIN review_publications p ON p.draft_id=v.draft_id AND p.version=v.version
      WHERE v.draft_id=$1 AND ($2 OR p.version IS NOT NULL AND v.version>=$3 AND ($4::text IS NULL OR v.content#>>'{company,id}'=$4))
      ORDER BY v.version DESC`, [draftId, owner, reviewLink?.first_version ?? 1, reviewLink?.client_id ?? signing?.clientId ?? null])).rows;
    const threads = (await db.query(`SELECT t.id,t.version,t.signing_document_id AS "signingDocumentId",t.block_id AS "blockId",t.resolved,t.created_at AS "createdAt"
      FROM review_threads t LEFT JOIN review_versions v ON v.draft_id=t.draft_id AND v.version=t.version
      WHERE t.draft_id=$1 AND ($4 OR ($2::uuid IS NULL AND t.signing_document_id IS NULL) OR ($2::uuid IS NOT NULL AND (t.signing_document_id=$2 OR t.signing_document_id IS NULL AND v.source_revision<=$3)))
      ORDER BY t.created_at,t.id`, [draftId, signing?.documentId ?? null, signing?.revision ?? null, owner])).rows;
    const comments = (await db.query('SELECT c.id,c.thread_id AS "threadId",c.author_name AS "authorName",c.body,c.created_at AS "createdAt" FROM review_comments c JOIN review_threads t ON t.id=c.thread_id WHERE t.draft_id=$1 ORDER BY c.created_at,c.id', [draftId])).rows;
    const visibleVersions = signing ? versions.filter(version => version.sourceRevision <= signing.revision) : versions;
    const allowed = new Set(visibleVersions.map(version => version.version));
    return { versions: visibleVersions, threads: threads.filter(thread => owner || thread.signingDocumentId === signing?.documentId || allowed.has(thread.version)).map(thread => ({ ...thread, comments: comments.filter(comment => comment.threadId === thread.id) })) };
  }
  app.get('/api/drafts', requireUser, async (_req, res) => {
    const drafts = (await pool.query(`SELECT id,content->>'title' AS title,revision,updated_at AS "updatedAt",
      (SELECT max(version) FROM review_versions v WHERE v.draft_id=drafts.id) AS "publishedVersion"
      FROM drafts WHERE team_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 200`, [res.locals.user.team_id])).rows;
    res.json({ drafts });
  });
  app.get('/api/drafts/:id', requireUser, async (req, res) => {
    res.json(await transaction(pool, async db => {
      const row = await own(db, req.params.id, res.locals.user.team_id, true, req.query.optional === '1');
      if (!row) return { draft: null };
      const links = (await db.query('SELECT id,name,client_id AS "clientId",client_name AS "clientName",contact_id AS "contactId",recipient_email AS "recipientEmail",first_version AS "firstVersion",expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM review_links WHERE draft_id=$1 ORDER BY created_at DESC', [row.id])).rows;
      const signings = (await db.query('SELECT revision,document_id AS "documentId" FROM draft_signings WHERE draft_id=$1', [row.id])).rows;
      return { ...(req.query.discussion === '1' ? {} : { draft: row.content }), revision: row.revision, ...await history(db, row.id, undefined, true), links, signings };
    }));
  });
  app.get('/api/drafts/:id/versions/:version', requireUser, async (req, res) => {
    const draft = await own(pool, req.params.id, res.locals.user.team_id);
    const row = (await pool.query('SELECT content FROM review_versions WHERE draft_id=$1 AND version=$2', [draft.id, integer.parse(Number(req.params.version))])).rows[0];
    if (!row) throw new ApiError(404, 'Versionen finns inte.');
    res.json({ draft: row.content });
  });
  app.put('/api/drafts/:id', requireUser, async (req, res) => {
    const input = z.object({ expectedRevision: z.number().int().min(0), draft: draftSchema }).strict().parse(req.body);
    const id = draftIdSchema.parse(req.params.id);
    if (id !== input.draft.id || Buffer.byteLength(JSON.stringify(input.draft)) > 10_000_000) throw new ApiError(400, 'Ogiltigt eller för stort utkast.');
    res.json(await transaction(pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['draft:' + id]);
      const row = (await db.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (row && (row.team_id !== res.locals.user.team_id || row.archived_at)) throw new ApiError(409, 'Utkastet kunde inte sparas med detta ID.');
      if (row && canonical(row.content) === canonical(input.draft)) return { revision: row.revision, updatedAt: row.updated_at };
      if ((row?.revision ?? 0) !== input.expectedRevision) throw new ApiError(409, 'Utkastet har ändrats i en annan flik. Kopiera dina ändringar och öppna utkastet igen.');
      const revision = input.expectedRevision + 1, updatedAt = at();
      if (row) await db.query('UPDATE drafts SET content=$1,revision=$2,updated_at=$3 WHERE id=$4', [input.draft, revision, updatedAt, id]);
      else await db.query('INSERT INTO drafts(id,team_id,created_by,revision,content,updated_at) VALUES($1,$2,$3,$4,$5,$6)', [id, res.locals.user.team_id, res.locals.user.id, revision, input.draft, updatedAt]);
      await db.query('INSERT INTO draft_revisions(draft_id,revision,content) VALUES($1,$2,$3)', [id, revision, input.draft]);
      return { revision, updatedAt };
    }));
  });
  app.delete('/api/drafts/:id', requireUser, async (req, res) => {
    await transaction(pool, async db => {
      const row = await own(db, req.params.id, res.locals.user.team_id, true);
      await db.query('UPDATE drafts SET archived_at=$1 WHERE id=$2', [at(), row.id]);
      await db.query('UPDATE review_links SET revoked_at=$1 WHERE draft_id=$2 AND revoked_at IS NULL', [at(), row.id]);
    });
    res.json({ ok: true });
  });
  async function saveVersion(db: PoolClient, id: string, teamId: string, revision: number, allowSharedUpdate = true) {
    const row = await own(db, id, teamId, true);
    const previous = (await db.query('SELECT version FROM review_versions WHERE draft_id=$1 AND source_revision=$2', [row.id, revision])).rows[0];
    if (previous) return previous;
    if (row.revision !== revision) throw new ApiError(409, 'Utkastet har ändrats. Spara den senaste versionen igen.');
    if (!allowSharedUpdate && (await db.query('SELECT 1 FROM review_links WHERE draft_id=$1 AND revoked_at IS NULL AND expires_at>$2 LIMIT 1', [row.id, now()])).rowCount) throw new ApiError(409, 'Saving would update an active client link. Explicit shared-update permission is required.');
    const count = Number((await db.query('SELECT count(*) FROM review_versions WHERE draft_id=$1', [row.id])).rows[0].count);
    if (count >= 100) throw new ApiError(409, 'Utkastet har redan 100 sparade versioner.');
    // Access follows the saved client, never a later private autosave or a different client.
    const contacts = row.content.company?.contacts ?? [];
    const links = (await db.query('SELECT * FROM review_links WHERE draft_id=$1 AND revoked_at IS NULL AND expires_at>$2', [row.id, now()])).rows;
    let shared = false;
    for (const link of links) {
      const person = contacts.find((person: Row) => person.id === link.contact_id);
      if (link.client_id !== row.content.company?.id || !person || person.email.trim().toLowerCase() !== link.recipient_email || person.name.trim() !== link.name) await db.query('UPDATE review_links SET revoked_at=$1 WHERE id=$2', [at(), link.id]);
      else shared = true;
    }
    if (shared && (!row.content.title.trim() || !row.content.blocks.length)) throw new ApiError(400, 'Lägg till en titel och minst ett avsnitt innan du sparar en klientversion.');
    const snapshot = snapshotForReview(row.content, at());
    await db.query('INSERT INTO review_versions(draft_id,version,source_revision,content,published_at) VALUES($1,$2,$3,$4,$5)', [row.id, count + 1, revision, snapshot, at()]);
    if (shared) await db.query('INSERT INTO review_publications(draft_id,version,shared_at) VALUES($1,$2,$3)', [row.id, count + 1, at()]);
    return { version: count + 1 };
  }
  app.post('/api/drafts/:id/publish', requireUser, async (req, res) => {
    const input = z.object({ revision: integer }).strict().parse(req.body);
    res.json(await transaction(pool, db => saveVersion(db, String(req.params.id), res.locals.user.team_id, input.revision)));
  });
  app.post('/api/drafts/:id/links', requireUser, async (req, res) => {
    const input = z.object({ contactId: z.string().min(1).max(80), revision: integer, days: z.number().int().min(1).max(365).default(30) }).strict().parse(req.body);
    const result = await transaction(pool, async db => {
      const row = await own(db, req.params.id, res.locals.user.team_id, true);
      const latest = (await db.query('SELECT version,source_revision FROM review_versions WHERE draft_id=$1 ORDER BY version DESC LIMIT 1', [row.id])).rows[0];
      if (!latest || latest.source_revision !== input.revision || row.revision !== input.revision) throw new ApiError(409, 'Spara utkastet innan du skapar länken.');
      if (!row.content.title.trim() || !row.content.blocks.length) throw new ApiError(400, 'Lägg till en titel och minst ett avsnitt.');
      const company = row.content.company, person = company?.contacts.find((person: Row) => person.id === input.contactId);
      if (!company?.name.trim() || !person?.name.trim() || !z.email().safeParse(person.email).success) throw new ApiError(400, 'Lägg till en klient och välj en kontaktperson med namn och e-post först.');
      if (Number((await db.query('SELECT count(*) FROM review_links WHERE draft_id=$1', [row.id])).rows[0].count) >= 100) throw new ApiError(409, 'Utkastet har redan 100 länkar.');
      const raw = token(), id = uid(), expiresAt = now() + input.days * 86400000;
      const replaced = await db.query('UPDATE review_links SET revoked_at=$1 WHERE draft_id=$2 AND client_id=$3 AND contact_id=$4 AND revoked_at IS NULL RETURNING id', [at(), row.id, company.id, person.id]);
      await db.query('INSERT INTO review_links(id,draft_id,name,token_hash,expires_at,created_at,client_id,client_name,contact_id,recipient_email,first_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, row.id, person.name.trim(), sha256(raw), expiresAt, at(), company.id, company.name, person.id, person.email.trim().toLowerCase(), latest.version]);
      await db.query('INSERT INTO review_publications(draft_id,version,shared_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [row.id, latest.version, at()]);
      return { id, url: origin + '/review#' + raw, expiresAt, version: latest.version, name: person.name.trim(), email: person.email, clientName: company.name, rotated: Boolean(replaced.rowCount) };
    });
    res.status(201).json(result);
  });
  app.post('/api/drafts/:id/links/:linkId/revoke', requireUser, async (req, res) => {
    await transaction(pool, async db => {
      const row = await own(db, req.params.id, res.locals.user.team_id, true);
      await db.query('UPDATE review_links SET revoked_at=$1 WHERE id=$2 AND draft_id=$3', [at(), z.uuid().parse(req.params.linkId), row.id]);
    });
    res.json({ ok: true });
  });
  app.post('/api/review/session', async (req, res) => {
    const input = z.object({ token: rawToken, version: integer.optional(), knownVersion: integer.optional() }).strict().parse(req.body);
    res.json(await transaction(pool, async db => {
      const { draft, link } = await capability(db, input.token);
      const discussion = await history(db, draft.id, undefined, false, link);
      const selected = input.version ?? discussion.versions[0]?.version;
      if (!discussion.versions.some(version => version.version === selected)) throw new ApiError(404, 'Versionen finns inte för denna granskningslänk.');
      const version = (await db.query('SELECT version,CASE WHEN version=$3 THEN NULL ELSE content END AS content,published_at FROM review_versions WHERE draft_id=$1 AND version=$2', [draft.id, selected, input.knownVersion ?? null])).rows[0];
      if (!version) throw new ApiError(404, 'Versionen finns inte.');
      const brand = brandOf((await db.query('SELECT * FROM teams WHERE id=$1', [draft.team_id])).rows[0]);
      return { ...(version.content ? { draft: version.content } : {}), version: version.version, publishedAt: version.published_at, reviewerName: link.name, brand, signing: await signingState(db, draft.id, discussion.versions[0].sourceRevision, link.client_id), ...discussion };
    }));
  });
  async function comment(db: PoolClient, draft: Row, authorKey: string, authorName: string, input: z.infer<typeof commentSchema>, signing?: { documentId: string; revision: number; clientId?: string | null }, isOwner = false, beforeCreate?: () => Promise<void>) {
    const previous = (await db.query('SELECT c.*,t.draft_id,t.version,t.signing_document_id,t.block_id FROM review_comments c JOIN review_threads t ON t.id=c.thread_id WHERE c.author_key=$1 AND c.request_id=$2', [authorKey, input.requestId])).rows[0];
    if (previous) {
      if (previous.draft_id !== draft.id || (!(isOwner && input.threadId) && (signing ? previous.signing_document_id !== signing.documentId && !input.threadId : previous.version !== input.version)) || previous.body !== input.body || (input.threadId ? previous.thread_id !== input.threadId : previous.block_id !== input.blockId)) throw new ApiError(409, 'Försöket innehåller andra ändringar än det sparade svaret.');
      return { id: previous.id, threadId: previous.thread_id };
    }
    await beforeCreate?.();
    if (Number((await db.query('SELECT count(*) FROM review_comments c JOIN review_threads t ON t.id=c.thread_id WHERE t.draft_id=$1', [draft.id])).rows[0].count) >= 500) throw new ApiError(409, 'Utkastet har nått gränsen på 500 kommentarer.');
    let threadId = input.threadId;
    if (threadId) {
      const thread = (await db.query('SELECT * FROM review_threads WHERE id=$1 AND draft_id=$2', [threadId, draft.id])).rows[0];
      if (!thread) throw new ApiError(404, 'Kommentarstråden finns inte i denna version.');
      if (signing) {
        const allowed = await history(db, draft.id, signing);
        if (!allowed.threads.some(item => item.id === thread.id)) throw new ApiError(404, 'Kommentarstråden finns inte.');
      } else if (!isOwner && (thread.version !== input.version || thread.signing_document_id)) throw new ApiError(404, 'Kommentarstråden finns inte i denna version.');
      if (thread.resolved) throw new ApiError(409, 'Tråden är löst. Be avsändaren öppna den igen eller skapa en ny kommentar.');
      if (Number((await db.query('SELECT count(*) FROM review_comments WHERE thread_id=$1', [threadId])).rows[0].count) >= 100) throw new ApiError(409, 'Tråden är full. Skapa en ny kommentar.');
    } else {
      const version = signing
        ? (await db.query('SELECT content FROM draft_revisions WHERE draft_id=$1 AND revision=$2', [draft.id, signing.revision])).rows[0]
        : (await db.query('SELECT content FROM review_versions WHERE draft_id=$1 AND version=$2', [draft.id, input.version])).rows[0];
      if (!version || (input.blockId && !version.content.blocks.some((block: Row) => block.id === input.blockId))) throw new ApiError(404, 'Avsnittet eller versionen finns inte.');
      if (Number((await db.query('SELECT count(*) FROM review_threads WHERE draft_id=$1', [draft.id])).rows[0].count) >= 200) throw new ApiError(409, 'Utkastet har redan 200 kommentarstrådar.');
      threadId = uid();
      await db.query('INSERT INTO review_threads(id,draft_id,version,signing_document_id,block_id,created_at) VALUES($1,$2,$3,$4,$5,$6)', [threadId, draft.id, signing ? null : input.version, signing?.documentId ?? null, input.blockId, at()]);
    }
    const id = uid();
    await db.query('INSERT INTO review_comments(id,thread_id,request_id,author_key,author_name,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, threadId, input.requestId, authorKey, authorName, input.body, at()]);
    return { id, threadId };
  }
  app.post('/api/review/comments', async (req, res) => {
    const { token: raw, ...input } = commentSchema.extend({ token: rawToken }).parse(req.body);
    res.json(await transaction(pool, async db => {
      const { draft, link } = await capability(db, raw);
      return comment(db, draft, 'link:' + link.id, link.name, input, undefined, false, async () => {
        const latest = (await history(db, draft.id, undefined, false, link)).versions[0];
        if (!latest || input.version !== latest.version) throw new ApiError(409, 'Kommentera den senaste delade versionen.');
        if (await signingState(db, draft.id, latest.sourceRevision, link.client_id)) throw new ApiError(409, 'Avtalet har skickats för signering. Ställ frågor via din personliga signeringslänk.');
      });
    }));
  });
  app.post('/api/drafts/:id/comments', requireUser, async (req, res) => {
    const input = commentSchema.extend({ version: z.number().int().min(0) }).parse(req.body);
    res.json(await transaction(pool, async db => comment(db, await own(db, req.params.id, res.locals.user.team_id, true), 'user:' + res.locals.user.id, res.locals.user.name, input, undefined, true)));
  });
  app.post('/api/drafts/:id/threads/:threadId', requireUser, async (req, res) => {
    const input = z.object({ resolved: z.boolean() }).strict().parse(req.body);
    await transaction(pool, async db => {
      const draft = await own(db, req.params.id, res.locals.user.team_id, true);
      const result = await db.query('UPDATE review_threads SET resolved=$1 WHERE id=$2 AND draft_id=$3', [input.resolved, z.uuid().parse(req.params.threadId), draft.id]);
      if (!result.rowCount) throw new ApiError(404, 'Kommentarstråden finns inte.');
    });
    res.json({ ok: true });
  });
  async function signingSource(db: DB, documentId: string) {
    const source = (await db.query('SELECT s.draft_id,s.revision,r.content#>>\'{company,id}\' AS "clientId" FROM draft_signings s JOIN draft_revisions r ON r.draft_id=s.draft_id AND r.revision=s.revision WHERE s.document_id=$1', [documentId])).rows[0];
    if (!source) return null;
    return { ...source, documentId };
  }
  return {
    saveVersion,
    ownerHistory: async (db: DB, draftId: string) => history(db, draftId, undefined, true),
    ownerComment: async (db: PoolClient, draft: Row, userId: string, userName: string, body: unknown) => comment(db, draft, 'user:' + userId, userName, commentSchema.extend({ version: z.number().int().min(0) }).parse(body), undefined, true),
    signingVersion: async (db: DB, documentId: string, version: number) => {
      const source = await signingSource(db, documentId);
      const allowed = source && (await history(db, source.draft_id, { documentId, revision: source.revision, clientId: source.clientId })).versions.some(item => item.version === version);
      const row = allowed ? (await db.query('SELECT content FROM review_versions WHERE draft_id=$1 AND version=$2', [source!.draft_id, version])).rows[0] : null;
      if (!row) throw new ApiError(404, 'Versionen finns inte för detta signeringsdokument.');
      return { draft: row.content };
    },
    /** Caller must authorize the exact signing document first; review tokens never enter this path. */
    signingDiscussion: async (db: DB, documentId: string, updatesOnly = false) => {
      const source = await signingSource(db, documentId);
      if (!source) return null;
      const historyData = await history(db, source.draft_id, { documentId, revision: source.revision, clientId: source.clientId });
      if (updatesOnly) return { draftId: source.draft_id, revision: source.revision, ...historyData };
      const saved = (await db.query('SELECT r.content,d.created_at FROM draft_revisions r JOIN documents d ON d.id=$3 WHERE r.draft_id=$1 AND r.revision=$2', [source.draft_id, source.revision, documentId])).rows[0];
      const last = historyData.versions[0];
      const shared = last ? (await db.query('SELECT content FROM review_versions WHERE draft_id=$1 AND version=$2', [source.draft_id, last.version])).rows[0].content : null;
      const content = snapshotForReview(saved.content, last?.sourceRevision === source.revision ? shared.frozenAt : saved.created_at);
      const labels: Record<string, string> = { header: 'Omslag', parties: 'Parter', pricing: 'Priser', text: 'Text', terms: 'Villkor', image: 'Bild', break: 'Sidbrytning' };
      const sections = content.blocks.map((block: Row, index: number) => ({ id: block.id, label: `${index + 1}. ${block.title || labels[block.type]}` }));
      const changedSections = shared ? sections.filter((section: Row) => canonical(content.blocks.find((block: Row) => block.id === section.id)) !== canonical(shared.blocks.find((block: Row) => block.id === section.id) ?? null)) : [];
      return { draftId: source.draft_id, revision: source.revision, source: content, sections, changedSections, ...historyData };
    },
    signingComment: async (db: PoolClient, documentId: string, recipient: Row, body: unknown) => {
      const input = commentSchema.omit({ version: true }).parse(body);
      const source = await signingSource(db, documentId);
      if (!source) throw new ApiError(404, 'Dokumentet har ingen utkastdiskussion.');
      // Signer access is pinned to the signing transaction, including when the draft is later archived.
      const draft = (await db.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE', [source.draft_id])).rows[0];
      return comment(db, draft, 'recipient:' + recipient.id, recipient.claimed_name || recipient.name, { ...input, version: 0 }, { documentId, revision: source.revision, clientId: source.clientId });
    },
  };
}
