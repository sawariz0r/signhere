import type { Pool, PoolClient } from 'pg';
import { transaction, uid, type Row } from './db.js';
import { sha256 } from './pdf.js';
import { token } from './security.js';
import { MailPermanentError, MailTransientError, type Mailer, type MailMessage } from './mail.js';

/** Larger completed PDFs are not attached; the message's link reaches them instead. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DAY = 86400000;

export interface DeliveryOptions {
  origin: string; now?: () => number;
  leaseMs?: number; pollMs?: number; retryBaseMs?: number; retryMaxMs?: number;
}
export type DeliveryResult = { status: 'idle' | 'sent' | 'retry' | 'failed' | 'superseded'; deliveryId?: string };

/**
 * Queue one completed-copy email per distinct address: every signing party plus the sender.
 * Call in the transaction that publishes the completed PDF. Existing rows are left untouched.
 */
export async function enqueueCompletedCopies(client: PoolClient | Pool, documentId: string) {
  const document = (await client.query('SELECT sender FROM documents WHERE id=$1', [documentId])).rows[0];
  const recipients = (await client.query('SELECT id,name,email FROM recipients WHERE document_id=$1 ORDER BY position', [documentId])).rows;
  const addresses = new Map<string, { recipientId: string | null; name: string; email: string }>();
  for (const recipient of recipients) {
    const key = recipient.email.toLowerCase();
    if (!addresses.has(key)) addresses.set(key, { recipientId: recipient.id, name: recipient.name, email: recipient.email });
  }
  if (document?.sender?.email && !addresses.has(document.sender.email.toLowerCase())) addresses.set(document.sender.email.toLowerCase(), { recipientId: null, name: document.sender.name, email: document.sender.email });
  let queued = 0;
  for (const address of addresses.values()) {
    queued += (await client.query(`INSERT INTO email_deliveries(id,document_id,recipient_id,email,name,kind) VALUES($1,$2,$3,$4,$5,'completed_copy')
      ON CONFLICT (document_id,kind,lower(email)) DO NOTHING`, [uid(), documentId, address.recipientId, address.email, address.name])).rowCount ?? 0;
  }
  return queued;
}

export async function listDeliveries(db: Pick<Pool, 'query'>, documentId: string) {
  return (await db.query('SELECT id,recipient_id,email,name,status,attempts,sent_at,last_error_code FROM email_deliveries WHERE document_id=$1 ORDER BY created_at,email', [documentId])).rows
    .map(row => ({ id: row.id, recipientId: row.recipient_id, email: row.email, name: row.name, status: row.status, attempts: row.attempts, sentAt: row.sent_at?.toISOString() ?? null, error: row.last_error_code }));
}

