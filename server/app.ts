import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { createDatabase, transaction, appendEvent, uid, canonical, type Row } from './db.js';
import { ApiError, token, equalSecret, hashPassword, verifyPassword } from './security.js';
import { sha256, preparePdf, finalizePdf, MAX_PDF_BYTES } from './pdf.js';
import { CONSENT, getSigningMethod, listMethods } from './plugins.js';
import { createFinalizationWorker, enqueueFinalization, retryFinalization, FinalizationActionRequiredError } from './finalization.js';
import { createKeyStore } from './key-store.js';
import { signPdf, preflightSealPdf, SealInputError, type SealManifest } from './seal.js';
import { LOCAL_SEAL_POLICY, signingIntent, intentEvidence, freezeEvidenceCore } from './evidence.js';
import { participantPackage, verificationPackage } from './verification-package.js';
import { createPdfReadiness } from './pdf-readiness.js';
import { createResponseBudget } from './response-budget.js';
import { createDeliveryWorker, enqueueCompletedCopies, listDeliveries, resendDelivery } from './delivery.js';
import type { Mailer } from './mail.js';
import { createNotifier, type Message, type Notifier } from './notify.js';
import type { CentralClient } from './central-client.js';
import { approvalRequired, createIndependentApprovals, policyOf } from './independent-approval.js';

export interface AppConfig {
  databaseUrl: string; dataDir: string; baseUrl: string; schema?: string;
  setupToken?: string; now?: () => number; rateLimit?: boolean; webDir?: string; trustProxy?: string[];
  pdfFinalizer?: typeof finalizePdf;
  migrationDatabaseUrl?: string; keysDir?: string; sealP12File?: string; sealPasswordFile?: string;
  /** Internal compatibility-test switch. The production entrypoint always creates sealed v2 documents. */
  legacyCreation?: boolean;
  signingLinkTtlDays?: number;
  finalization?: { autoStart?: boolean; pollMs?: number };
  /** Optional durable completed-copy e-mail (sealed PDF to every party). Null or absent disables it. */
  mailer?: Mailer | null;
  delivery?: { autoStart?: boolean; pollMs?: number; retryBaseMs?: number };
  /** Optional best-effort e-mail of signing links. Without it, personal links are shared manually. */
  notifier?: Notifier;
  /** Optional central service for independent approval. Null or absent: no central requests, no central controls. */
  central?: CentralClient | null;
}
const DAY = 86400000;
const nameSchema = z.string().trim().min(1).max(160).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Ogiltiga tecken i namnet.');
const emailSchema = z.email('Ogiltig e-postadress.').trim().toLowerCase().max(254);
const passwordSchema = z.string().min(12, 'Lösenordet behöver minst 12 tecken.').max(128);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = (value: unknown) => z.uuid().parse(value);
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
const docColumns = 'id,team_id,created_by,title,file_name,original_hash,size,pages,status,sender,method_id,method_version,created_at,completed_at,completed_hash,signing_checkpoint,preparation,evidence_version,protection_policy,seal_metadata,parent_id,attachment_number';
const MAX_ATTACHMENTS = 50;
const toUser = (row: Row) => ({ id: row.id, name: row.name, email: row.email, role: row.role, teamId: row.team_id, teamName: row.team_name });
const consentFor = (recipient: Row) => recipient.signing_intent ? z.object({ version: z.string().min(1).max(128), text: z.string().min(1).max(10000) }).parse(JSON.parse(recipient.signing_intent.toString('utf8')).consent) : CONSENT;
const eventDto = (row: Row) => ({ sequence: row.sequence, type: row.type, at: row.at, data: row.data, hash: row.hash, previousHash: row.previous_hash });
function requestEvidence(req: Request) { return { ip: (req.ip ?? '').slice(0, 128), userAgent: (req.get('user-agent') ?? '').slice(0, 512) }; }
async function documentDto(db: Queryable, row: Row, publicView = false, summary = false, deliveries = false): Promise<Row> {
  const recipients = (await db.query('SELECT ' + (summary ? 'id,name,email,method_id,method_version,viewed_at,signed_at,parent_recipient_id' : '*') + ' FROM recipients WHERE document_id=$1 ORDER BY position', [row.id])).rows;
  const events = publicView || summary ? [] : (await db.query('SELECT * FROM events WHERE document_id=$1 ORDER BY sequence', [row.id])).rows.map(eventDto);
  const created = events[0]?.data ?? (await db.query('SELECT data FROM events WHERE document_id=$1 AND sequence=1', [row.id])).rows[0]?.data;
  // New documents explicitly distinguish the sender assignment from other parties,
  // including parties who share the same email address. Older snapshots did not.
  const independentPolicy = row.protection_policy?.independentApproval;
  const approvals = independentPolicy ? (await db.query('SELECT recipient_id,status,verified_at,receipt_sha256 FROM central_approvals WHERE document_id=$1', [row.id])).rows : [];
  const legacySenderMatches = recipients.filter(recipient => recipient.email === row.sender.email && recipient.name === row.sender.name);
  const senderRecipientId = created && Object.hasOwn(created, 'senderRecipientId')
    ? created.senderRecipientId
    : legacySenderMatches.length === 1 ? legacySenderMatches[0].id : null;
  const result: Row = {
    id: row.id, title: row.title, fileName: row.file_name, size: row.size, pages: row.pages, status: row.status,
    originalHash: row.original_hash, completedHash: row.completed_hash, createdAt: row.created_at, completedAt: row.completed_at,
    sender: row.sender, senderRecipientId, evidenceVersion: row.evidence_version,
    // Read from the creation snapshot so exported evidence matches the frozen evidence core.
    ...(created?.attachmentOf ? { attachmentOf: created.attachmentOf } : {}),
    ...(row.seal_metadata ? { seal: { profile: row.seal_metadata.profile, fingerprintSha256: row.seal_metadata.certificateFingerprint, cryptographicPdfSeal: true, trustedTimestamp: false, identityVerified: false } } : {}),
    ...(row.preparation ? { preparation: row.preparation } : {}),
    ...(independentPolicy ? { independentApproval: { service: independentPolicy.service, method: 'email' } } : {}),
    recipients: recipients.map((recipient: Row) => ({
      id: recipient.id, name: recipient.name, ...(publicView ? {} : { email: recipient.email }),
      methodId: recipient.method_id, methodVersion: recipient.method_version, viewedAt: recipient.viewed_at, signedAt: recipient.signed_at,
      ...(!publicView && recipient.parent_recipient_id ? { parentRecipientId: recipient.parent_recipient_id } : {}),
      ...(recipient.signature ? { signature: recipient.signature, signedName: recipient.claimed_name } : {}),
      ...(independentPolicy ? { independentApproval: (() => { const found = approvals.find(item => item.recipient_id === recipient.id); return found?.status === 'verified' ? { status: 'verified', at: found.verified_at, receiptSha256: found.receipt_sha256 } : { status: found?.status ?? 'not-started' }; })() } : {}),
      ...(!publicView && recipient.evidence ? { ip: recipient.evidence.ip, userAgent: recipient.evidence.userAgent } : {}),
    })),
    events,
    ...(deliveries && !publicView && !summary ? { deliveries: await listDeliveries(db, row.id) } : {}),
  };
  if (row.status === 'finalizing') {
    const job = (await db.query('SELECT status,last_error_code FROM finalization_jobs WHERE document_id=$1', [row.id])).rows[0];
    result.finalization = { state: job?.status === 'action_required' ? 'action_required' : 'working', ...(!publicView && job?.last_error_code ? { code: job.last_error_code } : {}) };
  }
  return result;
}

