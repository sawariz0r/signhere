/**
 * Independent approval of a participant through a central service (optional).
 *
 * Applies only when a document's frozen protection policy requires it, and only to
 * participants whose signing method does not already verify identity through an
 * independent provider (BankID, Freja, ...). Everything here is inert otherwise.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction, type Row } from './db.js';
import { getSigningMethod } from './plugins.js';
import { CentralRejectedError, CentralUnavailableError, policySha256, type CentralClient } from './central-client.js';
import { ProtocolError } from './central/protocol.js';

const DAY = 86400000;
const TRANSFER_TTL = 2 * 3600000, TRANSFER_RENEW = 30 * 60000;
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface IndependentApprovalPolicy { mode: 'email'; service: string; trustRoot: string }
export const policyOf = (document: Row): IndependentApprovalPolicy | null => document.protection_policy?.independentApproval ?? null;
/** Identity-verifying methods (BankID and similar) already carry provider-signed evidence. */
export function approvalRequired(document: Row, recipient: Row) {
  if (!policyOf(document)) return false;
  return !getSigningMethod(recipient.method_id)?.capabilities.verifiesIdentity;
}
export type ApprovalView =
  | { required: false }
  | { required: true; service: string; status: 'verified'; receiptSha256: string; approvedAt?: string }
  | { required: true; service: string; status: 'pending'; url: string }
  | { required: true; service: string; status: 'unavailable' | 'rejected' | 'expired' | 'cancelled'; reason: string };

