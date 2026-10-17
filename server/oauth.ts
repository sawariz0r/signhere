import express, { type Express, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import OAuth2Server from '@node-oauth/oauth2-server';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction, uid, type Row } from './db.js';
import { agentScopes, type AgentContext, type AgentService } from './agent-api.js';
import { ApiError, token } from './security.js';
import { sha256 } from './pdf.js';
import { validateChatGPTClient, type OAuthMetadataLoader } from './oauth-client.js';

export type OAuthOptions = { enabled?: boolean; metadataLoader?: OAuthMetadataLoader; rateLimit?: boolean };
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const defaultAccessMinutes = 90 * 24 * 60;
const minutes = z.number().int().min(15).max(365 * 24 * 60);
const defaults = agentScopes.filter(scope => scope !== 'reviews:share');
function cookie(req: Request, name: string) { return (req.get('cookie') ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1); }
function sessionHash(req: Request) {
  const raw = cookie(req, 'signhere_session');
  if (!opaque.safeParse(raw).success) throw new ApiError(401, 'Log in to Signhere to continue.');
  return sha256(raw!);
}
function errorResponse(res: express.Response, error: string, status = 400) { res.status(status).json({ error, error_description: 'The OAuth request could not be completed. Start the connection again in ChatGPT.' }); }
function redirectResult(origin: string, pending: Row, values: Record<string, string>) {
  const url = new URL(pending.redirect_uri);
  for (const [key, value] of Object.entries({ ...values, state: pending.state, iss: origin })) url.searchParams.set(key, value);
  return url.href;
}

