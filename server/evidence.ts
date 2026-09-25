import { randomBytes } from 'node:crypto';
import { canonical, type Row } from './db.js';
import { sha256, type AuditCheckpoint } from './pdf.js';
import { CONSENT } from './plugins.js';

export const LOCAL_SEAL_POLICY = Object.freeze({ profile: 'signhere-seal-v1', timestamp: 'off' as const });
export function signingIntent(installationId: string, document: Row, recipient: Row, attachmentOf?: Row) {
  return Buffer.from(canonical({
    schema: 'signhere-intent-v2', domain: 'signhere/document-approval', installationId,
    documentId: document.id, revisionId: document.id, recipientId: recipient.id,
    // A bilaga approval is bound to the exact completed main document it extends.
    ...(attachmentOf ? { attachmentOf } : {}),
    preparedHash: document.original_hash, method: { id: recipient.method_id, version: recipient.method_version },
    consent: CONSENT, nonce: randomBytes(32).toString('base64url'),
  }), 'utf8');
}
export function intentEvidence(bytes: Buffer) {
  return { sha256: sha256(bytes), bytesBase64: bytes.toString('base64') };
}
export const eventEvidence = (row: Row) => ({ sequence: row.sequence, type: row.type, at: row.at, data: row.data, hash: row.hash, previousHash: row.previous_hash });
/** approvals: verified independent approval rows (central_approvals), empty unless the policy requires them. */
export function freezeEvidenceCore(installationId: string, document: Row, recipients: Row[], events: Row[], checkpoint: AuditCheckpoint, approvals: Row[] = []) {
  if (!recipients.length || recipients.some(recipient => !recipient.signed_at || !recipient.signing_intent)) throw new Error('Incomplete signing evidence.');
  if (events.at(-1)?.hash !== checkpoint.hash || events.at(-1)?.type !== 'recipient.signed') throw new Error('Invalid signing checkpoint.');
  const created = events[0].data;
  const bytes = Buffer.from(canonical({
    schema: 'signhere-evidence-core-v2', installationId, nonce: randomBytes(32).toString('base64url'),
    document: { id: document.id, title: document.title, fileName: document.file_name,
      originalHash: document.original_hash, size: document.size, pages: document.pages,
      createdAt: document.created_at, sender: document.sender, senderRecipientId: created.senderRecipientId ?? null,
      ...(created.attachmentOf ? { attachmentOf: created.attachmentOf } : {}),
      ...(document.preparation ? { preparation: document.preparation } : {}) },
    recipients: recipients.map(recipient => ({ id: recipient.id, position: recipient.position, name: recipient.name, email: recipient.email,
      methodId: recipient.method_id, methodVersion: recipient.method_version, signedAt: recipient.signed_at,
      signedName: recipient.claimed_name,
      intent: intentEvidence(recipient.signing_intent),
      ...independentApprovalEvidence(approvals.find(approval => approval.recipient_id === recipient.id)),
    })),
    events: events.map(eventEvidence), signingCheckpoint: checkpoint,
  }), 'utf8');
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Evidence core exceeds the supported limit.');
  return bytes;
}
/** The exact receipt and the trust bundle it was accepted under, so the frozen record verifies offline. */
function independentApprovalEvidence(approval?: Row) {
  if (!approval) return {};
  return { independentApproval: { service: approval.service, instanceId: approval.instance_id, approvalId: approval.approval_id,
    receiptSha256: approval.receipt_sha256, receipt: approval.receipt, trustBundle: approval.trust_bundle } };
}
