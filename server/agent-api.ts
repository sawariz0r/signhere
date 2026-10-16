import { Router, type Express, type Request, type RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canonical, transaction, uid, type Row } from './db.js';
import { draftIdSchema, draftSchema } from './draft-schema.js';
import { ApiError, token } from './security.js';
import { sha256 } from './pdf.js';
import type { installReviews } from './reviews.js';

export const agentScopes = ['drafts:read', 'drafts:write', 'discussion:read', 'discussion:write', 'reviews:share'] as const;
export type AgentContext = { keyId: string; userId: string; teamId: string; userName: string; teamName: string; scopes: string[] };
export type AgentOperation = 'workspace' | 'list_drafts' | 'get_draft' | 'create_draft' | 'update_draft' | 'save_draft' | 'get_discussion' | 'add_comment';
type Reviews = ReturnType<typeof installReviews>;
const revisionSchema = z.number().int().min(1).max(2_000_000_000);
const requestIdSchema = z.uuid();
export const agentInputSchemas = {
  workspace: z.object({}).strict(), list_drafts: z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict(),
  get_draft: z.object({ draftId: draftIdSchema }).strict(),
  create_draft: z.object({ draft: draftSchema, requestId: requestIdSchema }).strict(),
  update_draft: z.object({ draftId: draftIdSchema, expectedRevision: revisionSchema, draft: draftSchema, requestId: requestIdSchema }).strict(),
  save_draft: z.object({ draftId: draftIdSchema, expectedRevision: revisionSchema, requestId: requestIdSchema, allowSharedUpdate: z.boolean().default(false) }).strict(),
  get_discussion: z.object({ draftId: draftIdSchema }).strict(),
  add_comment: z.object({ draftId: draftIdSchema, version: z.number().int().min(0).max(2_000_000_000), blockId: z.string().min(1).max(80).nullable().default(null), threadId: z.uuid().optional(), body: z.string().trim().min(1).max(5000), requestId: requestIdSchema }).strict().refine(input => input.version > 0 || Boolean(input.threadId), 'Version zero is only valid when replying to an existing thread.'),
};
const operationScope: Partial<Record<AgentOperation, string>> = { list_drafts: 'drafts:read', get_draft: 'drafts:read', create_draft: 'drafts:write', update_draft: 'drafts:write', save_draft: 'drafts:write', get_discussion: 'discussion:read', add_comment: 'discussion:write' };
export class AgentConflict extends ApiError {
  code = 'revision_conflict';
  constructor(public currentRevision: number) { super(409, 'The draft changed. Fetch the latest draft and reconcile your changes.'); }
}
function context(row: Row): AgentContext { return { keyId: row.id, userId: row.user_id, teamId: row.team_id, userName: row.user_name, teamName: row.team_name, scopes: row.scopes }; }
async function keyById(db: Pick<PoolClient, 'query'>, keyId: string, now: number) {
  const row = (await db.query(`SELECT k.*,u.name AS user_name,t.name AS team_name FROM agent_keys k JOIN users u ON u.id=k.user_id AND u.team_id=k.team_id JOIN teams t ON t.id=k.team_id
    WHERE k.id=$1 AND k.revoked_at IS NULL AND k.expires_at>$2`, [keyId, new Date(now).toISOString()])).rows[0];
  if (!row) throw new ApiError(401, 'The API key is invalid, expired or revoked.');
  return row;
}
export async function authenticateAgent(pool: Pool, req: Request, now: () => number): Promise<AgentContext> {
  const auth = req.get('authorization') ?? '';
  if (!/^Bearer shk_[A-Za-z0-9_-]{43}$/i.test(auth)) throw new ApiError(401, 'A Signhere API key is required in the Authorization Bearer header.');
  const hash = sha256(auth.slice(7));
  const found = (await pool.query('SELECT id FROM agent_keys WHERE token_hash=$1', [hash])).rows[0];
  if (!found) throw new ApiError(401, 'The API key is invalid, expired or revoked.');
  return context(await keyById(pool, found.id, now()));
}
export function createAgentService(pool: Pool, origin: string, now: () => number, reviews: Reviews) {
  const at = () => new Date(now()).toISOString();
  const url = (id: string) => origin + '/editor/' + id;
  async function own(db: PoolClient, id: string, teamId: string) {
    const row = (await db.query('SELECT * FROM drafts WHERE id=$1 AND team_id=$2 AND archived_at IS NULL FOR UPDATE', [id, teamId])).rows[0];
    if (!row) throw new ApiError(404, 'Draft not found.');
    return row;
  }
  return {
    authenticate: (req: Request) => authenticateAgent(pool, req, now),
    async execute(auth: AgentContext, operation: AgentOperation, raw: unknown): Promise<unknown> {
      const input = agentInputSchemas[operation].parse(raw) as Row;
      if (Buffer.byteLength(JSON.stringify(input)) > 10_000_000) throw new ApiError(413, 'The draft is too large.');
      try { return await transaction(pool, async db => {
        // Serialize per-key mutations, rechecking revocation and expiry on every call.
        await db.query('SELECT id FROM agent_keys WHERE id=$1 FOR UPDATE', [auth.keyId]);
        const key = await keyById(db, auth.keyId, now());
        const actor = context(key);
        const required = operationScope[operation];
        if (required && !actor.scopes.includes(required)) throw new ApiError(403, 'The API key does not permit ' + required + '.');
        await db.query('UPDATE agent_keys SET last_used_at=$1 WHERE id=$2', [at(), key.id]);
        const inputHash = sha256(canonical(input));
        if (input.requestId) {
          const previous = (await db.query('SELECT * FROM agent_requests WHERE key_id=$1 AND request_id=$2', [key.id, input.requestId])).rows[0];
          if (previous) {
            if (previous.operation !== operation || previous.input_hash !== inputHash) throw new ApiError(409, 'The request ID was already used for another operation or input.');
            return previous.result;
          }
        }
        let result: unknown;
        if (operation === 'workspace') result = { apiVersion: 'v1', workspace: { id: actor.teamId, name: actor.teamName }, user: { id: actor.userId, name: actor.userName }, scopes: actor.scopes, baseUrl: origin };
        else if (operation === 'list_drafts') {
          const drafts = (await db.query(`SELECT id,content->>'title' AS title,revision,updated_at AS "updatedAt",(SELECT max(version) FROM review_versions WHERE draft_id=drafts.id) AS "savedVersion" FROM drafts WHERE team_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC,id LIMIT $2`, [actor.teamId, input.limit])).rows;
          result = { drafts: drafts.map(draft => ({ ...draft, url: url(draft.id) })) };
        } else if (operation === 'create_draft' || operation === 'update_draft') {
          const draft = input.draft, id = input.draftId ?? draft.id;
          if (id !== draft.id) throw new ApiError(400, 'The path and draft IDs must match.');
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['draft:' + id]);
          const row = (await db.query('SELECT * FROM drafts WHERE id=$1 FOR UPDATE', [id])).rows[0];
          if (operation === 'create_draft' && row) throw new ApiError(409, 'This draft ID is already in use.');
          if (operation === 'update_draft' && (!row || row.team_id !== actor.teamId || row.archived_at)) throw new ApiError(404, 'Draft not found.');
          if (row && row.revision !== input.expectedRevision) throw new AgentConflict(row.revision);
          const revision = row ? row.revision + 1 : 1;
          if (row) await db.query('UPDATE drafts SET content=$1,revision=$2,updated_at=$3 WHERE id=$4', [draft, revision, at(), id]);
          else await db.query('INSERT INTO drafts(id,team_id,created_by,revision,content,updated_at) VALUES($1,$2,$3,$4,$5,$6)', [id, actor.teamId, actor.userId, revision, draft, at()]);
          await db.query('INSERT INTO draft_revisions(draft_id,revision,content) VALUES($1,$2,$3)', [id, revision, draft]);
          result = { draftId: id, revision, updatedAt: at(), url: url(id), saved: false };
        } else {
          const row = await own(db, input.draftId, actor.teamId);
          if (operation === 'get_draft') {
            const saved = (await db.query('SELECT max(version) AS version FROM review_versions WHERE draft_id=$1', [row.id])).rows[0];
            const active = (await db.query('SELECT 1 FROM review_links WHERE draft_id=$1 AND revoked_at IS NULL AND expires_at>$2 LIMIT 1', [row.id, now()])).rowCount;
            result = { draft: row.content, revision: row.revision, updatedAt: row.updated_at, savedVersion: saved.version, hasActiveReviewLinks: Boolean(active), url: url(row.id) };
          } else if (operation === 'save_draft') {
            if (row.revision !== input.expectedRevision) throw new AgentConflict(row.revision);
            const active = Boolean((await db.query('SELECT 1 FROM review_links WHERE draft_id=$1 AND revoked_at IS NULL AND expires_at>$2 LIMIT 1', [row.id, now()])).rowCount);
            if (active && input.allowSharedUpdate && !actor.scopes.includes('reviews:share')) throw new ApiError(403, 'The API key needs reviews:share to update existing client links.');
            const saved = await reviews.saveVersion(db, row.id, actor.teamId, input.expectedRevision, !active || input.allowSharedUpdate && actor.scopes.includes('reviews:share'));
            const shared = Boolean((await db.query('SELECT 1 FROM review_publications WHERE draft_id=$1 AND version=$2', [row.id, saved.version])).rowCount);
            result = { draftId: row.id, revision: row.revision, ...saved, url: url(row.id), mayUpdateClientLinks: active, shared, visibility: shared ? 'shared' : 'private' };
          } else if (operation === 'get_discussion') result = { draftId: row.id, ...await reviews.ownerHistory(db, row.id) };
          else {
            const { draftId: _draftId, ...comment } = input;
            result = await reviews.ownerComment(db, row, actor.userId, actor.userName, comment);
          }
        }
        if (input.requestId) {
          await db.query('INSERT INTO agent_requests(key_id,request_id,operation,input_hash,result,created_at) VALUES($1,$2,$3,$4,$5,$6)', [key.id, input.requestId, operation, inputHash, result, at()]);
        }
        await db.query('INSERT INTO agent_audit(id,key_id,operation,resource_id,created_at) VALUES($1,$2,$3,$4,$5)', [uid(), key.id, operation, input.draftId ?? input.draft?.id ?? null, at()]);
        return result;
      }); } catch (error) {
        const outcome = error instanceof ApiError ? 'http_' + error.status : 'internal_error';
        // Log bounded metadata after rollback, never inputs, errors, tokens or document text.
        await pool.query('INSERT INTO agent_audit(id,key_id,operation,resource_id,outcome,created_at) SELECT $1,id,$3,$4,$5,$6 FROM agent_keys WHERE id=$2', [uid(), auth.keyId, operation, input.draftId ?? input.draft?.id ?? null, outcome, at()]).catch(() => undefined);
        throw error;
      }
    },
  };
}
export type AgentService = ReturnType<typeof createAgentService>;
const keyColumns = 'id,name,prefix,scopes,created_at AS "createdAt",expires_at AS "expiresAt",last_used_at AS "lastUsedAt",revoked_at AS "revokedAt"';
export function installAgentApi(app: Express, pool: Pool, requireUser: RequestHandler, origin: string, now: () => number, reviews: Reviews) {
  const service = createAgentService(pool, origin, now, reviews);
  const urls = { mcpUrl: origin + '/mcp', apiUrl: origin + '/api/v1' };
  app.get('/api/agent-keys', requireUser, async (_req, res) => {
    const keys = (await pool.query('SELECT ' + keyColumns + ' FROM agent_keys WHERE user_id=$1 AND team_id=$2 ORDER BY created_at DESC LIMIT 100', [res.locals.user.id, res.locals.user.team_id])).rows;
    res.json({ keys, scopes: agentScopes, ...urls });
  });
  app.post('/api/agent-keys', requireUser, async (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(agentScopes)).min(1).max(agentScopes.length).refine(values => new Set(values).size === values.length), expiresInDays: z.number().int().min(1).max(365).default(90) }).strict().parse(req.body);
    const raw = 'shk_' + token();
    const key = await transaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [res.locals.user.id]);
      if (Number((await db.query('SELECT count(*) FROM agent_keys WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2', [res.locals.user.id, new Date(now()).toISOString()])).rows[0].count) >= 20) throw new ApiError(409, 'Revoke an existing API key before creating another (maximum 20 active keys).');
      const metadata = (await db.query('INSERT INTO agent_keys(id,user_id,team_id,name,prefix,token_hash,scopes,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ' + keyColumns, [uid(), res.locals.user.id, res.locals.user.team_id, input.name, raw.slice(0, 12), sha256(raw), JSON.stringify(input.scopes), new Date(now()).toISOString(), new Date(now() + input.expiresInDays * 86400000).toISOString()])).rows[0];
      await db.query('INSERT INTO agent_audit(id,key_id,operation,created_at) VALUES($1,$2,$3,$4)', [uid(), metadata.id, 'key.created', new Date(now()).toISOString()]);
      return metadata;
    });
    res.status(201).json({ key, token: raw, ...urls });
  });
  app.post('/api/agent-keys/:id/revoke', requireUser, async (req, res) => {
    await transaction(pool, async db => {
      const id = z.uuid().parse(req.params.id);
      const result = await db.query('UPDATE agent_keys SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2 AND user_id=$3 AND team_id=$4', [new Date(now()).toISOString(), id, res.locals.user.id, res.locals.user.team_id]);
      if (!result.rowCount) throw new ApiError(404, 'API key not found.');
      await db.query('INSERT INTO agent_audit(id,key_id,operation,created_at) VALUES($1,$2,$3,$4)', [uid(), id, 'key.revoked', new Date(now()).toISOString()]);
    });
    res.json({ ok: true });
  });
  const router = Router();
  router.use(async (req, res, next) => { res.locals.agent = await service.authenticate(req); next(); });
  function route(method: 'get' | 'post' | 'put', path: string, operation: AgentOperation, input: (req: Request) => unknown) {
    router[method](path, async (req, res) => res.status(operation === 'create_draft' ? 201 : 200).json(await service.execute(res.locals.agent, operation, input(req))));
  }
  route('get', '/workspace', 'workspace', () => ({}));
  route('get', '/drafts', 'list_drafts', req => req.query.limit === undefined ? {} : { limit: Number(req.query.limit) });
  route('get', '/drafts/:id', 'get_draft', req => ({ draftId: req.params.id }));
  route('post', '/drafts', 'create_draft', req => req.body);
  route('put', '/drafts/:id', 'update_draft', req => ({ ...req.body, draftId: req.params.id }));
  route('post', '/drafts/:id/save', 'save_draft', req => ({ ...req.body, draftId: req.params.id }));
  route('get', '/drafts/:id/discussion', 'get_discussion', req => ({ draftId: req.params.id }));
  route('post', '/drafts/:id/comments', 'add_comment', req => ({ ...req.body, draftId: req.params.id }));
  app.use('/api/v1', router);
  return service;
}