export function createIndependentApprovals(pool: Pool, options: { client: CentralClient | null; origin: string; now: () => number }) {
  const at = () => new Date(options.now()).toISOString();
  const host = (service: string) => new URL(service).host;
  /** The frozen policy decides where approval happens. A later configuration change never redirects or skips it. */
  function clientFor(policy: IndependentApprovalPolicy) {
    const client = options.client;
    if (!client || client.settings.url !== policy.service || client.settings.trustRoot !== policy.trustRoot) return null;
    return client;
  }
  async function row(db: Queryable, documentId: string, recipientId: string) {
    return (await db.query('SELECT * FROM central_approvals WHERE document_id=$1 AND recipient_id=$2', [documentId, recipientId])).rows[0] as Row | undefined;
  }
  const verified = (policy: IndependentApprovalPolicy, found: Row): ApprovalView => ({ required: true, service: policy.service, status: 'verified', receiptSha256: found.receipt_sha256, approvedAt: found.verified_at });

  /**
   * Called from the participant's signing page. Ensures the central approval exists,
   * polls it, and accepts a receipt only after verifying it against the frozen context.
   */
  async function refresh(document: Row, recipient: Row): Promise<ApprovalView> {
    const policy = policyOf(document);
    if (!policy || !approvalRequired(document, recipient)) return { required: false };
    const existing = await row(pool, document.id, recipient.id);
    if (existing?.status === 'verified') return verified(policy, existing);
    if (existing?.status === 'cancelled' || document.status === 'cancelled') return closed(policy, 'cancelled');
    if (recipient.signed_at || document.status !== 'pending') return { required: true, service: policy.service, status: 'rejected', reason: 'Dokumentet väntar inte längre på godkännande.' };
    const client = clientFor(policy);
    if (!client) return { required: true, service: policy.service, status: 'unavailable', reason: 'Installationen är inte längre ansluten till ' + host(policy.service) + '. Kontakta avsändaren.' };
    try {
      let local = await ensureRow(document, recipient);
      if (local.status === 'verified') return verified(policy, local);
      if (local.status !== 'pending') return closed(policy, 'cancelled');
      const expected = {
        documentId: document.id, revisionId: document.id, recipientId: recipient.id, email: recipient.email, name: recipient.name, title: document.title,
        preparedSha256: document.original_hash, preparedSize: document.size, intentSha256: sha256(recipient.signing_intent), policySha256: policySha256(document.protection_policy),
      };
      const accept = async (receipt: string, instanceId: string) => {
        const result = await client.verifyApprovalReceipt(receipt, { service: policy.service, instanceId, ...expected });
        await pool.query(`UPDATE central_approvals SET status='verified',receipt=$3,receipt_sha256=$4,trust_bundle=$5,verified_at=$6,transfer_token=NULL,transfer_token_hash=NULL
          WHERE document_id=$1 AND recipient_id=$2 AND status='pending' AND approval_id IS NOT NULL`, [document.id, recipient.id, receipt, result.receiptSha256, result.trustBundle, result.receipt.approval.approvedAt]);
        const stored = await row(pool, document.id, recipient.id);
        return stored?.status === 'verified' ? verified(policy, stored) : closed(policy, 'cancelled');
      };
      // A replaced approval (link rotated, expired) is closed at the service before a new one is made.
      // If the participant had already approved it, that receipt is still theirs and is accepted.
      if (!local.approval_id && local.previous_approval_id) {
        const previous = await client.cancelApproval(local.previous_approval_id);
        if (previous.status === 'approved' && previous.receipt) {
          await pool.query('UPDATE central_approvals SET approval_id=$3,instance_id=$4 WHERE document_id=$1 AND recipient_id=$2 AND status=\'pending\' AND approval_id IS NULL', [document.id, recipient.id, previous.approvalId, previous.instanceId]);
          return accept(previous.receipt, previous.instanceId);
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = local.approval_id ? await client.getApproval(local.approval_id) : await client.createApproval({
          ...expected, participantCapabilitySha256: sha256(local.participant_capability),
          documentUrl: options.origin + '/api/central/prepared/' + document.id, expiresAt: new Date(Number(local.expires_at)).toISOString(),
        });
        if (!local.approval_id) await pool.query('UPDATE central_approvals SET approval_id=$3,instance_id=$4 WHERE document_id=$1 AND recipient_id=$2 AND approval_id IS NULL', [document.id, recipient.id, state.approvalId, state.instanceId]);
        else if (state.approvalId !== local.approval_id || state.instanceId !== local.instance_id) throw new CentralRejectedError('approval_binding');
        if (state.status === 'approved' && state.receipt) return await accept(state.receipt, state.instanceId);
        if ((state.status === 'expired' || state.status === 'cancelled') && attempt === 0) {
          // No receipt was issued: start a fresh approval for the same assignment.
          local = await rebind(document.id, recipient.id);
          continue;
        }
        if (state.status === 'expired' || state.status === 'cancelled') return closed(policy, state.status);
        return { required: true, service: policy.service, status: 'pending', url: policy.service + '/bekrafta#' + state.approvalId + '.' + local.participant_capability + '.' + local.transfer_token };
      }
      return closed(policy, 'expired');
    } catch (error) {
      if (error instanceof CentralRejectedError || error instanceof ProtocolError) {
        console.error('signhere: independent approval rejected', error.code);
        return { required: true, service: policy.service, status: 'rejected', reason: 'Bekräftelsen från ' + host(policy.service) + ' kunde inte godtas (' + error.code + '). Kontakta avsändaren.' };
      }
      if (!(error instanceof CentralUnavailableError)) console.error('signhere: independent approval failed', (error as Row)?.code ?? 'internal');
      return { required: true, service: policy.service, status: 'unavailable', reason: host(policy.service) + ' går inte att nå just nu. Försök igen om en stund.' };
    }
  }
  function closed(policy: IndependentApprovalPolicy, status: 'expired' | 'cancelled'): ApprovalView {
    return { required: true, service: policy.service, status, reason: status === 'expired' ? 'Bekräftelsen har gått ut. Kontakta avsändaren.' : 'Bekräftelsen är avbruten.' };
  }
  const freshTransfer = () => { const raw = randomBytes(32).toString('base64url'); return { raw, hash: sha256(raw), until: options.now() + TRANSFER_TTL }; };
  /** Creates the local row, and keeps one transfer token until it nears expiry so open service pages keep working. */
  async function ensureRow(document: Row, recipient: Row) {
    return transaction(pool, async client => {
      await client.query('SELECT id FROM documents WHERE id=$1 FOR UPDATE', [document.id]);
      const current = await row(client, document.id, recipient.id);
      const transfer = freshTransfer();
      if (!current) {
        return (await client.query(`INSERT INTO central_approvals(document_id,recipient_id,service,participant_capability,transfer_token,transfer_token_hash,transfer_expires_at,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [document.id, recipient.id, policyOf(document)!.service, randomBytes(32).toString('base64url'), transfer.raw, transfer.hash, transfer.until, approvalExpiry(), at()])).rows[0] as Row;
      }
      if (current.status !== 'pending' || (current.transfer_token && Number(current.transfer_expires_at) > options.now() + TRANSFER_RENEW)) return current;
      return (await client.query('UPDATE central_approvals SET transfer_token=$3,transfer_token_hash=$4,transfer_expires_at=$5 WHERE document_id=$1 AND recipient_id=$2 RETURNING *',
        [document.id, recipient.id, transfer.raw, transfer.hash, transfer.until])).rows[0] as Row;
    });
  }
  // Slightly under the service's 30-day maximum, to tolerate clock differences.
  const approvalExpiry = () => options.now() + 29 * DAY;
  /** Replace the service-side approval (new capability and transfer token); the old one is cancelled on next refresh. */
  async function rebind(documentId: string, recipientId: string, client: Queryable = pool) {
    const transfer = freshTransfer();
    return (await client.query(`UPDATE central_approvals SET previous_approval_id=COALESCE(approval_id,previous_approval_id),approval_id=NULL,instance_id=NULL,participant_capability=$3,
      transfer_token=$4,transfer_token_hash=$5,transfer_expires_at=$6,expires_at=$7 WHERE document_id=$1 AND recipient_id=$2 AND status='pending' RETURNING *`,
    [documentId, recipientId, randomBytes(32).toString('base64url'), transfer.raw, transfer.hash, transfer.until, approvalExpiry()])).rows[0] as Row;
  }

  /** Read-only prepared PDF for the participant's browser on the central service page. */
  async function preparedPdf(documentId: string, transferToken: string) {
    const found = (await pool.query(`SELECT a.service,d.original FROM central_approvals a JOIN documents d ON d.id=a.document_id
      WHERE a.document_id=$1 AND a.transfer_token_hash=$2 AND a.transfer_expires_at>$3 AND a.status='pending' AND d.status='pending'`,
    [documentId, sha256(transferToken), options.now()])).rows[0];
    return found as { service: string; original: Buffer } | undefined;
  }

  /** Inside the signing transaction: the verified row that satisfies this participant's requirement. */
  async function requireVerified(client: PoolClient, document: Row, recipient: Row) {
    if (!approvalRequired(document, recipient)) return null;
    const found = await row(client, document.id, recipient.id);
    if (found?.status !== 'verified') return undefined;
    return found;
  }
  async function approvalsFor(db: Queryable, documentId: string) {
    return (await db.query("SELECT * FROM central_approvals WHERE document_id=$1 AND status='verified'", [documentId])).rows as Row[];
  }
  /** Best effort after cancellation; the local row is closed regardless of service availability. */
  async function cancel(documentId: string) {
    const rows = (await pool.query("UPDATE central_approvals SET status='cancelled',transfer_token=NULL,transfer_token_hash=NULL WHERE document_id=$1 AND status='pending' RETURNING *", [documentId])).rows;
    for (const found of rows) {
      if (!found.approval_id) continue;
      const client = clientFor({ mode: 'email', service: found.service, trustRoot: options.client?.settings.trustRoot ?? '' });
      await client?.cancelApproval(found.approval_id).catch(() => console.error('signhere: independent approval cancel failed'));
    }
  }
  /** A rotated signing link must not keep the old service session or PDF transfer alive. */
  async function linkRotated(client: PoolClient, documentId: string, recipientId: string) {
    await rebind(documentId, recipientId, client);
  }
  return { refresh, preparedPdf, requireVerified, approvalsFor, cancel, linkRotated };
}