/** Separate human OAuth authorization; never exposed as an agent credential-management tool. */
export function installOAuth(app: Express, pool: Pool, requireUser: RequestHandler, origin: string, now: () => number, agent: AgentService, options: OAuthOptions = {}): AgentService {
  const resource = origin + '/mcp/oauth';
  const metadataUrl = origin + '/.well-known/oauth-protected-resource/mcp/oauth';
  const enabled = options.enabled !== false;
  const at = () => new Date(now()).toISOString();
  const browserName = 'signhere_oauth_browser';
  const requireEnabled: RequestHandler = (_req, _res, next) => { if (!enabled) throw new ApiError(404, 'OAuth connections are disabled.'); next(); };
  const limiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many OAuth requests. Try again shortly.' } });
  const protocol = express.Router();
  protocol.use(requireEnabled, (_req, res, next) => { res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }); next(); });
  if (options.rateLimit !== false) protocol.use(limiter);
  const protectedMetadata = { resource, authorization_servers: [origin], scopes_supported: agentScopes, bearer_methods_supported: ['header'], resource_documentation: origin + '/skills/signhere/SKILL.md' };
  app.get('/.well-known/oauth-protected-resource/mcp/oauth', requireEnabled, (_req, res) => res.set('Cache-Control', 'no-store').json(protectedMetadata));
  app.get('/.well-known/oauth-authorization-server', requireEnabled, (_req, res) => res.set('Cache-Control', 'no-store').json({ issuer: origin, authorization_endpoint: origin + '/oauth/authorize', token_endpoint: origin + '/oauth/token', response_types_supported: ['code'], grant_types_supported: ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true, scopes_supported: agentScopes }));

  protocol.get('/authorize', async (req, res) => {
    const input = z.object({ response_type: z.literal('code'), client_id: z.string().max(2048), redirect_uri: z.string().max(2048), resource: z.literal(resource), scope: z.string().max(500).optional(), state: z.string().min(1).max(1024).regex(/^[\x21-\x7e]+$/), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256') }).safeParse(req.query);
    if (!input.success) { errorResponse(res, 'invalid_request'); return; }
    const data = input.data;
    await validateChatGPTClient(data.client_id, data.redirect_uri, options.metadataLoader);
    const scopes = data.scope === undefined ? defaults : data.scope.split(' ');
    if (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !agentScopes.includes(scope as typeof agentScopes[number]))) { res.redirect(302, redirectResult(origin, { redirect_uri: data.redirect_uri, state: data.state }, { error: 'invalid_scope' })); return; }
    let browser = cookie(req, browserName);
    if (!opaque.safeParse(browser).success) browser = token();
    res.cookie(browserName, browser, { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/', maxAge: 600000 });
    const requestToken = token();
    await transaction(pool, async db => {
      // Bound storage for unauthenticated starts. Expired requests/codes carry no audit history.
      await db.query('DELETE FROM oauth_pending WHERE expires_at<=$1', [at()]);
      const pending = Number((await db.query('SELECT count(*) FROM oauth_pending WHERE browser_hash=$1 AND consumed_at IS NULL', [sha256(browser!)])).rows[0].count);
      if (pending >= 10) throw new ApiError(429, 'Too many pending connections. Wait a few minutes and try again.');
      await db.query('INSERT INTO oauth_pending(request_hash,browser_hash,client_id,redirect_uri,resource,scope,state,challenge,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [sha256(requestToken), sha256(browser!), data.client_id, data.redirect_uri, resource, JSON.stringify(scopes), data.state, data.code_challenge, at(), new Date(now() + 600000).toISOString()]);
    });
    res.redirect(302, origin + '/oauth/consent?request=' + requestToken);
  });

  async function pendingRequest(db: PoolClient, req: Request, user: Row, bind: boolean) {
    const raw = opaque.parse(req.params.request);
    const browser = cookie(req, browserName);
    if (!opaque.safeParse(browser).success) throw new ApiError(403, 'Start this connection again from ChatGPT in this browser.');
    const pending = (await db.query('SELECT * FROM oauth_pending WHERE request_hash=$1 AND browser_hash=$2 AND expires_at>$3 AND consumed_at IS NULL FOR UPDATE', [sha256(raw), sha256(browser!), at()])).rows[0];
    if (!pending) throw new ApiError(404, 'The authorization request expired or belongs to another browser. Start again in ChatGPT.');
    const session = sessionHash(req);
    if (pending.user_id && (pending.user_id !== user.id || pending.session_hash !== session)) throw new ApiError(403, 'The account or login session changed. Start the connection again in ChatGPT.');
    if (!pending.user_id) {
      if (!bind) throw new ApiError(403, 'Open the authorization details before approving this request.');
      await db.query('UPDATE oauth_pending SET user_id=$1,session_hash=$2 WHERE request_hash=$3', [user.id, session, pending.request_hash]);
    }
    return pending;
  }
  app.get('/api/oauth/authorization/:request', requireEnabled, requireUser, async (req, res) => {
    const details = await transaction(pool, async db => {
      const pending = await pendingRequest(db, req, res.locals.user, true);
      return { client: { name: 'ChatGPT' }, user: { name: res.locals.user.name }, workspace: { name: res.locals.user.team_name }, scopes: pending.scope, expiresInMinutes: defaultAccessMinutes };
    });
    res.json(details);
  });

  function protocolServer(db: PoolClient, clientId: string, redirectUri: string, binding: Row) {
    const client = { id: clientId, grants: ['authorization_code'], redirectUris: [redirectUri] };
    const model: OAuth2Server.AuthorizationCodeModel = {
      getClient: async (id, secret) => id === clientId && !secret ? client : false,
      getAccessToken: async () => false,
      generateAccessToken: async () => 'sho_' + token(),
      generateRefreshToken: async () => '',
      generateAuthorizationCode: async () => token(),
      validateScope: async (_user, _client, scopes) => scopes && scopes.length && scopes.every(scope => binding.scope.includes(scope)) ? scopes : false,
      saveAuthorizationCode: async (code, _client, user) => {
        const expiresAt = new Date(now() + 300000);
        await db.query('INSERT INTO oauth_codes(code_hash,key_id,client_id,redirect_uri,resource,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [sha256(code.authorizationCode), user.keyId, clientId, redirectUri, resource, code.codeChallenge, expiresAt.toISOString()]);
        return { ...code, expiresAt, client, user };
      },
      getAuthorizationCode: async raw => {
        const code = (await db.query(`SELECT c.*,k.scopes,k.user_id,k.expires_at AS grant_expires_at FROM oauth_codes c JOIN agent_keys k ON k.id=c.key_id
          WHERE c.code_hash=$1 AND c.client_id=$2 AND c.redirect_uri=$3 AND c.resource=$4 AND c.consumed_at IS NULL AND c.expires_at>$5 AND k.kind='oauth' AND k.revoked_at IS NULL AND k.expires_at>$5 FOR UPDATE OF c,k`, [sha256(raw), clientId, redirectUri, binding.resource, at()])).rows[0];
        if (!code) return false;
        binding.keyId = code.key_id; binding.scope = code.scopes; binding.expiresAt = code.grant_expires_at;
        return { authorizationCode: raw, expiresAt: new Date(code.expires_at), redirectUri: code.redirect_uri, codeChallenge: code.challenge, codeChallengeMethod: 'S256', scope: code.scopes, client, user: { id: code.user_id, keyId: code.key_id } };
      },
      revokeAuthorizationCode: async code => Boolean((await db.query('UPDATE oauth_codes SET consumed_at=$1 WHERE code_hash=$2 AND consumed_at IS NULL', [at(), sha256(code.authorizationCode)])).rowCount),
      saveToken: async (issued, _client, user) => {
        const expiresAt = new Date(binding.expiresAt);
        await db.query('INSERT INTO oauth_access_tokens(token_hash,key_id,resource,expires_at) VALUES($1,$2,$3,$4)', [sha256(issued.accessToken), user.keyId, resource, expiresAt.toISOString()]);
        await db.query('INSERT INTO agent_audit(id,key_id,operation,created_at) VALUES($1,$2,$3,$4)', [uid(), user.keyId, 'oauth.token_issued', at()]);
        return { accessToken: issued.accessToken, accessTokenExpiresAt: expiresAt, scope: binding.scope, client, user };
      },
    };
    return new OAuth2Server({ model, requirePKCE: true, requireClientAuthentication: { authorization_code: false } });
  }
  app.post('/api/oauth/authorization/:request', requireEnabled, requireUser, async (req, res) => {
    const input = z.object({ approved: z.boolean(), expiresInMinutes: minutes.default(defaultAccessMinutes) }).strict().parse(req.body);
    const result = await transaction(pool, async db => {
      const user = res.locals.user;
      const pending = await pendingRequest(db, req, user, false);
      await db.query('UPDATE oauth_pending SET consumed_at=$1 WHERE request_hash=$2', [at(), pending.request_hash]);
      if (!input.approved) return { redirectUrl: redirectResult(origin, pending, { error: 'access_denied' }) };
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      if (Number((await db.query("SELECT count(*) FROM agent_keys WHERE user_id=$1 AND kind='oauth' AND revoked_at IS NULL AND expires_at>$2", [user.id, at()])).rows[0].count) >= 20) throw new ApiError(409, 'Revoke an existing connection first (maximum 20 active connections).');
      const keyId = uid(), expiresAt = new Date(now() + input.expiresInMinutes * 60000).toISOString();
      // Stable authorization identity: no usable manual API token is created or exposed.
      await db.query("INSERT INTO agent_keys(id,user_id,team_id,name,prefix,token_hash,scopes,created_at,expires_at,kind,resource,client_id) VALUES($1,$2,$3,'ChatGPT','oauth',$4,$5,$6,$7,'oauth',$8,$9)", [keyId, user.id, user.team_id, sha256(token()), JSON.stringify(pending.scope), at(), expiresAt, resource, pending.client_id]);
      const oauth = protocolServer(db, pending.client_id, pending.redirect_uri, pending);
      const response = new OAuth2Server.Response();
      await oauth.authorize(new OAuth2Server.Request({ method: 'GET', headers: {}, query: { response_type: 'code', client_id: pending.client_id, redirect_uri: pending.redirect_uri, scope: pending.scope.join(' '), state: pending.state, code_challenge: pending.challenge, code_challenge_method: 'S256' } }), response, { authenticateHandler: { handle: async () => ({ id: user.id, keyId }) } });
      const location = new URL(String(response.headers?.location));
      location.searchParams.set('iss', origin);
      await db.query('INSERT INTO agent_audit(id,key_id,operation,created_at) VALUES($1,$2,$3,$4)', [uid(), keyId, 'oauth.authorized', at()]);
      return { redirectUrl: location.href };
    });
    res.json(result);
  });

  protocol.post('/token', express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }), async (req, res) => {
    if (!req.is('application/x-www-form-urlencoded')) { errorResponse(res, 'invalid_request', 415); return; }
    const parsed = z.object({ grant_type: z.literal('authorization_code'), client_id: z.string().max(2048), code: opaque, redirect_uri: z.string().max(2048), resource: z.literal(resource), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).safeParse(req.body);
    if (!parsed.success || req.get('authorization') || req.body.client_secret !== undefined) { errorResponse(res, 'invalid_request'); return; }
    const input = parsed.data;
    // The client and callback were verified at authorization time; code binding prevents substitutions.
    const outcome = await transaction(pool, async db => {
      const binding: Row = { resource, scope: [] };
      const oauth = protocolServer(db, input.client_id, input.redirect_uri, binding);
      const response = new OAuth2Server.Response();
      try {
        const issued = await oauth.token(new OAuth2Server.Request({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(new URLSearchParams(input).toString())) }, query: {}, body: input }), response);
        return { issued };
      } catch (error) {
        if (!(error instanceof OAuth2Server.OAuthError)) throw error;
        if (error.code >= 500) throw new ApiError(500, 'The authorization server could not complete the request. Try again later.');
        // Library revocation before PKCE intentionally consumes a guessed code, even on failure.
        if (binding.keyId) await db.query('INSERT INTO agent_audit(id,key_id,operation,outcome,created_at) VALUES($1,$2,$3,$4,$5)', [uid(), binding.keyId, 'oauth.token_failed', 'http_400', at()]);
        return { error: error instanceof OAuth2Server.OAuthError ? error.name : 'invalid_grant' };
      }
    });
    if ('error' in outcome) { errorResponse(res, outcome.error ?? 'invalid_grant'); return; }
    res.json({ access_token: outcome.issued.accessToken, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((outcome.issued.accessTokenExpiresAt!.getTime() - now()) / 1000)), scope: outcome.issued.scope?.join(' ') });
  });
  app.use('/oauth', protocol);

  app.get('/api/oauth/connections', requireUser, async (_req, res) => {
    const connections = (await pool.query(`SELECT id,name AS "clientName",scopes,created_at AS "createdAt",expires_at AS "expiresAt",last_used_at AS "lastUsedAt",revoked_at AS "revokedAt" FROM agent_keys WHERE user_id=$1 AND team_id=$2 AND kind='oauth' ORDER BY created_at DESC LIMIT 100`, [res.locals.user.id, res.locals.user.team_id])).rows;
    res.json({ enabled, mcpUrl: resource, connections });
  });
  app.post('/api/oauth/connections/:id/revoke', requireUser, async (req, res) => {
    await transaction(pool, async db => {
      const id = z.uuid().parse(req.params.id);
      const changed = await db.query("UPDATE agent_keys SET revoked_at=COALESCE(revoked_at,$1) WHERE id=$2 AND user_id=$3 AND team_id=$4 AND kind='oauth'", [at(), id, res.locals.user.id, res.locals.user.team_id]);
      if (!changed.rowCount) throw new ApiError(404, 'Connection not found.');
      await db.query('INSERT INTO agent_audit(id,key_id,operation,created_at) VALUES($1,$2,$3,$4)', [uid(), id, 'oauth.revoked', at()]);
    });
    res.json({ ok: true });
  });
  return {
    execute: agent.execute,
    async authenticate(req): Promise<AgentContext> {
      if (!enabled) throw new ApiError(404, 'OAuth connections are disabled.');
      const auth = req.get('authorization') ?? '';
      if (!/^Bearer sho_[A-Za-z0-9_-]{43}$/i.test(auth)) throw new ApiError(401, 'Connect your Signhere account to continue.');
      const tokenHash = sha256(auth.slice(7));
      const key = (await pool.query(`SELECT k.*,u.name AS user_name,t.name AS team_name FROM oauth_access_tokens a JOIN agent_keys k ON k.id=a.key_id JOIN users u ON u.id=k.user_id AND u.team_id=k.team_id JOIN teams t ON t.id=k.team_id
        WHERE a.token_hash=$1 AND a.resource=$2 AND a.expires_at>$3 AND k.kind='oauth' AND k.resource=$2 AND k.expires_at>$3 AND k.revoked_at IS NULL`, [tokenHash, resource, at()])).rows[0];
      if (!key) throw new ApiError(401, 'The connection expired or was revoked. Reconnect through Signhere.');
      return { keyId: key.id, userId: key.user_id, teamId: key.team_id, userName: key.user_name, teamName: key.team_name, scopes: key.scopes, credential: { kind: 'oauth', tokenHash, resource } };
    },
  };
}
