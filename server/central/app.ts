/**
 * signhere central service: independent email-confirmed approval receipts.
 *
 * Optional for self-hosted installations; they never need it to sign or verify. The service
 * never receives PDF bytes: the participant's browser fetches the prepared PDF from the
 * installation (or a local file), hashes and renders it, and only the digest reaches here.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { transaction } from '../db.js';
import type { Mailer } from '../mail.js';
import { createCentralDatabase } from './db.js';
import { signJws, type Signer } from './keys.js';
import {
  APPROVAL_METHOD, CENTRAL_CONSENT, EMAIL_CONFIRMATION, RECEIPT_SCHEMA, RECEIPT_TYP, base64url, canonicalJson,
  normalizeEmail, receiptSchema, type ApprovalReceipt, type TrustBundle,
} from './protocol.js';

export interface CentralConfig {
  databaseUrl: string; schema?: string;
  /** Public origin of this service, e.g. https://signhere.prpl.se. Bound into every receipt. */
  origin: string;
  signer: Signer; trustBundle: { jws: string; bundle: TrustBundle; rootPublicKey: string };
  mailer: Mailer;
  now?: () => number; rateLimit?: boolean; webDir?: string; trustProxy?: string[];
  /** Days to keep closed or expired workflow rows (and receipts for retrieval). Default 30. */
  retentionDays?: number;
  maxOpenApprovalsPerInstance?: number;
  cleanup?: { autoStart?: boolean; intervalMs?: number };
}
class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const MINUTE = 60000, DAY = 86400000;
const CODE_TTL = 15 * MINUTE, CODE_ATTEMPTS = 5, CODE_SENDS = 5, CODE_COOLDOWN = 30000, MAX_APPROVAL_TTL = 30 * DAY;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const opaque = (prefix: string) => prefix + randomBytes(16).toString('base64url');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const plain = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'control characters');
const capabilityPattern = /^(apr_[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const iso = (ms: number) => new Date(ms).toISOString();
/** A URL on the installation's registered origin; never fetched by this server. */
const installationUrl = (origin: string) => z.string().max(2000).refine(value => {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password && !url.hash; } catch { return false; }
}, 'URL must be on the registered installation origin');

export async function createCentralApp(config: CentralConfig) {
  const base = new URL(config.origin);
  if (base.origin !== config.origin || !['https:', 'http:'].includes(base.protocol)) throw new Error('CENTRAL_ORIGIN must be an origin without a path.');
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('CENTRAL_ORIGIN must use HTTPS except on localhost.');
  if (config.trustBundle.bundle.service !== config.origin) throw new Error('The trust bundle names a different service origin.');
  const active = config.trustBundle.bundle.keys.find(key => key.kid === config.signer.kid);
  if (!active || active.status !== 'active' || !active.purposes.includes('approval-receipt')) throw new Error('The receipt key is not an active approval-receipt key in the trust bundle.');
  const now = config.now ?? Date.now;
  const retention = z.number().int().min(1).max(3650).parse(config.retentionDays ?? 30) * DAY;
  const maxOpen = config.maxOpenApprovalsPerInstance ?? 2000;
  const pool = await createCentralDatabase(config.databaseUrl, config.schema);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy?.length) app.set('trust proxy', config.trustProxy);
  const secure = base.protocol === 'https:';
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      // The participant's browser fetches the prepared PDF directly from the installation.
      connectSrc: ["'self'", 'https:', ...(secure ? [] : ['http://localhost:*', 'http://127.0.0.1:*'])],
      workerSrc: ["'self'", 'blob:'], frameSrc: ["'none'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      baseUri: ["'none'"], formAction: ["'none'"], upgradeInsecureRequests: secure ? [] : null,
    } },
    referrerPolicy: { policy: 'no-referrer' }, strictTransportSecurity: secure ? undefined : false,
  }));
  app.use(['/v1', '/.well-known'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (config.rateLimit !== false) {
    const limit = (windowMs: number, limit: number) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited', message: 'För många förfrågningar. Försök igen om en stund.' } });
    app.use('/v1/participant', limit(MINUTE, 60));
    app.use('/v1/participant/code', limit(15 * MINUTE, 10));
    app.use('/v1/approvals', limit(MINUTE, 600));
  }
  app.use('/v1', express.json({ limit: '16kb', strict: true }));
  app.use('/v1', (req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) return next(new HttpError(415, 'content_type', 'Förfrågan måste vara JSON.'));
    next();
  });

  app.get('/.well-known/signhere-trust.json', (_req, res) => {
    res.json({ protocol: 'signhere-central-v1', service: config.origin, bundle: config.trustBundle.jws, rootPublicKey: config.trustBundle.rootPublicKey,
      note: 'Pin the root public key through an independent channel. A key served here does not establish its own trust.' });
  });
  app.get('/v1/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // --- Installation API ---------------------------------------------------------------
  async function instanceAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9_.-]{20,200})$/.exec(header);
    if (!match) throw new HttpError(401, 'unauthorized', 'API-nyckel saknas.');
    const row = (await pool.query(`SELECT i.* FROM instance_credentials c JOIN instances i ON i.id=c.instance_id
      WHERE c.secret_hash=$1 AND c.revoked_at IS NULL`, [sha256(match[1])])).rows[0];
    if (!row) throw new HttpError(401, 'unauthorized', 'Ogiltig API-nyckel.');
    if (row.status !== 'active') throw new HttpError(403, 'instance_suspended', 'Installationens konto är avstängt.');
    if (!row.scopes.includes('approval')) throw new HttpError(403, 'scope', 'API-nyckeln saknar behörighet.');
    res.locals.instance = row;
    next();
  }
  const approvalRequest = (origin: string) => z.object({
    documentId: identifier, revisionId: identifier, recipientId: identifier,
    email: z.email().max(254), name: plain(160), title: plain(200),
    preparedSha256: digest, preparedSize: z.number().int().min(1).max(64 * 1024 * 1024),
    intentSha256: digest, policySha256: digest,
    participantCapabilitySha256: digest,
    documentUrl: installationUrl(origin), returnUrl: installationUrl(origin).optional(),
    expiresAt: z.iso.datetime(),
  }).strict();
  const approvalStatus = (row: Record<string, any>) => ({
    approvalId: row.id, status: effectiveStatus(row), expiresAt: iso(row.expires_at.getTime()),
    ...(row.status === 'approved' ? { receipt: row.receipt } : {}),
  });
  function effectiveStatus(row: Record<string, any>) {
    return ['pending', 'email_confirmed'].includes(row.status) && row.expires_at.getTime() <= now() ? 'expired' : row.status;
  }
  app.post('/v1/approvals', instanceAuth, async (req, res) => {
    const instance = res.locals.instance;
    const input = approvalRequest(instance.origin).parse(req.body);
    const expiresAt = Date.parse(input.expiresAt);
    if (expiresAt <= now() || expiresAt > now() + MAX_APPROVAL_TTL) throw new HttpError(400, 'expiry', 'Ogiltig giltighetstid.');
    const fingerprint = sha256(canonicalJson({ ...input, email: normalizeEmail(input.email) }));
    const result = await transaction(pool, async client => {
      const existing = (await client.query('SELECT * FROM approvals WHERE instance_id=$1 AND document_id=$2 AND revision_id=$3 AND recipient_id=$4 FOR UPDATE',
        [instance.id, input.documentId, input.revisionId, input.recipientId])).rows[0];
      if (existing) {
        // Identical retries are idempotent; any change needs a new document revision.
        if (existing.request_fingerprint !== fingerprint) throw new HttpError(409, 'conflict', 'En annan begäran finns redan för samma mottagare och version.');
        return { row: existing, created: false };
      }
      const open = Number((await client.query("SELECT count(*) AS n FROM approvals WHERE instance_id=$1 AND status IN ('pending','email_confirmed') AND expires_at>$2", [instance.id, new Date(now())])).rows[0].n);
      if (open >= maxOpen) throw new HttpError(429, 'quota', 'Installationen har för många öppna bekräftelser.');
      const row = (await client.query(`INSERT INTO approvals(id,instance_id,document_id,revision_id,recipient_id,email,claimed_name,title,prepared_sha256,prepared_size,
        intent_sha256,policy_sha256,document_url,return_url,request_fingerprint,capability_hash,status,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17,$18) RETURNING *`,
      [opaque('apr_'), instance.id, input.documentId, input.revisionId, input.recipientId, normalizeEmail(input.email), input.name, input.title,
        input.preparedSha256, input.preparedSize, input.intentSha256, input.policySha256, input.documentUrl, input.returnUrl ?? null, fingerprint,
        input.participantCapabilitySha256, new Date(now()), new Date(expiresAt)])).rows[0];
      return { row, created: true };
    });
    res.status(result.created ? 201 : 200).json({ ...approvalStatus(result.row), approvalUrl: config.origin + '/bekrafta' });
  });
  async function ownApproval(req: Request, res: Response) {
    const approvalId = z.string().regex(/^apr_[A-Za-z0-9_-]{22}$/).safeParse(req.params.id);
    const row = approvalId.success ? (await pool.query('SELECT * FROM approvals WHERE id=$1 AND instance_id=$2', [approvalId.data, res.locals.instance.id])).rows[0] : undefined;
    if (!row) throw new HttpError(404, 'not_found', 'Bekräftelsen finns inte.');
    return row;
  }
  app.get('/v1/approvals/:id', instanceAuth, async (req, res) => { res.json(approvalStatus(await ownApproval(req, res))); });
  app.post('/v1/approvals/:id/cancel', instanceAuth, async (req, res) => {
    const row = await ownApproval(req, res);
    const updated = (await pool.query("UPDATE approvals SET status='cancelled' WHERE id=$1 AND status IN ('pending','email_confirmed') RETURNING *", [row.id])).rows[0];
    res.json(approvalStatus(updated ?? row));
  });

  // --- Participant API (capability from the URL fragment, sent as a header) ---------------
  async function participant(req: Request, lock = false, client: Pick<Pool, 'query'> = pool) {
    const match = capabilityPattern.exec((req.get('authorization') ?? '').replace(/^Capability /, ''));
    if (!match || !(req.get('authorization') ?? '').startsWith('Capability ')) throw new HttpError(401, 'unauthorized', 'Länken är ofullständig.');
    const row = (await client.query('SELECT a.*,i.name AS instance_name,i.origin AS instance_origin,i.status AS instance_status FROM approvals a JOIN instances i ON i.id=a.instance_id WHERE a.id=$1' + (lock ? ' FOR UPDATE OF a' : ''), [match[1]])).rows[0];
    if (!row || !timingSafeEqual(Buffer.from(row.capability_hash, 'hex'), Buffer.from(sha256(match[2]), 'hex'))) throw new HttpError(404, 'not_found', 'Länken är ogiltig eller har upphört att gälla.');
    return row;
  }
  /** Participant mutations: authenticate the capability, then require the service's own page as origin. */
  async function requireOrigin(req: Request) {
    await participant(req);
    if (req.get('origin') !== config.origin) throw new HttpError(403, 'origin', 'Förfrågan måste komma från tjänstens egen sida.');
  }
  const sessionDto = (row: Record<string, any>, challenge?: Record<string, any>) => ({
    approvalId: row.id, status: effectiveStatus(row), expiresAt: iso(row.expires_at.getTime()),
    title: row.title, claimedName: row.claimed_name, email: row.email,
    preparedSha256: row.prepared_sha256, preparedSize: row.prepared_size,
    documentUrl: row.document_url, returnUrl: row.return_url,
    installation: { name: row.instance_name, origin: row.instance_origin, verifiedOrganisation: false },
    consent: CENTRAL_CONSENT,
    ...(challenge ? { code: { sentAt: iso(challenge.sent_at.getTime()), expiresAt: iso(challenge.expires_at.getTime()), resendAfter: iso(challenge.sent_at.getTime() + CODE_COOLDOWN) } } : {}),
    ...(row.status === 'approved' ? { receipt: row.receipt } : {}),
  });
  function requireOpen(row: Record<string, any>) {
    const status = effectiveStatus(row);
    if (status === 'expired') throw new HttpError(410, 'expired', 'Bekräftelsen har upphört att gälla. Be avsändaren om en ny länk.');
    if (status === 'cancelled') throw new HttpError(410, 'cancelled', 'Avsändaren har avbrutit signeringen.');
    if (row.instance_status !== 'active') throw new HttpError(403, 'instance_suspended', 'Tjänsten är inte tillgänglig för den här avsändaren.');
  }
  app.get('/v1/participant/session', async (req, res) => {
    const row = await participant(req);
    const challenge = (await pool.query('SELECT * FROM email_challenges WHERE approval_id=$1', [row.id])).rows[0];
    res.json(sessionDto(row, challenge));
  });
  app.post('/v1/participant/code', async (req, res) => {
    await requireOrigin(req);
    z.object({}).strict().parse(req.body ?? {});
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const row = await transaction(pool, async client => {
      const row = await participant(req, true, client);
      requireOpen(row);
      if (row.status !== 'pending') throw new HttpError(409, 'already_confirmed', 'E-postadressen är redan bekräftad.');
      const previous = (await client.query('SELECT * FROM email_challenges WHERE approval_id=$1 FOR UPDATE', [row.id])).rows[0];
      if (previous && previous.sent_at.getTime() + CODE_COOLDOWN > now()) throw new HttpError(429, 'cooldown', 'Vänta en stund innan du begär en ny kod.');
      if (previous && previous.sends >= CODE_SENDS) throw new HttpError(429, 'send_limit', 'Du har begärt för många koder. Be avsändaren om en ny länk.');
      // A new code replaces the previous one; its attempt counter starts over.
      await client.query(`INSERT INTO email_challenges(approval_id,code_hash,sent_at,expires_at,attempts,sends) VALUES($1,$2,$3,$4,0,1)
        ON CONFLICT(approval_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,sent_at=EXCLUDED.sent_at,expires_at=EXCLUDED.expires_at,attempts=0,sends=email_challenges.sends+1`,
      [row.id, sha256(row.id + ':' + code), new Date(now()), new Date(now() + CODE_TTL)]);
      return row;
    });
    try {
      await config.mailer.send({ to: row.email, idempotencyKey: randomUUID(), subject: 'Din bekräftelsekod: ' + code.slice(0, 4) + ' ' + code.slice(4), text: [
        'Din kod för att bekräfta e-postadressen hos signhere är:', '', code.slice(0, 4) + ' ' + code.slice(4), '',
        'Koden gäller i 15 minuter. Ange den på bekräftelsesidan (' + config.origin + '/bekrafta).',
        'Koden visar bara att du har tillgång till den här e-posten. Du godkänner dokumentet i ett separat steg.', '',
        'Har du inte begärt koden kan du ignorera meddelandet. Dela aldrig koden med någon.', '', '– signhere',
      ].join('\n') });
    } catch {
      console.error('signhere-central: code delivery failed');
      throw new HttpError(503, 'mail_unavailable', 'Koden kunde inte skickas just nu. Försök igen om en stund.');
    }
    const challenge = (await pool.query('SELECT * FROM email_challenges WHERE approval_id=$1', [row.id])).rows[0];
    res.json(sessionDto(row, challenge));
  });
  app.post('/v1/participant/confirm', async (req, res) => {
    await requireOrigin(req);
    const { code } = z.object({ code: z.string().regex(/^\d{4} ?\d{4}$/, 'Koden består av 8 siffror.') }).strict().parse(req.body);
    const outcome = await transaction(pool, async client => {
      const row = await participant(req, true, client);
      requireOpen(row);
      if (row.status !== 'pending') return { row, ok: true };
      const challenge = (await client.query('SELECT * FROM email_challenges WHERE approval_id=$1 FOR UPDATE', [row.id])).rows[0];
      if (!challenge) throw new HttpError(409, 'no_code', 'Begär en kod först.');
      if (challenge.expires_at.getTime() <= now()) throw new HttpError(410, 'code_expired', 'Koden har gått ut. Begär en ny kod.');
      if (challenge.attempts >= CODE_ATTEMPTS) throw new HttpError(429, 'attempts', 'För många felaktiga försök. Begär en ny kod.');
      const match = timingSafeEqual(Buffer.from(challenge.code_hash, 'hex'), Buffer.from(sha256(row.id + ':' + code.replace(' ', '')), 'hex'));
      if (!match) {
        await client.query('UPDATE email_challenges SET attempts=attempts+1 WHERE approval_id=$1', [row.id]);
        return { row, ok: false };
      }
      await client.query('DELETE FROM email_challenges WHERE approval_id=$1', [row.id]);
      return { row: (await client.query("UPDATE approvals SET status='email_confirmed',email_confirmed_at=$2 WHERE id=$1 RETURNING *", [row.id, new Date(now())])).rows[0], ok: true };
    });
    // Committed attempt counters must survive the failed response.
    if (!outcome.ok) throw new HttpError(400, 'wrong_code', 'Fel kod. Kontrollera koden i e-postmeddelandet.');
    const row = await participant(req);
    res.json(sessionDto(row));
  });
  app.post('/v1/participant/approve', async (req, res) => {
    await requireOrigin(req);
    const input = z.object({
      preparedSha256: digest, consentVersion: z.literal(CENTRAL_CONSENT.version, 'Samtycket stämmer inte. Ladda om sidan.'),
      accepted: z.literal(true), documentSource: z.enum(['installation-transfer', 'local-file']),
    }).strict().parse(req.body);
    const row = await transaction(pool, async client => {
      const row = await participant(req, true, client);
      if (row.status === 'approved') {
        if (row.prepared_sha256 !== input.preparedSha256) throw new HttpError(409, 'mismatch', 'Dokumentet stämmer inte med det godkända.');
        return row;
      }
      requireOpen(row);
      if (row.status !== 'email_confirmed') throw new HttpError(409, 'email_unconfirmed', 'Bekräfta e-postadressen först.');
      if (row.prepared_sha256 !== input.preparedSha256) throw new HttpError(409, 'mismatch', 'Dokumentet du har öppnat är inte det som ska godkännas. Kontakta avsändaren.');
      const approvedAt = iso(now());
      const payload: ApprovalReceipt = receiptSchema.parse({
        schema: RECEIPT_SCHEMA, receiptId: randomUUID(), service: config.origin, keyId: config.signer.kid,
        instance: { id: row.instance_id },
        transaction: { documentId: row.document_id, revisionId: row.revision_id, recipientId: row.recipient_id },
        document: { preparedSha256: row.prepared_sha256, preparedSize: row.prepared_size },
        intentSha256: row.intent_sha256, policySha256: row.policy_sha256, consent: CENTRAL_CONSENT,
        email: { address: row.email, confirmation: EMAIL_CONFIRMATION, confirmedAt: iso(row.email_confirmed_at.getTime()) },
        claims: { name: row.claimed_name, nameVerified: false },
        approval: { method: APPROVAL_METHOD, approvedAt, documentSource: input.documentSource },
        assurance: { civilIdentityVerified: false, trustedTimestamp: false },
        nonce: base64url(randomBytes(32)), issuedAt: approvedAt,
      });
      // Signing happens inside the transaction that consumes the confirmed state: no receipt
      // exists without the committed approval, and a retry returns the stored bytes.
      const receipt = await signJws(config.signer, RECEIPT_TYP, payload);
      return (await client.query("UPDATE approvals SET status='approved',approved_at=$2,receipt=$3,receipt_id=$4 WHERE id=$1 RETURNING *", [row.id, new Date(now()), receipt, payload.receiptId])).rows[0];
    });
    const fresh = await participant(req);
    res.json({ ...sessionDto(fresh), receipt: row.receipt });
  });

  app.use('/v1', (_req, _res, next) => next(new HttpError(404, 'not_found', 'API-adressen finns inte.')));
  const webDir = resolve(config.webDir ?? 'dist/central-web');
  try {
    await access(join(webDir, 'index.html'));
    app.use(express.static(webDir, { index: false, dotfiles: 'deny', maxAge: 0 }));
    app.get(['/', '/bekrafta', '/verifiera'], (_req, res) => res.sendFile(join(webDir, 'index.html')));
  } catch { /* API-only in tests and during frontend development. */ }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof ZodError) { res.status(400).json({ error: 'invalid_request', message: error.issues[0]?.message ?? 'Kontrollera uppgifterna.' }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.code, message: error.message }); return; }
    if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ error: 'too_large', message: 'Förfrågan är för stor.' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'invalid_json', message: 'Ogiltig JSON.' }); return; }
    // Never log request bodies, capabilities, codes or addresses.
    console.error('signhere-central: request failed', (error as { code?: string })?.code ?? 'internal');
    res.status(500).json({ error: 'internal', message: 'Ett serverfel uppstod. Försök igen.' });
  });

  /** Deletes closed and expired workflow state after the retention window. */
  async function cleanup() {
    const cutoff = new Date(now() - retention);
    const result = await pool.query(`DELETE FROM approvals WHERE (status IN ('approved','cancelled') AND COALESCE(approved_at,expires_at)<$1)
      OR (status IN ('pending','email_confirmed') AND expires_at<$1)`, [cutoff]);
    return result.rowCount ?? 0;
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  if (config.cleanup?.autoStart !== false) {
    timer = setInterval(() => { void cleanup().catch(() => console.error('signhere-central: cleanup failed')); }, config.cleanup?.intervalMs ?? 3600000);
    timer.unref();
  }
  return { app, pool, cleanup, close: async () => { if (timer) clearInterval(timer); await pool.end(); } };
}