/** Requeue a finished delivery with a fresh idempotency generation. */
export async function resendDelivery(db: Pick<Pool, 'query'>, documentId: string, deliveryId: string) {
  const result = await db.query(`UPDATE email_deliveries SET status='queued',attempts=0,generation=generation+1,available_at=clock_timestamp(),last_error_code=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND document_id=$2 AND status IN ('sent','failed') RETURNING id`, [deliveryId, documentId]);
  return !!result.rowCount;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const attachmentName = (title: string) => (title.replace(/[^\p{L}\p{N} ._-]+/gu, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'dokument') + '_signerat.pdf';

export function completedCopyMessage(input: {
  delivery: Row; document: Row; origin: string; pdf: Buffer;
  /** Personal 30-day copy link for a party, or the document page for the sender. */
  link: string; party: boolean; attachmentOf?: { title: string; number: number } | null;
}): MailMessage {
  const { delivery, document, origin, pdf, link, party, attachmentOf } = input;
  const attach = pdf.length <= MAX_ATTACHMENT_BYTES;
  const sealed = Boolean(document.seal_metadata);
  const label = attachmentOf ? `Bilaga ${attachmentOf.number} till ${attachmentOf.title}` : document.title;
  const lines = [
    `Hej ${delivery.name},`,
    '',
    attachmentOf ? `Alla parter har signerat bilaga ${attachmentOf.number} till ”${attachmentOf.title}”: ”${document.title}”.` : `Alla parter har signerat ”${document.title}”.`,
    attach ? 'Den signerade PDF-filen är bifogad. Spara den som ditt exemplar.' : 'Den signerade PDF-filen är för stor för att bifogas. Hämta den via länken nedan och spara den som ditt exemplar.',
    '',
    sealed ? 'Filen innehåller underskrifterna, en bevissida för varje part och ett elektroniskt sigill som visar om filen har ändrats.' : 'Filen innehåller underskrifterna och en bevissida för varje part.',
    `Kontrollera att din kopia är oförändrad på ${origin}/verify`,
    '',
    party ? `Hämta PDF-filen${document.parent_id ? ', huvuddokumentet och övriga bilagor' : ''} och se händelseloggen här. Länken är personlig och gäller i 30 dagar:\n${link}` : `Dokumentsidan:\n${link}`,
    '',
    `Dokument-ID: ${document.id}`,
    `Skickat av ${document.sender.name}, ${document.sender.teamName}`,
  ];
  const text = lines.join('\n');
  const html = '<!doctype html><html lang="sv"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1d1d1b">'
    + lines.map(line => line ? '<p style="margin:0 0 4px">' + escapeHtml(line).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>') + '</p>' : '<br>').join('')
    + '</body></html>';
  return {
    to: delivery.email, subject: `Signerat: ${label}`, text, html, idempotencyKey: `${delivery.id}.${delivery.generation}`,
    ...(attach ? { attachments: [{ filename: attachmentName(document.title), content: pdf, contentType: 'application/pdf' }] } : {}),
  };
}

export async function claimDelivery(pool: Pool, leaseMs: number) {
  return transaction(pool, async client => {
    await client.query(`UPDATE email_deliveries SET status='failed',lease_until=NULL,last_error_code='attempts_exhausted',updated_at=clock_timestamp()
      WHERE status='sending' AND lease_until<=clock_timestamp() AND attempts>=max_attempts`);
    const result = await client.query(`WITH candidate AS (
        SELECT id FROM email_deliveries
        WHERE attempts<max_attempts AND ((status IN ('queued','retry') AND available_at<=clock_timestamp()) OR (status='sending' AND lease_until<=clock_timestamp()))
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE email_deliveries d SET status='sending',attempts=d.attempts+1,lease_until=clock_timestamp()+($1::integer * interval '1 millisecond'),updated_at=clock_timestamp()
      FROM candidate WHERE d.id=candidate.id RETURNING d.*`, [leaseMs]);
    return result.rows[0] as Row | undefined;
  });
}

export function createDeliveryWorker(pool: Pool, mailer: Mailer, options: DeliveryOptions) {
  const leaseMs = options.leaseMs ?? 120000;
  const now = options.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<DeliveryResult> | undefined;
  let stopping = false, started = false;

  async function processOne(): Promise<DeliveryResult> {
    const delivery = await claimDelivery(pool, leaseMs);
    if (!delivery) return { status: 'idle' };
    // Fence every outcome on the claimed attempt: an expired lease may have been reclaimed.
    const fence = [delivery.id, delivery.attempts, delivery.generation];
    try {
      const document = (await pool.query("SELECT id,title,sender,status,completed,seal_metadata,parent_id FROM documents WHERE id=$1", [delivery.document_id])).rows[0];
      if (document?.status !== 'completed') throw new MailPermanentError('document_not_completed');
      const created = (await pool.query('SELECT data FROM events WHERE document_id=$1 AND sequence=1', [document.id])).rows[0]?.data ?? {};
      // Parties get a personal link to their documents, bilagor and event log; the sender gets the document page.
      const party = Boolean(delivery.recipient_id) && delivery.recipient_id !== created.senderRecipientId;
      let link = options.origin + '/documents/' + document.id;
      if (party) {
        const raw = token();
        await pool.query('INSERT INTO completed_copy_access(token_hash,document_id,recipient_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [sha256(raw), document.id, delivery.recipient_id, now() + 30 * DAY, new Date(now()).toISOString()]);
        link = options.origin + '/copy#' + raw;
      }
      const sent = await mailer.send(completedCopyMessage({ delivery, document, origin: options.origin, pdf: document.completed, link, party, attachmentOf: created.attachmentOf }));
      const updated = await pool.query(`UPDATE email_deliveries SET status='sent',lease_until=NULL,sent_at=clock_timestamp(),provider=$4,provider_message_id=$5,last_error_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND attempts=$2 AND generation=$3 AND status='sending'`, [...fence, mailer.provider, sent.messageId?.slice(0, 256) ?? null]);
      return { status: updated.rowCount ? 'sent' : 'superseded', deliveryId: delivery.id };
    } catch (error) {
      const permanent = error instanceof MailPermanentError || delivery.attempts >= delivery.max_attempts;
      const code = (error instanceof MailPermanentError || error instanceof MailTransientError) && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'delivery_failed';
      if (!(error instanceof MailPermanentError || error instanceof MailTransientError)) console.error('signhere: email delivery failed', (error as Row)?.code ?? 'internal');
      const delay = Math.min(options.retryMaxMs ?? 3600000, (options.retryBaseMs ?? 30000) * 2 ** Math.max(0, delivery.attempts - 1));
      const status = permanent ? 'failed' : 'retry';
      const updated = await pool.query(`UPDATE email_deliveries SET status=$4,lease_until=NULL,last_error_code=$5,available_at=clock_timestamp()+($6::integer * interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE id=$1 AND attempts=$2 AND generation=$3 AND status='sending'`, [...fence, status, code, delay]);
      return { status: updated.rowCount ? status : 'superseded', deliveryId: delivery.id };
    }
  }
  function runOnce(): Promise<DeliveryResult> {
    if (stopping) return Promise.resolve({ status: 'idle' });
    if (!active) active = processOne().finally(() => { active = undefined; });
    return active;
  }
  async function tick() {
    let result: DeliveryResult = { status: 'idle' };
    try { result = await runOnce(); }
    catch { console.error('signhere: email delivery worker unavailable'); }
    if (!stopping) {
      timer = setTimeout(() => { void tick(); }, result.status === 'idle' ? (options.pollMs ?? 2000) : 0);
      timer.unref();
    }
  }
  return {
    runOnce,
    start() { if (started || stopping) return; started = true; void tick(); },
    async stop() { stopping = true; if (timer) clearTimeout(timer); await active; },
  };
}