export async function createApp(config: AppConfig) {
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('BASE_URL must be an http(s) origin without a path.');
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('BASE_URL must use HTTPS except on localhost.');
  const origin = base.origin;
  const linkTtlDays = z.number().int().min(1).max(365).parse(config.signingLinkTtlDays ?? 7);
  const now = config.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  const pool = await createDatabase(config.databaseUrl, config.schema, config.migrationDatabaseUrl);
  const keys = config.legacyCreation ? null : await createKeyStore(pool, { keysDir: config.keysDir ?? join(config.dataDir, 'keys'), p12File: config.sealP12File, passwordFile: config.sealPasswordFile });
  const pdfReady = createPdfReadiness();
  const mailer = config.mailer ?? null;
  const finalization = createFinalizationWorker(pool, {
    signingIdentity: async () => { if (!keys) throw new Error('Sealing is unavailable.'); return keys.signingIdentity(); },
    buildArtifact: async snapshot => {
      const { document, recipients, checkpoint, evidenceCore, signingIdentity: identity } = snapshot;
      if (!identity || !keys || document.protection_policy?.timestamp !== 'off') throw new FinalizationActionRequiredError('unsupported_sealing_policy');
      const core = JSON.parse(evidenceCore.toString('utf8'));
      if (core.document.id !== document.id || core.document.originalHash !== document.original_hash || core.installationId !== identity.installationId) throw new FinalizationActionRequiredError('frozen_evidence_mismatch');
      const frozenSigners = core.recipients.map((recipient: Row) => {
        const event = core.events.find((event: Row) => event.type === 'recipient.signed' && event.data.recipientId === recipient.id);
        if (!event) throw new FinalizationActionRequiredError('frozen_signature_missing');
        return { name: recipient.name, signedName: recipient.signedName, email: recipient.email, signedAt: recipient.signedAt,
          strokes: event.data.signature?.strokes ?? [], methodId: recipient.methodId, methodVersion: recipient.methodVersion, consent: event.data.consent };
      });
      // Independent approval receipts are committed in the protected seal manifest, so a
      // participant can check inclusion of their own receipt without the private evidence core.
      const independentPolicy = policyOf(document);
      const approvalReceipts = core.recipients.filter((recipient: Row) => recipient.independentApproval).map((recipient: Row) => ({ recipientId: recipient.id, receiptSha256: recipient.independentApproval.receiptSha256 }));
      if (independentPolicy && core.recipients.some((recipient: Row) => approvalRequired(document, { method_id: recipient.methodId }) && !recipient.independentApproval)) throw new FinalizationActionRequiredError('independent_approval_missing');
      const candidate = await (config.pdfFinalizer ?? finalizePdf)(document.original, core.document.title, core.document.id, core.document.originalHash, frozenSigners[0].consent, frozenSigners, checkpoint, true, core.document.attachmentOf);
      const manifest: SealManifest = { schema: 'signhere-seal-v1', evidenceSchema: 2, installationId: identity.installationId,
        documentId: document.id, evidenceDigest: sha256(evidenceCore), preparedHash: document.original_hash,
        checkpoint, certificateFingerprint: identity.fingerprintSha256,
        ...(independentPolicy ? { policy: { timestamp: 'off', independentApproval: 'email' }, approvalReceipts } : { policy: { timestamp: 'off' } }) };
      const result = await signPdf(candidate, manifest, await keys.keyFor(identity.fingerprintSha256));
      return { bytes: result.bytes, sealMetadata: { profile: result.metadata.profile, certificateFingerprint: result.metadata.certificateFingerprint, certificatePem: result.metadata.certificatePem, manifest: result.metadata.manifest, pdfHash: result.metadata.pdfHash } };
    },
    onPublished: documentId => afterCompletion(documentId),
  }, { now, pollMs: config.finalization?.pollMs, onPublished: mailer ? (client, documentId) => enqueueCompletedCopies(client, documentId) : undefined });
  const independent = createIndependentApprovals(pool, { client: config.central ?? null, origin, now });
  const delivery = mailer ? createDeliveryWorker(pool, mailer, { origin, now, pollMs: config.delivery?.pollMs, retryBaseMs: config.delivery?.retryBaseMs }) : null;
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const setupPath = join(config.dataDir, 'setup-token');
  const setupRequired = () => pool.query('SELECT EXISTS(SELECT 1 FROM users) AS exists').then(result => !result.rows[0].exists);
  let setupHash: string | undefined;
  if (await setupRequired()) {
    if (config.setupToken) {
      if (config.setupToken.length < 32 || config.setupToken.length > 256) throw new Error('SETUP_TOKEN must contain 32–256 characters.');
      setupHash = sha256(config.setupToken);
    } else {
      let secret: string;
      try { secret = (await readFile(setupPath, 'utf8')).trim(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        secret = token();
        try { await writeFile(setupPath, secret + '\n', { mode: 0o600, flag: 'wx' }); }
        catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError; secret = (await readFile(setupPath, 'utf8')).trim(); }
      }
      if (secret.length < 32 || secret.length > 256) throw new Error('Invalid setup-token file.');
      setupHash = sha256(secret);
    }
  } else await unlink(setupPath).catch(() => {});

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy?.length) app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'], frameSrc: ["'self'", 'blob:'], objectSrc: ["'none'"],
      frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"],
      upgradeInsecureRequests: base.protocol === 'https:' ? [] : null,
    } },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: base.protocol === 'https:' ? undefined : false,
  }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (config.rateLimit !== false) {
    app.use('/api', rateLimit({ windowMs: 60000, limit: 150, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'För många förfrågningar. Försök igen om en stund.' } }));
    app.use(['/api/login', '/api/setup', '/api/invitations/accept'], rateLimit({ windowMs: 15 * 60000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'För många inloggningsförsök. Försök igen senare.' } }));
    app.use(['/api/sign', '/api/verify'], rateLimit({ windowMs: 60000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'För många förfrågningar. Försök igen om en stund.' } }));
  }
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== origin) return next(new ApiError(403, 'Förfrågan måste komma från plattformens egen adress.'));
      if (!req.is('application/json')) return next(new ApiError(415, 'Förfrågan måste vara JSON.'));
    }
    next();
  });
  const smallJson = express.json({ limit: '32kb', strict: true });
  const signingJson = express.json({ limit: '1mb', strict: true });
  const uploadJson = express.json({ limit: '15mb', strict: true });
  app.use('/api', async (req, res, next) => {
    if (req.method === 'POST' && /^\/documents(?:\/prepare|\/[0-9a-f-]{36}\/attachments)?\/?$/i.test(req.path)) {
      // Authenticate before allocating the large base64 upload body.
      await requireUser(req, res, () => uploadJson(req, res, next));
      return;
    }
    if (req.method === 'POST' && /^\/sign\/complete\/?$/i.test(req.path)) signingJson(req, res, next);
    else smallJson(req, res, next);
  });
  const cookieOptions = { httpOnly: true, secure: base.protocol === 'https:', sameSite: 'strict' as const, path: '/', maxAge: 12 * 60 * 60 * 1000 };
  function sessionToken(req: Request) {
    const value = (req.get('cookie') ?? '').split(';').map(item => item.trim()).find(item => item.startsWith('signhere_session='))?.slice('signhere_session='.length);
    return value && tokenSchema.safeParse(value).success ? value : undefined;
  }
  async function currentUser(req: Request) {
    const value = sessionToken(req);
    if (!value) return undefined;
    return (await pool.query('SELECT u.*,t.name AS team_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN teams t ON t.id=u.team_id WHERE s.token_hash=$1 AND s.expires_at>$2', [sha256(value), now()])).rows[0];
  }
  async function requireUser(req: Request, res: Response, next: NextFunction) {
    const user = await currentUser(req);
    if (!user) throw new ApiError(401, 'Logga in för att fortsätta.');
    res.locals.user = user;
    next();
  }
  function owner(res: Response) { if (res.locals.user.role !== 'owner') throw new ApiError(403, 'Endast teamägaren kan göra detta.'); }
  async function newSession(client: PoolClient, userId: string) {
    const raw = token();
    await client.query('DELETE FROM sessions WHERE expires_at<=$1', [now()]);
    await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [sha256(raw), userId, now() + cookieOptions.maxAge]);
    return raw;
  }
  async function ownedDocument(db: Queryable, documentId: unknown, teamId: string, lock = false) {
    const row = (await db.query('SELECT ' + docColumns + ' FROM documents WHERE id=$1 AND team_id=$2' + (lock ? ' FOR UPDATE' : ''), [id(documentId), teamId])).rows[0];
    if (!row) throw new ApiError(404, 'Dokumentet finns inte.');
    return row;
  }
  async function bearer(client: Queryable, raw: string, lock = false) {
    const found = (await client.query('SELECT document_id FROM recipients WHERE token_hash=$1', [sha256(raw)])).rows[0];
    if (!found) throw new ApiError(404, 'Signeringslänken är ogiltig eller har upphört att gälla.');
    const document = (await client.query('SELECT ' + docColumns + ' FROM documents WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [found.document_id])).rows[0];
    const recipient = (await client.query('SELECT * FROM recipients WHERE document_id=$1 AND token_hash=$2', [found.document_id, sha256(raw)])).rows[0];
    if (!document || !recipient) throw new ApiError(404, 'Signeringslänken är ogiltig eller har upphört att gälla.');
    // An accepted link is a receipt. Keep it usable while the other parties sign and
    // finalization runs, then for 30 days after completion, so every signer can fetch the
    // completed PDF even when the last signature arrives long after theirs.
    const receiptUntil = !recipient.signed_at ? Number(recipient.expires_at)
      : document.status === 'completed' ? Math.max(Number(recipient.expires_at), Date.parse(document.completed_at) + 30 * DAY)
      : Infinity;
    if (receiptUntil <= now()) throw new ApiError(404, 'Signeringslänken är ogiltig eller har upphört att gälla.');
    if (document.status === 'cancelled') throw new ApiError(410, 'Dokumentet har avbrutits.');
    return { document, recipient };
  }
  /** The main-document party a recipient represents, if any. Parties added only to a bilaga have none. */
  const mainPartyId = (document: Row, recipient: Row): string | null => document.parent_id ? recipient.parent_recipient_id : recipient.id;
  /**
   * A party's personal link also reaches the main document and bilagor that the same party signs.
   * Without documentId this is the link's own assignment.
   */
  async function partyTarget(client: Queryable, raw: string, documentId: string | undefined, lock = false) {
    if (!documentId) return bearer(client, raw, lock);
    const own = await bearer(client, raw);
    if (documentId === own.document.id) return lock ? bearer(client, raw, true) : own;
    const target = await relatedTarget(client, own, documentId, lock);
    if (target.document.status === 'cancelled' && !target.recipient.signed_at) throw new ApiError(410, 'Dokumentet har avbrutits.');
    return { ...target, via: own.recipient as Row };
  }
  async function relatedTarget(client: Queryable, own: { document: Row; recipient: Row }, documentId: string, lock = false) {
    const target = (await client.query('SELECT ' + docColumns + ' FROM documents WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id(documentId)])).rows[0];
    const partyId = mainPartyId(own.document, own.recipient);
    if (!target || !partyId || (target.parent_id ?? target.id) !== (own.document.parent_id ?? own.document.id)) throw new ApiError(404, 'Dokumentet finns inte.');
    const recipient = (await client.query('SELECT * FROM recipients WHERE document_id=$1 AND ' + (target.parent_id ? 'parent_recipient_id' : 'id') + '=$2', [target.id, partyId])).rows[0];
    if (!recipient) throw new ApiError(404, 'Dokumentet finns inte.');
    return { document: target as Row, recipient: recipient as Row };
  }
  /** Signing links and completed-copy links both identify a party for read-only access. */
  async function partyCredential(client: Queryable, raw: string) {
    const signing = (await client.query('SELECT 1 FROM recipients WHERE token_hash=$1', [sha256(raw)])).rowCount;
    if (signing) return bearer(client, raw);
    const copy = (await client.query('SELECT document_id,recipient_id FROM completed_copy_access WHERE token_hash=$1 AND expires_at>$2', [sha256(raw), now()])).rows[0];
    if (!copy) throw new ApiError(404, 'Länken är ogiltig eller har upphört att gälla.');
    const document = (await client.query('SELECT ' + docColumns + ' FROM documents WHERE id=$1', [copy.document_id])).rows[0];
    const recipient = (await client.query('SELECT * FROM recipients WHERE id=$1 AND document_id=$2', [copy.recipient_id, copy.document_id])).rows[0];
    return { document, recipient };
  }
  /** The main document (when this party signed it) and every bilaga this party signs, oldest first. */
  async function partyDocuments(client: Queryable, document: Row, recipient: Row) {
    const rootId = document.parent_id ?? document.id;
    const partyId = mainPartyId(document, recipient);
    const rows = (await client.query('SELECT ' + docColumns + ' FROM documents d WHERE (d.id=$1 AND $2::uuid IS NOT NULL) OR d.id=$3 OR (d.parent_id=$1 AND EXISTS(SELECT 1 FROM recipients r WHERE r.document_id=d.id AND r.parent_recipient_id=$2)) ORDER BY d.attachment_number NULLS FIRST', [rootId, partyId, document.id])).rows;
    const result: Row[] = [];
    for (const row of rows) {
      const party = row.id === document.id ? recipient : (await client.query('SELECT * FROM recipients WHERE document_id=$1 AND ' + (row.parent_id ? 'parent_recipient_id' : 'id') + '=$2', [row.id, partyId])).rows[0];
      const recipients = (await client.query('SELECT id,name,claimed_name FROM recipients WHERE document_id=$1', [row.id])).rows;
      const actor = (recipientId: unknown) => { const found = recipients.find(item => item.id === recipientId); return found ? found.claimed_name ?? found.name : null; };
      // Parties see who did what and when, but not other parties' addresses, IPs or devices.
      const events = (await client.query('SELECT sequence,type,at,hash,data FROM events WHERE document_id=$1 ORDER BY sequence', [row.id])).rows.map(event => ({
        documentId: row.id, sequence: event.sequence, type: event.type, at: event.at, hash: event.hash,
        actor: event.type === 'document.created' ? event.data.sender?.name ?? null : actor(event.data.recipientId),
      }));
      result.push({ ...await documentDto(client, row, true), partyRecipientId: party?.id ?? null, events });
    }
    return result;
  }
  const pdfResponse = (res: Response, bytes: Uint8Array, documentId: string, download = false) => res.type('application/pdf').set('Content-Disposition', (download ? 'attachment' : 'inline') + '; filename="signhere-' + documentId + '.pdf"').send(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));

  const notifier = config.notifier ?? createNotifier();
  const signature = ['', 'Länken är personlig. Vidarebefordra den inte.', '', '– signhere'];
  function invitationMessage(to: string, name: string, url: string, title: string, senderName: string, attachmentOf?: AttachmentOf): Message {
    return attachmentOf ? { to, subject: attachmentLabel(attachmentOf) + ' väntar på din signatur', text: [
      'Hej ' + name + ',', '', senderName + ' har lagt till en bilaga till "' + attachmentOf.title + '": "' + title + '".',
      'Bilagan är en del av avtalet och signeras av parterna precis som huvuddokumentet.', '',
      'Läs och signera bilagan här:', url, '', 'Via länken ser du också huvuddokumentet, alla bilagor och händelseloggen.', ...signature].join('\n') }
      : { to, subject: title + ' väntar på din signatur', text: ['Hej ' + name + ',', '', senderName + ' har skickat "' + title + '" till dig för signering.', '', 'Läs och signera här:', url, ...signature].join('\n') };
  }
  /**
   * Best effort after completion: each signer gets a fresh receipt link, the sender gets the document page.
   * With a mailer the durable completed-copy e-mail carries these links instead, so each address gets one message.
   */
  async function notifyCompleted(documentId: string) {
    if (!notifier.enabled || mailer) return;
    const row = (await pool.query('SELECT ' + docColumns + ' FROM documents WHERE id=$1', [documentId])).rows[0];
    if (row?.status !== 'completed') return;
    const created = (await pool.query('SELECT data FROM events WHERE document_id=$1 AND sequence=1', [row.id])).rows[0]?.data ?? {};
    const label = created.attachmentOf ? attachmentLabel(created.attachmentOf) + ': "' + row.title + '"' : '"' + row.title + '"';
    const signers = (await pool.query('SELECT id,name,email FROM recipients WHERE document_id=$1 AND signed_at IS NOT NULL ORDER BY position', [row.id])).rows;
    const messages: Message[] = [];
    for (const signer of signers) {
      if (signer.id === created.senderRecipientId) continue;
      const raw = token();
      await pool.query('INSERT INTO completed_copy_access(token_hash,document_id,recipient_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [sha256(raw), row.id, signer.id, now() + 30 * DAY, at()]);
      messages.push({ to: signer.email, subject: 'Signerat av alla parter: ' + (created.attachmentOf ? attachmentLabel(created.attachmentOf) : row.title), text: [
        'Hej ' + signer.name + ',', '', label + ' är nu signerat av alla parter.', '',
        'Hämta den signerade PDF-filen' + (row.parent_id ? ', huvuddokumentet och övriga bilagor' : '') + ' och se händelseloggen här:', origin + '/copy#' + raw, ...signature].join('\n') });
    }
    const owner = (await pool.query('SELECT name,email FROM users WHERE id=$1', [row.created_by])).rows[0];
    if (owner) messages.push({ to: owner.email, subject: 'Signerat av alla parter: ' + (created.attachmentOf ? attachmentLabel(created.attachmentOf) : row.title), text: ['Hej ' + owner.name + ',', '', label + ' är nu signerat av alla parter.', '', origin + '/documents/' + row.id, '', '– signhere'].join('\n') });
    await notifier.send(messages);
  }
  const afterCompletion = (documentId: string) => { void notifyCompleted(documentId).catch(() => console.error('signhere: completion notification failed')); };

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('SELECT 1'); const status = await keys?.cachedRefresh(); res.json({ ok: true, sealing: { ready: Boolean(status?.ready) } }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.get('/api/ready', async (_req, res) => {
    try { await pool.query('SELECT 1'); const sealing = await keys?.cachedRefresh(); const ready = Boolean(sealing?.ready && sealing.fingerprintSha256 && sealing.certificatePem && await pdfReady({fingerprintSha256: sealing.fingerprintSha256, certificatePem: sealing.certificatePem, chainPem: sealing.chainPem})); res.status(ready ? 200 : 503).json({ ready }); }
    catch { res.status(503).json({ ready: false }); }
  });
  app.get('/.well-known/signhere-sealing.json', async (_req, res) => {
    const status = await keys?.cachedRefresh();
    res.set('Cache-Control', 'no-store').json({ ready: Boolean(status?.ready), installationId: status?.installationId, fingerprintSha256: status?.fingerprintSha256, certificatePem: status?.certificatePem, profile: 'signhere-seal-v1', trustAnchor: false });
  });
  app.get('/api/bootstrap', async (req, res) => {
    const user = await currentUser(req);
    res.json({ setupRequired: await setupRequired(), user: user ? toUser(user) : null, methods: listMethods(), delivery: { email: Boolean(mailer) },
      ...(config.central && user ? { central: { service: config.central.settings.url, independentApproval: true } } : {}) });
  });
  app.post('/api/setup', async (req, res) => {
    const input = z.object({ setupToken: z.string().min(1).max(256), name: nameSchema, email: emailSchema, password: passwordSchema, teamName: nameSchema }).strict().parse(req.body);
    if (!setupHash || !await setupRequired()) throw new ApiError(409, 'Plattformen är redan konfigurerad.');
    if (!equalSecret(input.setupToken, setupHash)) throw new ApiError(403, 'Fel installationsnyckel.');
    const password = await hashPassword(input.password);
    const result = await transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('signhere-owner-bootstrap'))");
      if ((await client.query('SELECT EXISTS(SELECT 1 FROM users) AS exists')).rows[0].exists) throw new ApiError(409, 'Plattformen är redan konfigurerad.');
      const teamId = uid(), userId = uid();
      await client.query('INSERT INTO teams(id,name) VALUES($1,$2)', [teamId, input.teamName]);
      const user = (await client.query("INSERT INTO users(id,team_id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,'owner',$6) RETURNING *", [userId, teamId, input.name, input.email, password, at()])).rows[0];
      return { user: toUser({ ...user, team_name: input.teamName }), session: await newSession(client, userId) };
    });
    setupHash = undefined;
    await unlink(setupPath).catch(() => {});
    res.cookie('signhere_session', result.session, cookieOptions).status(201).json({ user: result.user });
  });
  app.post('/api/login', async (req, res) => {
    const input = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict().parse(req.body);
    const user = (await pool.query('SELECT u.*,t.name AS team_name FROM users u JOIN teams t ON t.id=u.team_id WHERE email=$1', [input.email])).rows[0];
    if (!await verifyPassword(input.password, user?.password_hash)) throw new ApiError(401, 'Fel e-postadress eller lösenord.');
    const session = await transaction(pool, client => newSession(client, user.id));
    res.cookie('signhere_session', session, cookieOptions).json({ user: toUser(user) });
  });
  app.post('/api/logout', async (req, res) => {
    const value = sessionToken(req);
    if (value) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(value)]);
    res.clearCookie('signhere_session', { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });


  app.get('/api/documents', requireUser, async (_req, res) => {
    // Bilagor are listed on their main document, not as separate documents.
    const rows = (await pool.query('SELECT ' + docColumns + ' FROM documents WHERE team_id=$1 AND parent_id IS NULL ORDER BY created_at DESC LIMIT 200', [res.locals.user.team_id])).rows;
    const counts = (await pool.query("SELECT parent_id,count(*) AS total,count(*) FILTER (WHERE status IN ('pending','finalizing')) AS open FROM documents WHERE parent_id=ANY($1::uuid[]) GROUP BY parent_id", [rows.map(row => row.id)])).rows;
    res.json({ documents: await Promise.all(rows.map(async row => {
      const count = counts.find(item => item.parent_id === row.id);
      return { ...await documentDto(pool, row, false, true), attachmentCount: Number(count?.total ?? 0), openAttachmentCount: Number(count?.open ?? 0) };
    })) });
  });
  const pdfBase64Schema = z.string().min(12).max(Math.ceil(MAX_PDF_BYTES / 3) * 4);
  function decodeUpload(value: string) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new ApiError(400, 'PDF-filen har ett ogiltigt format.');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new ApiError(400, 'PDF-filen har ett ogiltigt format.');
    return bytes;
  }
  async function prepareUpload(bytes: Buffer) {
    try { return await preparePdf(bytes); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'PDF-filen kunde inte förberedas.'); }
  }
  app.post('/api/documents/prepare', requireUser, async (req, res) => {
    const input = z.object({ pdfBase64: pdfBase64Schema }).strict().parse(req.body);
    const prepared = await prepareUpload(decodeUpload(input.pdfBase64));
    res.json({ pdfBase64: prepared.bytes.toString('base64'), hash: prepared.hash, pages: prepared.pages, size: prepared.bytes.length, preparation: prepared.preparation });
  });
  const fileNameSchema = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f/\\]/.test(value) && /\.pdf$/i.test(value), 'Filnamnet måste sluta på .pdf.');
  const partySchema = z.object({ name: nameSchema, email: emailSchema }).strict();
  type Party = { name: string; email: string; parentRecipientId: string | null };
  type AttachmentOf = { documentId: string; title: string; completedHash: string; number: number };
  const attachmentLabel = (attachment: AttachmentOf) => 'Bilaga ' + attachment.number + ' till ' + attachment.title;
  /** Shared by main documents and bilagor. The sender assignment, when present, is always the last party. */
  /** Frozen at creation. Without the central option, documents keep exactly the local policy. */
  function protectionPolicy(independentApproval: boolean) {
    if (!independentApproval) return LOCAL_SEAL_POLICY;
    if (!config.central) throw new ApiError(400, 'Oberoende bekräftelse är inte aktiverad på den här installationen.');
    return { ...LOCAL_SEAL_POLICY, independentApproval: { mode: 'email', service: config.central.settings.url, trustRoot: config.central.settings.trustRoot } };
  }
  async function createSigningDocument(req: Request, res: Response, input: { title: string; fileName: string; pdfBase64: string; methodId: 'draw'; independentApproval: boolean }, parties: Party[], sender: Party | null, parent?: Row) {
    const policy = config.legacyCreation ? null : protectionPolicy(input.independentApproval);
    const recipients = [...parties, ...(sender ? [sender] : [])];
    if (new Set(parties.map(recipient => recipient.email)).size !== parties.length) throw new ApiError(400, 'Varje mottagare behöver en unik e-postadress.');
    if (!recipients.length) throw new ApiError(400, 'Lägg till en mottagare eller välj att signera själv.');
    if (recipients.length > 25) throw new ApiError(400, 'Dokumentet får ha högst 25 mottagare, inklusive dig själv.');
    const creationIdentity = await keys?.refresh();
    if (!config.legacyCreation && (!creationIdentity?.ready || !z.uuid().safeParse(creationIdentity.installationId).success)) throw new ApiError(503, 'Förseglingen behöver åtgärdas av administratören innan nya dokument kan skickas.');
    if (creationIdentity?.ready && !await pdfReady({fingerprintSha256: creationIdentity.fingerprintSha256!, certificatePem: creationIdentity.certificatePem!, chainPem: creationIdentity.chainPem})) throw new ApiError(503, 'PDF-tjänsten är tillfälligt otillgänglig. Försök igen senare.');
    const uploaded = decodeUpload(input.pdfBase64);
    const parsed = await prepareUpload(uploaded);
    // Preparation belongs to document creation, not to a separate user approval.
    // The server owns these bytes; recipient signatures bind to this frozen copy.
    const bytes = parsed.bytes;
    const method = getSigningMethod(input.methodId)!;
    const documentId = uid();
    if (!config.legacyCreation) {
      // Validate the final PDF pipeline before anyone is invited or approves.
      // Only the public certificate is available to this dry run.
      const identity = creationIdentity!;
      try {
        const candidate = await finalizePdf(bytes, input.title, documentId, parsed.hash, CONSENT,
          recipients.map(recipient => ({ name: recipient.name, email: recipient.email, signedAt: at(), strokes: [[[0, 0], [1, 1]]], methodId: method.id, methodVersion: method.version })),
          { sequence: 1000, hash: '0'.repeat(64) }, true, parent ? { documentId: parent.id, title: parent.title, completedHash: parent.completed_hash, number: MAX_ATTACHMENTS } : undefined);
        await preflightSealPdf(candidate, { fingerprintSha256: identity.fingerprintSha256!, certificatePem: identity.certificatePem!, chainPem: identity.chainPem });
      } catch (error) {
        if (error instanceof SealInputError) throw new ApiError(400, 'PDF-filen kunde inte förberedas för försegling. Exportera en ny PDF och försök igen.');
        console.error('signhere: pdf_preflight_unavailable');
        throw new ApiError(503, 'PDF-tjänsten är tillfälligt otillgänglig. Försök igen senare.');
      }
    }
    const result = await transaction(pool, async client => {
      let attachmentOf: AttachmentOf | undefined;
      if (parent) {
        // The lock serializes numbering. A completed main document is never modified.
        const main = await ownedDocument(client, parent.id, res.locals.user.team_id, true);
        if (main.status !== 'completed' || main.parent_id) throw new ApiError(409, 'Bilagor kan bara läggas till ett färdigsignerat huvuddokument.');
        const count = Number((await client.query('SELECT count(*) AS count FROM documents WHERE parent_id=$1', [main.id])).rows[0].count);
        if (count >= MAX_ATTACHMENTS) throw new ApiError(409, 'Dokumentet har redan det högsta antalet bilagor.');
        attachmentOf = { documentId: main.id, title: main.title, completedHash: main.completed_hash, number: count + 1 };
      }
      const senderSnapshot = { name: res.locals.user.name, email: res.locals.user.email, teamName: res.locals.user.team_name };
      const createdAt = at();
      const row = (await client.query("INSERT INTO documents(id,team_id,created_by,title,file_name,original,original_hash,size,pages,status,sender,method_id,method_version,created_at,uploaded,preparation,evidence_version,protection_policy,parent_id,attachment_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING " + docColumns,
        [documentId, res.locals.user.team_id, res.locals.user.id, input.title, input.fileName, bytes, parsed.hash, bytes.length, parsed.pages, senderSnapshot, method.id, method.version, createdAt, parsed.preparation ? uploaded : null, parsed.preparation, config.legacyCreation ? 1 : 2, policy, attachmentOf?.documentId ?? null, attachmentOf?.number ?? null])).rows[0];
      const links: Row[] = [];
      for (const [position, recipient] of recipients.entries()) {
        const recipientId = uid(), raw = token();
        await client.query('INSERT INTO recipients(id,document_id,position,name,email,method_id,method_version,token_hash,expires_at,signing_intent,parent_recipient_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [recipientId, documentId, position, recipient.name, recipient.email, method.id, method.version, sha256(raw), now() + linkTtlDays * DAY, config.legacyCreation ? null : signingIntent(creationIdentity!.installationId, row, { id: recipientId, method_id: method.id, method_version: method.version }, attachmentOf), recipient.parentRecipientId]);
        links.push({ recipientId, name: recipient.name, url: origin + '/sign#' + raw });
      }
      const senderRecipientId = sender ? links[links.length - 1].recipientId : null;
      await appendEvent(client, documentId, 'document.created', createdAt, { senderRecipientId, ...(row.evidence_version === 2 ? { evidenceVersion: 2, installationId: creationIdentity!.installationId, protectionPolicy: policy } : {}), ...(attachmentOf ? { attachmentOf } : {}), originalHash: parsed.hash, ...(parsed.preparation ? { preparation: parsed.preparation } : {}), fileName: input.fileName, pages: parsed.pages, size: bytes.length, title: input.title, sender: senderSnapshot, recipients: recipients.map((recipient, position) => ({ id: links[position].recipientId, position, name: recipient.name, email: recipient.email, ...(recipient.parentRecipientId ? { parentRecipientId: recipient.parentRecipientId } : {}) })), recipientIds: links.map(link => link.recipientId), method: { id: method.id, version: method.version }, actorId: res.locals.user.id, ...requestEvidence(req) });
      return { document: await documentDto(client, row), links, senderRecipientId, attachmentOf };
    });
    const { attachmentOf, ...response } = result;
    // Sent after commit. The sender signs in the app and is not e-mailed a link.
    void notifier.send(response.links.flatMap((link: Row, position: number) => link.recipientId === response.senderRecipientId ? [] : [invitationMessage(recipients[position].email, link.name, link.url, input.title, res.locals.user.name, attachmentOf)]));
    return { ...response, notified: notifier.enabled };
  }
  app.post('/api/documents', requireUser, async (req, res) => {
    const input = z.object({
      title: nameSchema,
      fileName: fileNameSchema,
      pdfBase64: pdfBase64Schema,
      // Accepted for older clients; a sender preview is optional.
      preparedHash: hashSchema.optional(),
      recipients: z.array(partySchema).max(25),
      includeSender: z.boolean().default(false),
      methodId: z.literal('draw'),
      /** Require email-confirmed approval through the configured central service (only offered when configured). */
      independentApproval: z.boolean().default(false),
    }).strict().parse(req.body);
    const sender = input.includeSender ? { name: res.locals.user.name, email: res.locals.user.email, parentRecipientId: null } : null;
    res.status(201).json(await createSigningDocument(req, res, input, input.recipients.map(recipient => ({ ...recipient, parentRecipientId: null })), sender));
  });
  app.post('/api/documents/:id/attachments', requireUser, async (req, res) => {
    const input = z.object({
      title: nameSchema, fileName: fileNameSchema, pdfBase64: pdfBase64Schema,
      // Parties of the main document who sign this bilaga too. By default the client selects all of them.
      parentRecipientIds: z.array(z.uuid()).max(25),
      recipients: z.array(partySchema).max(25),
      includeSender: z.boolean().default(false),
      methodId: z.literal('draw'),
      /** Require email-confirmed approval through the configured central service (only offered when configured). */
      independentApproval: z.boolean().default(false),
    }).strict().parse(req.body);
    if (new Set(input.parentRecipientIds).size !== input.parentRecipientIds.length) throw new ApiError(400, 'Varje part kan bara väljas en gång.');
    const parent = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    if (parent.parent_id) throw new ApiError(409, 'En bilaga kan inte ha egna bilagor. Lägg till bilagan på huvuddokumentet.');
    if (parent.status !== 'completed') throw new ApiError(409, 'Bilagor kan bara läggas till ett färdigsignerat huvuddokument.');
    const mainRecipients = (await pool.query('SELECT id,name,email FROM recipients WHERE document_id=$1 ORDER BY position', [parent.id])).rows;
    const mainSenderRecipientId = (await documentDto(pool, parent, false, true)).senderRecipientId;
    const parties: Party[] = [];
    let sender: Party | null = null;
    for (const recipientId of input.parentRecipientIds) {
      const recipient = mainRecipients.find(item => item.id === recipientId);
      if (!recipient) throw new ApiError(400, 'En vald part finns inte i huvuddokumentet.');
      // The main document's own signing sender keeps the sender assignment when they add the bilaga.
      if (recipientId === mainSenderRecipientId && parent.created_by === res.locals.user.id) sender = { name: res.locals.user.name, email: res.locals.user.email, parentRecipientId: recipientId };
      else parties.push({ name: recipient.name, email: recipient.email, parentRecipientId: recipient.id });
    }
    parties.push(...input.recipients.map(recipient => ({ ...recipient, parentRecipientId: null })));
    if (input.includeSender && !sender) sender = { name: res.locals.user.name, email: res.locals.user.email, parentRecipientId: null };
    res.status(201).json(await createSigningDocument(req, res, input, parties, sender, parent));
  });
  app.get('/api/documents/:id', requireUser, async (req, res) => {
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    const attachments = row.parent_id ? [] : (await pool.query('SELECT ' + docColumns + ' FROM documents WHERE parent_id=$1 ORDER BY attachment_number', [row.id])).rows;
    res.json({ document: { ...await documentDto(pool, row, false, false, Boolean(mailer)), ...(row.parent_id ? {} : { attachments: await Promise.all(attachments.map(attachment => documentDto(pool, attachment))) }) } });
  });
  app.get('/api/documents/:id/pdf', requireUser, async (req, res) => withResponse(res, 'download', res.locals.user.id, async () => {
    const version = z.enum(['original', 'completed', 'uploaded']).parse(req.query.version ?? 'original');
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    if (version === 'completed' && row.status !== 'completed') throw new ApiError(409, 'Dokumentet är inte färdigsignerat.');
    const bytes = (await pool.query('SELECT ' + (version === 'completed' ? 'completed' : version === 'uploaded' ? 'COALESCE(uploaded,original)' : 'original') + ' AS bytes FROM documents WHERE id=$1', [row.id])).rows[0].bytes;
    pdfResponse(res, bytes, row.id, true);
  }));
  async function evidenceExport(client: Queryable, row: Row) {
    const { events, ...document } = await documentDto(client, row);
    const core = row.evidence_version === 2 ? (await client.query('SELECT evidence_core FROM documents WHERE id=$1', [row.id])).rows[0].evidence_core : null;
    return {
      schemaVersion: row.evidence_version === 2 ? 2 : 1, document, events, chainHead: events.at(-1)?.hash ?? '0'.repeat(64),
      signingCheckpoint: row.signing_checkpoint ?? null,
      ...(core ? { evidenceCoreBase64: core.toString('base64'), evidenceCoreHash: sha256(core), seal: row.seal_metadata } : {}),
      assurance: { identityVerified: false, qualifiedSignature: false, trustedTimestamp: false, cryptographicPdfSeal: Boolean(row.seal_metadata),
        ...(row.protection_policy?.independentApproval ? { independentApproval: 'email-access-and-approval-at-central-service', civilIdentityVerified: false } : {}) },
      hashAlgorithm: 'SHA-256', canonicalization: 'JSON with recursively sorted object keys, no whitespace; arrays retain order',
    };
  }
  const exportResponse = (res: Response, manifest: Row) => res.type('application/json').set('Content-Disposition', 'attachment; filename="signhere-' + manifest.document.id + '-evidence.json"').send(JSON.stringify(manifest, null, 2));
  const withResponse = createResponseBudget();
  app.get('/api/documents/:id/evidence', requireUser, async (req, res) => withResponse(res, 'export', res.locals.user.id, async () => {
    const manifest = await transaction(pool, async client => evidenceExport(client, await ownedDocument(client, req.params.id, res.locals.user.team_id, true)));
    exportResponse(res, manifest);
  }));
  async function packageResponse(res: Response, row: Row) { return withResponse(res, 'export', res.locals.user.id, async () => {
    if (row.status !== 'completed') throw new ApiError(409, 'Dokumentet är inte färdigsignerat.');
    const artifacts = (await pool.query('SELECT original,completed,uploaded,evidence_core FROM documents WHERE id=$1', [row.id])).rows[0];
    const manifest = await evidenceExport(pool, row);
    const archive = await verificationPackage(manifest, artifacts);
    res.type('application/zip').set('Content-Disposition', 'attachment; filename="signhere-' + row.id + '-verification.zip"').send(archive);
  }); }
  app.get('/api/documents/:id/verification-package', requireUser, async (req, res) => packageResponse(res, await ownedDocument(pool, req.params.id, res.locals.user.team_id)));
  app.post('/api/documents/:id/retry-finalization', requireUser, async (req, res) => {
    owner(res);
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    if (row.status !== 'finalizing') throw new ApiError(409, 'Dokumentet väntar inte på färdigställning.');
    await retryFinalization(pool, row.id);
    res.json({ document: await documentDto(pool, row) });
  });
  app.post('/api/documents/:id/recipients/:recipientId/link', requireUser, async (req, res) => {
    const result = await transaction(pool, async client => {
      const row = await ownedDocument(client, req.params.id, res.locals.user.team_id, true);
      if (row.status !== 'pending') throw new ApiError(409, 'Dokumentet är redan avslutat.');
      const recipient = (await client.query('SELECT * FROM recipients WHERE id=$1 AND document_id=$2', [id(req.params.recipientId), row.id])).rows[0];
      if (!recipient) throw new ApiError(404, 'Mottagaren finns inte.');
      if (recipient.signed_at) throw new ApiError(409, 'Mottagaren har redan signerat.');
      const history = (await client.query('SELECT count(*) AS count FROM events WHERE document_id=$1', [row.id])).rows[0];
      if (Number(history.count) >= 1000) throw new ApiError(409, 'Dokumentet har för många länkbyten. Skapa en ny signering.');
      const raw = token();
      await client.query('UPDATE recipients SET token_hash=$1,expires_at=$2 WHERE id=$3', [sha256(raw), now() + linkTtlDays * DAY, recipient.id]);
      await appendEvent(client, row.id, 'link.rotated', at(), { recipientId: recipient.id, actorId: res.locals.user.id, ...requestEvidence(req) });
      return { url: origin + '/sign#' + raw };
    });
    res.json(result);
  });
  app.post('/api/documents/:id/cancel', requireUser, async (req, res) => {
    const document = await transaction(pool, async client => {
      const row = await ownedDocument(client, req.params.id, res.locals.user.team_id, true);
      if (row.status !== 'pending') throw new ApiError(409, 'Dokumentet är redan avslutat.');
      await appendEvent(client, row.id, 'document.cancelled', at(), { actorId: res.locals.user.id, ...requestEvidence(req) });
      const updated = (await client.query("UPDATE documents SET status='cancelled' WHERE id=$1 RETURNING " + docColumns, [row.id])).rows[0];
      return documentDto(client, updated);
    });
    void independent.cancel(document.id).catch(() => console.error('signhere: independent approval cancel failed'));
    res.json({ document });
  });
  app.get('/api/team', requireUser, async (_req, res) => {
    const teamId = res.locals.user.team_id;
    const members = (await pool.query('SELECT id,name,email,role FROM users WHERE team_id=$1 ORDER BY created_at', [teamId])).rows;
    const invitations = res.locals.user.role === 'owner' ? (await pool.query('SELECT id,email,expires_at FROM invitations WHERE team_id=$1 AND accepted_at IS NULL AND expires_at>$2 ORDER BY created_at DESC', [teamId, now()])).rows.map(row => ({ id: row.id, email: row.email, expiresAt: new Date(Number(row.expires_at)).toISOString() })) : [];
    res.json({ name: res.locals.user.team_name, members, invitations });
  });
  app.patch('/api/team', requireUser, async (req, res) => {
    owner(res);
    const { name } = z.object({ name: nameSchema }).strict().parse(req.body);
    await pool.query('UPDATE teams SET name=$1 WHERE id=$2', [name, res.locals.user.team_id]);
    res.json({ name });
  });
  app.post('/api/team/invitations', requireUser, async (req, res) => {
    owner(res);
    const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
    const raw = token();
    await transaction(pool, async client => {
      await client.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE', [res.locals.user.team_id]);
      if ((await client.query('SELECT 1 FROM users WHERE email=$1', [email])).rowCount) throw new ApiError(409, 'E-postadressen är redan registrerad.');
      await client.query('UPDATE invitations SET expires_at=$1 WHERE team_id=$2 AND email=$3 AND accepted_at IS NULL', [now(), res.locals.user.team_id, email]);
      await client.query('INSERT INTO invitations(id,team_id,email,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)', [uid(), res.locals.user.team_id, email, sha256(raw), now() + 3 * DAY, at()]);
    });
    res.status(201).json({ url: origin + '/join#' + raw });
  });
  app.post('/api/invitations/accept', async (req, res) => {
    const input = z.object({ token: tokenSchema, name: nameSchema, password: passwordSchema }).strict().parse(req.body);
    const available = (await pool.query('SELECT id FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>$2', [sha256(input.token), now()])).rowCount;
    if (!available) throw new ApiError(404, 'Inbjudan är ogiltig eller har upphört att gälla.');
    const password = await hashPassword(input.password);
    const result = await transaction(pool, async client => {
      const invitation = (await client.query('SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE', [sha256(input.token)])).rows[0];
      if (!invitation || invitation.accepted_at || Number(invitation.expires_at) <= now()) throw new ApiError(404, 'Inbjudan är ogiltig eller har upphört att gälla.');
      if ((await client.query('SELECT 1 FROM users WHERE email=$1', [invitation.email])).rowCount) throw new ApiError(409, 'E-postadressen är redan registrerad.');
      const user = (await client.query("INSERT INTO users(id,team_id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,'member',$6) RETURNING *", [uid(), invitation.team_id, input.name, invitation.email, password, at()])).rows[0];
      const team = (await client.query('SELECT name FROM teams WHERE id=$1', [invitation.team_id])).rows[0];
      await client.query('UPDATE invitations SET accepted_at=$1 WHERE id=$2', [at(), invitation.id]);
      return { user: toUser({ ...user, team_name: team.name }), session: await newSession(client, user.id) };
    });
    res.cookie('signhere_session', result.session, cookieOptions).status(201).json({ user: result.user });
  });
  app.post('/api/verify', async (req, res) => {
    const { sha256: digest } = z.object({ sha256: hashSchema }).strict().parse(req.body);
    const match = !!(await pool.query("SELECT 1 FROM documents WHERE completed_hash=$1 AND status='completed' LIMIT 1", [digest])).rowCount;
    res.json(match ? { match: true, status: 'completed', version: 'completed' } : { match: false });
  });


  const partyInput = z.object({ token: tokenSchema, documentId: z.uuid().optional() }).strict();
  app.post('/api/sign/session', async (req, res) => {
    const { token: raw, documentId } = partyInput.parse(req.body);
    const result = await transaction(pool, async client => {
      const { document, recipient } = await partyTarget(client, raw, documentId, true);
      const method = getSigningMethod(recipient.method_id);
      if (!method || method.version !== recipient.method_version) throw new ApiError(409, 'Signeringsmetoden är inte tillgänglig.');
      if (document.status === 'pending' && !recipient.viewed_at && !recipient.signed_at) {
        const viewedAt = at();
        await client.query('UPDATE recipients SET viewed_at=$1 WHERE id=$2', [viewedAt, recipient.id]);
        await appendEvent(client, document.id, 'recipient.viewed', viewedAt, { recipientId: recipient.id, originalHash: document.original_hash, ...requestEvidence(req) });
      }
      const consent = consentFor(recipient);
      await method.begin({ documentId: document.id, documentHash: document.original_hash, recipientId: recipient.id, name: recipient.name, consent });
      return { document: await documentDto(client, document, true), recipientId: recipient.id, ...(recipient.signing_intent ? { signingIntentHash: sha256(recipient.signing_intent) } : {}), consent, method: { id: method.id, label: method.label, version: method.version }, emailCopy: Boolean(mailer),
        ...(approvalRequired(document, recipient) ? { independentApproval: { required: true, service: policyOf(document)!.service } } : {}) };
    });
    res.json(result);
  });
  /** Starts or polls the participant's independent approval; accepts only a verified matching receipt. */
  app.post('/api/sign/independent-approval', async (req, res) => {
    const { token: raw, documentId } = partyInput.parse(req.body);
    const { document, recipient } = await partyTarget(pool, raw, documentId);
    res.json(await independent.refresh(document, recipient));
  });
  // The participant's browser on the central service page fetches the prepared PDF directly.
  // Read-only, short-lived transfer token; the central server itself never receives the bytes.
  const preparedCors = (req: Request, res: Response, allowed?: string) => {
    const requestOrigin = req.get('origin');
    if (requestOrigin && allowed && requestOrigin === allowed) res.set({ 'Access-Control-Allow-Origin': requestOrigin, 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
    res.set({ Vary: 'Origin', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  };
  app.options('/api/central/prepared/:id', (req, res) => { preparedCors(req, res, config.central?.settings.url); res.status(204).end(); });
  app.get('/api/central/prepared/:id', async (req, res) => {
    const transfer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') ?? '')?.[1];
    const found = transfer && z.uuid().safeParse(req.params.id).success ? await independent.preparedPdf(req.params.id, transfer) : undefined;
    preparedCors(req, res, found?.service);
    if (!found) throw new ApiError(404, 'Dokumentet finns inte eller länken har gått ut.');
    res.type('application/pdf').set('Content-Disposition', 'inline').send(found.original);
  });
  app.post('/api/sign/pdf', async (req, res) => {
    const { token: raw, documentId } = partyInput.parse(req.body);
    const { document, recipient } = await partyTarget(pool, raw, documentId);
    await withResponse(res, 'view', recipient.id, async () => {
      const row = (await pool.query('SELECT original FROM documents WHERE id=$1', [document.id])).rows[0];
      pdfResponse(res, row.original, document.id);
    });
  });
  app.post('/api/sign/complete', async (req, res) => {
    const input = z.object({
      token: tokenSchema, documentId: z.uuid().optional(), documentHash: hashSchema, consentVersion: z.string().min(1).max(128),
      accepted: z.literal(true), name: nameSchema, payload: z.unknown(), signingIntentHash: hashSchema.optional(),
    }).strict().parse(req.body);
    const result = await transaction(pool, async client => {
      // PostgreSQL owns the per-document lock, including across processes. The
      // reserved client keeps all signature events/artifacts in one transaction.
      // Cancellation and token rotation acquire the same lock.
      const { document, recipient, via } = await partyTarget(client, input.token, input.documentId, true) as { document: Row; recipient: Row; via?: Row };
      const consent = consentFor(recipient);
      if (input.consentVersion !== consent.version) throw new ApiError(400, 'Samtycket stämmer inte. Öppna dokumentet igen.');
      if (document.evidence_version === 2 && (!recipient.signing_intent || input.signingIntentHash !== sha256(recipient.signing_intent))) throw new ApiError(409, 'Öppna dokumentet igen för att bekräfta den aktuella signeringen.');
      if (input.documentHash !== document.original_hash) throw new ApiError(409, 'Dokumentets kontrollsumma stämmer inte. Öppna dokumentet igen.');
      const method = getSigningMethod(recipient.method_id);
      if (!method || method.version !== recipient.method_version) throw new ApiError(409, 'Signeringsmetoden är inte tillgänglig.');
      const verified = await method.complete({ documentId: document.id, documentHash: document.original_hash, recipientId: recipient.id, name: input.name, consent }, input.payload);
      if (verified.status !== 'completed') throw new ApiError(409, 'Signeringen är inte slutförd.');
      if (method.id === 'draw' && !verified.visualSignature) throw new ApiError(400, 'Underskriften saknas.');
      const providerEvidence = z.record(z.string(), z.json()).parse(verified.providerEvidence);
      if (Buffer.byteLength(JSON.stringify(providerEvidence)) > 16384) throw new ApiError(400, 'Signeringsbeviset är för stort.');
      const submissionHash = sha256(canonical({ documentHash: input.documentHash, ...(recipient.signing_intent ? { signingIntentHash: input.signingIntentHash } : {}), consent, name: input.name, method: { id: method.id, version: method.version }, visualSignature: verified.visualSignature ?? null, providerEvidence }));
      if (recipient.signed_at) {
        if (recipient.submission_hash !== submissionHash) throw new ApiError(409, 'Mottagaren har redan signerat med en annan underskrift.');
        return { document: await documentDto(client, document, true), recipientId: recipient.id };
      }
      if (document.status !== 'pending') throw new ApiError(409, 'Dokumentet är redan avslutat.');
      const approval = await independent.requireVerified(client, document, recipient);
      if (approval === undefined) throw new ApiError(409, 'Bekräfta först dokumentet via ' + new URL(policyOf(document)!.service).host + '.');
      const signedAt = at();
      const evidence = {
        recipientId: recipient.id, assignedName: recipient.name, email: recipient.email, claimedName: input.name, originalHash: document.original_hash,
        ...(document.evidence_version === 2 ? { documentId: document.id, transactionId: document.id, authenticationMethod: 'personal_signing_link', consentAcceptedAt: signedAt, signedAt } : {}),
        consent, method: { id: method.id, version: method.version }, signature: verified.visualSignature ?? null,
        providerEvidence, ...(recipient.signing_intent ? { intent: intentEvidence(recipient.signing_intent) } : {}), ...requestEvidence(req),
        // Signed through the same party's link to the main document or another bilaga.
        ...(via ? { accessRecipientId: via.id, accessDocumentId: via.document_id } : {}),
        ...(approval ? { independentApproval: { service: approval.service, instanceId: approval.instance_id, approvalId: approval.approval_id, receiptSha256: approval.receipt_sha256 } } : {}),
      };
      await client.query('UPDATE recipients SET signed_at=$1,claimed_name=$2,signature=$3,evidence=$4,submission_hash=$5,expires_at=$6 WHERE id=$7', [signedAt, input.name, verified.visualSignature ?? null, evidence, submissionHash, now() + 30 * DAY, recipient.id]);
      const checkpoint = await appendEvent(client, document.id, 'recipient.signed', signedAt, evidence);
      const signers = (await client.query('SELECT * FROM recipients WHERE document_id=$1 ORDER BY position', [document.id])).rows;
      let finalDocument = document;
      if (signers.every(signer => !!signer.signed_at) && document.evidence_version === 2) {
        const events = (await client.query('SELECT * FROM events WHERE document_id=$1 ORDER BY sequence', [document.id])).rows;
        const core = freezeEvidenceCore(events[0].data.installationId, document, signers, events, checkpoint, await independent.approvalsFor(client, document.id));
        finalDocument = await enqueueFinalization(client, { documentId: document.id, checkpoint, evidenceCore: core });
      } else if (signers.every(signer => !!signer.signed_at)) {
        const original = (await client.query('SELECT original FROM documents WHERE id=$1', [document.id])).rows[0].original;
        let completed: Buffer;
        try {
          completed = await (config.pdfFinalizer ?? finalizePdf)(original, document.title, document.id, document.original_hash, CONSENT,
            signers.map(signer => ({ name: signer.name, signedName: signer.claimed_name, email: signer.email, signedAt: signer.signed_at, strokes: signer.signature?.strokes ?? [], methodId: signer.method_id, methodVersion: signer.method_version })), checkpoint);
        } catch { throw new ApiError(503, 'PDF-filen kunde inte färdigställas. Ingen underskrift sparades. Försök igen.'); }
        const completedHash = sha256(completed);
        const completedAt = at();
        finalDocument = (await client.query("UPDATE documents SET status='completed',completed=$1,completed_hash=$2,completed_at=$3,signing_checkpoint=$4 WHERE id=$5 RETURNING " + docColumns, [completed, completedHash, completedAt, checkpoint, document.id])).rows[0];
        await appendEvent(client, document.id, 'document.completed', completedAt, { originalHash: document.original_hash, completedHash, signingCheckpoint: checkpoint });
        if (mailer) await enqueueCompletedCopies(client, document.id);
      }
      return { document: await documentDto(client, finalDocument, true), recipientId: recipient.id, completedNow: finalDocument.status === 'completed' };
    });
    const { completedNow, ...response } = result as Row;
    if (completedNow) afterCompletion(response.document.id);
    res.json(response);
  });
  app.post('/api/sign/dossier', async (req, res) => {
    const { token: raw } = z.object({ token: tokenSchema }).strict().parse(req.body);
    const { document, recipient } = await partyCredential(pool, raw);
    res.json({ documentId: document.id, documents: await partyDocuments(pool, document, recipient) });
  });
  app.post('/api/sign/download', async (req, res) => {
    const { token: raw, documentId } = partyInput.parse(req.body);
    // Completed-copy links are read-only; they reach the same party's documents as the signing link.
    const own = await partyCredential(pool, raw);
    const { document, recipient } = !documentId || documentId === own.document.id ? own : await relatedTarget(pool, own, documentId);
    if (!recipient.signed_at || document.status !== 'completed') throw new ApiError(409, 'Dokumentet är inte färdigsignerat.');
    await withResponse(res, 'download', recipient.id, async () => {
      const row = (await pool.query('SELECT completed FROM documents WHERE id=$1', [document.id])).rows[0];
      pdfResponse(res, row.completed, document.id, true);
    });
  });

  /** The party's own evidence: prepared PDF, completed PDF when ready, and their own approval receipt. */
  app.post('/api/sign/evidence-package', async (req, res) => {
    const { token: raw, documentId } = partyInput.parse(req.body);
    const own = await partyCredential(pool, raw);
    const { document, recipient } = !documentId || documentId === own.document.id ? own : await relatedTarget(pool, own, documentId);
    const approval = (await independent.approvalsFor(pool, document.id)).find(row => row.recipient_id === recipient.id) ?? null;
    if (!recipient.signed_at && !approval) throw new ApiError(409, 'Det finns inget bevis att hämta ännu.');
    await withResponse(res, 'download', recipient.id, async () => {
      const bytes = (await pool.query('SELECT original,completed FROM documents WHERE id=$1', [document.id])).rows[0];
      const archive = await participantPackage({ documentId: document.id, recipientId: recipient.id, original: bytes.original, completed: document.status === 'completed' ? bytes.completed : null, approval });
      res.type('application/zip').set('Content-Disposition', 'attachment; filename="signhere-' + document.id + '-bevis.zip"').send(archive);
    });
  });
  app.post('/api/documents/:id/recipients/:recipientId/copy-link', requireUser, async (req, res) => {
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    if (row.status !== 'completed') throw new ApiError(409, 'Dokumentet är inte färdigsignerat.');
    const recipient = (await pool.query('SELECT id FROM recipients WHERE id=$1 AND document_id=$2 AND signed_at IS NOT NULL', [id(req.params.recipientId), row.id])).rows[0];
    if (!recipient) throw new ApiError(404, 'Mottagaren finns inte.');
    const raw = token();
    await pool.query('DELETE FROM completed_copy_access WHERE expires_at<=$1', [now()]);
    await pool.query('INSERT INTO completed_copy_access(token_hash,document_id,recipient_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [sha256(raw), row.id, recipient.id, now() + 30 * DAY, at()]);
    res.json({ url: origin + '/copy#' + raw });
  });
  app.post('/api/copy/download', async (req, res) => {
    const { token: raw } = z.object({ token: tokenSchema }).strict().parse(req.body);
    const found = (await pool.query('SELECT document_id,recipient_id FROM completed_copy_access WHERE token_hash=$1 AND expires_at>$2', [sha256(raw), now()])).rows[0];
    if (!found) throw new ApiError(404, 'Länken är ogiltig eller har upphört att gälla.');
    const row = (await pool.query('SELECT ' + docColumns + ' FROM documents WHERE id=$1', [found.document_id])).rows[0];
    await withResponse(res, 'download', found.recipient_id, async () => {
      const pdf = (await pool.query('SELECT completed FROM documents WHERE id=$1', [row.id])).rows[0].completed;
      pdfResponse(res, pdf, row.id, true);
    });
  });
  app.post('/api/documents/:id/deliveries', requireUser, async (req, res) => {
    if (!mailer) throw new ApiError(409, 'E-postutskick är inte konfigurerat på den här installationen.');
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    if (row.status !== 'completed') throw new ApiError(409, 'Dokumentet är inte färdigsignerat.');
    await enqueueCompletedCopies(pool, row.id);
    res.json({ deliveries: await listDeliveries(pool, row.id) });
  });
  app.post('/api/documents/:id/deliveries/:deliveryId/resend', requireUser, async (req, res) => {
    if (!mailer) throw new ApiError(409, 'E-postutskick är inte konfigurerat på den här installationen.');
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    if (!await resendDelivery(pool, row.id, id(req.params.deliveryId))) throw new ApiError(409, 'Utskicket pågår redan eller finns inte.');
    res.json({ deliveries: await listDeliveries(pool, row.id) });
  });
  app.post('/api/documents/:id/recipients/:recipientId/revoke-copy-links', requireUser, async (req, res) => {
    const row = await ownedDocument(pool, req.params.id, res.locals.user.team_id);
    await pool.query('DELETE FROM completed_copy_access WHERE document_id=$1 AND recipient_id=$2', [row.id, id(req.params.recipientId)]);
    res.json({ revoked: true });
  });

  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'API-adressen finns inte.')));
  const webDir = resolve(config.webDir ?? 'dist/web');
  try {
    await access(join(webDir, 'index.html'));
    app.use(express.static(webDir, { index: false, dotfiles: 'deny', maxAge: 0 }));
    app.get('/{*path}', (_req, res) => res.sendFile(join(webDir, 'index.html')));
  } catch { /* The API remains usable while the development frontend runs separately. */ }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof ZodError) { res.status(400).json({ error: error.issues[0]?.message ?? 'Kontrollera uppgifterna.' }); return; }
    if (error instanceof ApiError) { res.status(error.status).json({ error: error.message }); return; }
    if ((error as Row)?.type === 'entity.too.large') { res.status(413).json({ error: 'Filen är för stor. PDF-filen får vara högst 10 MB.' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Ogiltig JSON.' }); return; }
    if ((error as Row)?.code === '23505') { res.status(409).json({ error: 'Uppgifterna är redan registrerade.' }); return; }
    // Deliberately omit request data, SQL, bearer tokens and personal details.
    console.error('signhere: request failed', (error as Row)?.code ?? 'internal');
    res.status(500).json({ error: 'Ett serverfel uppstod. Försök igen.' });
  });
  if (config.finalization?.autoStart !== false && !config.legacyCreation) finalization.start();
  if (delivery && config.delivery?.autoStart !== false) delivery.start();
  return { app, db: pool, pool, finalization, delivery, keys, close: async () => { await finalization.stop(); await delivery?.stop(); await pool.end(); } };
}