/** Admin operations (used by the CLI and tests). Secrets are returned once and stored hashed. */
export async function createInstance(pool: Pool, input: { name: string; origin: string; scopes?: string[] }) {
  const origin = new URL(input.origin);
  if (origin.origin !== input.origin) throw new Error('Installation origin must be an origin without a path, e.g. https://sign.example.se');
  const id = opaque('ins_');
  await pool.query("INSERT INTO instances(id,name,origin,status,scopes) VALUES($1,$2,$3,'active',$4)", [id, input.name, input.origin, input.scopes ?? ['approval']]);
  return { instanceId: id, apiKey: await issueCredential(pool, id) };
}
export async function issueCredential(pool: Pool, instanceId: string, revokeOthers = false) {
  const credentialId = opaque('cred_');
  const apiKey = 'shc_' + credentialId.slice(5) + '.' + randomBytes(32).toString('base64url');
  await transaction(pool, async client => {
    if (revokeOthers) await client.query('UPDATE instance_credentials SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL', [instanceId]);
    await client.query('INSERT INTO instance_credentials(id,instance_id,secret_hash) VALUES($1,$2,$3)', [credentialId, instanceId, sha256(apiKey)]);
  });
  return apiKey;
}
export async function setInstanceStatus(pool: Pool, instanceId: string, status: 'active' | 'suspended') {
  return (await pool.query('UPDATE instances SET status=$2 WHERE id=$1', [instanceId, status])).rowCount === 1;
}
