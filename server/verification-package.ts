import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { Row } from './db.js';
export async function verificationPackage(manifest: Row, artifacts: Row) {
  const files: Record<string, Uint8Array> = {
    'evidence.json': strToU8(JSON.stringify(manifest)), 'original.pdf': artifacts.original, 'completed.pdf': artifacts.completed,
    'verify-evidence.mjs': await readFile(resolve('scripts/verify-evidence.mjs')),
    'LICENSE': await readFile(resolve('LICENSE')),
  };
  if (artifacts.uploaded) files['uploaded.pdf'] = artifacts.uploaded;
  if (artifacts.evidence_core) {
    files['evidence-core.json'] = artifacts.evidence_core;
    files['certificate.pem'] = strToU8(manifest.seal.certificatePem);
    files['verify-sealed-evidence.mjs'] = await readFile(resolve('scripts/verify-sealed-evidence.mjs'));
    files['pdf-seal/engine.py'] = await readFile(resolve('scripts/pdf-seal/engine.py'));
    files['pdf-seal/requirements.txt'] = await readFile(resolve('scripts/pdf-seal/requirements.txt'));
    files['verify-approval.mjs'] = await readFile(resolve('scripts/verify-approval.mjs'));
    // Independent approval receipts, byte for byte, with the trust bundle each was accepted under.
    const core = JSON.parse(Buffer.from(artifacts.evidence_core).toString('utf8'));
    for (const recipient of core.recipients ?? []) if (recipient.independentApproval) {
      files['approvals/' + recipient.id + '.receipt.jws'] = strToU8(recipient.independentApproval.receipt);
      files['approvals/' + recipient.id + '.trust-bundle.jws'] = strToU8(recipient.independentApproval.trustBundle);
    }
  }
  const approvalPolicy = manifest.document?.independentApproval;
  files['README.txt'] = strToU8(`Signhere portable verification package

Keep these exact files together. original.pdf is the prepared PDF shown to signers; uploaded.pdf, when present, is the original before flattening.

${manifest.schemaVersion === 2 ? `Install Node.js 22+ and Python 3.11+. In an isolated Python environment, install: python -m pip install -r pdf-seal/requirements.txt
Set SIGNHERE_SEAL_PYTHON to that Python executable.
Run: node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf` : 'Install Node.js 22+. Run: node verify-evidence.mjs evidence.json original.pdf completed.pdf'}${artifacts.uploaded ? ' uploaded.pdf' : ''}

${manifest.schemaVersion === 2 ? `Optional: add --trust-fingerprint followed by a SHA-256 certificate fingerprint obtained through an independently trusted channel. The bundled certificate is not its own trust anchor. Exit 0: integrity/evidence pass and explicit fingerprint matches; exit 3: integrity/evidence pass but issuer unknown; exit 1: verification failed. Revocation is not checked.

The private evidence contains participant and request details. Share it only with authorized recipients. The platform seal does not verify drawn-signature identity and has no trusted timestamp. A valid seal does not prevent the installation operator from issuing another seal.` : 'Legacy evidence checks internal consistency only. It is not a cryptographic PDF seal or independent proof of issuer identity.'}

${approvalPolicy ? `Independent approval: participants confirmed their email address and approved the prepared PDF at ${approvalPolicy.service}.
Obtain that service's trust root public key through a channel you trust (not from the service website alone), then run:
  node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf --central-trust-root KEY
or for one receipt:
  node verify-approval.mjs approvals/<recipient>.receipt.jws approvals/<recipient>.trust-bundle.jws --trust-root KEY --prepared original.pdf
A receipt shows email access and approval of original.pdf. It does not verify identity, and it does not prove that completed.pdf shows the same content.

` : ''}Verifier source is AGPL-3.0-only. Inspect it or obtain a trusted copy independently before running software supplied with a document.
`);
  const zipped = zipSync(files, { level: 0 });
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}

/**
 * A participant's own proof package: no other participant's IP, device or private audit data.
 * The receipt and trust bundle are the exact bytes accepted by the installation.
 */
export async function participantPackage(input: { documentId: string; recipientId: string; original: Buffer; completed?: Buffer | null; approval?: Row | null }) {
  const { documentId, recipientId, original, completed, approval } = input;
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const files: Record<string, Uint8Array> = { 'original.pdf': original, 'LICENSE': await readFile(resolve('LICENSE')) };
  if (completed) files['completed.pdf'] = completed;
  if (approval) {
    files['approval/receipt.jws'] = strToU8(approval.receipt);
    files['approval/trust-bundle.jws'] = strToU8(approval.trust_bundle);
    files['verify-approval.mjs'] = await readFile(resolve('scripts/verify-approval.mjs'));
  }
  files['manifest.json'] = strToU8(JSON.stringify({
    schema: 'signhere-participant-package-v1', documentId, recipientId,
    preparedSha256: sha(original), ...(completed ? { completedSha256: sha(completed) } : {}),
    ...(approval ? { independentApproval: { service: approval.service, approvalId: approval.approval_id, receiptSha256: approval.receipt_sha256 } } : {}),
  }, null, 2));
  files['README.txt'] = strToU8(`Signhere – ditt bevispaket / your evidence package

original.pdf    Exakt det förberedda dokument som du läste och godkände.
${completed ? 'completed.pdf   Det färdigsignerade dokumentet med installationens försegling. Det är en annan fil än original.pdf.\n' : 'completed.pdf   Saknas ännu: dokumentet är inte färdigsignerat av alla parter. Hämta det senare med din länk.\n'}${approval ? `approval/       Ditt kvitto från ${approval.service} och den förtroendelista (trust bundle) som det godtogs med.

Kvittot visar att ${approval.service} bekräftade att du hade tillgång till din e-postadress och att du godkände
exakt original.pdf. Det visar inte vem du är, och det bevisar inte att completed.pdf visar samma innehåll.

Kontrollera kvittot utan nätverk (Node.js 22+). Hämta tjänstens rotnyckel (trust root) från en kanal du litar på,
inte bara från tjänstens webbplats:
  node verify-approval.mjs approval/receipt.jws approval/trust-bundle.jws --trust-root NYCKEL --prepared original.pdf

The receipt shows that ${approval.service} confirmed access to your email address and recorded your approval of
exactly original.pdf. It does not verify your identity and does not prove that completed.pdf shows the same content.
` : ''}
Spara filerna oförändrade. Signhere kan inte återskapa en förlorad PDF från dess kontrollsumma.
Keep these files unchanged. A lost PDF cannot be recreated from its checksum.
`);
  const zipped = zipSync(files, { level: 0 });
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}
