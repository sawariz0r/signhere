import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyBundle, verifyApprovalReceipt, canonical } from './verify-approval.mjs';
import { verifyEvidence, decodeEvidenceCore, parseEvidenceJson, readBoundedFile, MAX_PDF_BYTES, MAX_EVIDENCE_JSON_BYTES, normalizeFingerprint } from './verify-evidence.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const folder = dirname(fileURLToPath(import.meta.url));
function pythonExecutable() {
  const configured = process.env.SIGNHERE_SEAL_PYTHON;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('SIGNHERE_SEAL_PYTHON must be an absolute path.');
    return configured;
  }
  const local = resolve('.local/seal-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(local)) return local;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Install the PDF verification Python runtime first.');
}
async function validatePdf(request) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(pythonExecutable(), ['-I', '-B', join(folder, 'pdf-seal/engine.py'), 'verify'], { windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONUTF8: '1' } });
    let output = Buffer.alloc(0), errorBytes = 0, failure;
    const abort = error => {
      if (failure) return;
      failure = error;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL')); killer.on('exit', () => child.kill('SIGKILL'));
      } else { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => abort(new Error('Verification exceeded its time limit.')), 60000);
    child.stdout.on('data', chunk => { if (failure) return; if (output.length + chunk.length > 131072) return abort(new Error('Verifier output exceeded limit.')); output = Buffer.concat([output, chunk]); });
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 131072) abort(new Error('Verifier diagnostics exceeded limit.')); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (failure) return reject(failure); try { const reply = JSON.parse(output); if (code || !reply.ok) throw new Error(reply.error || 'PDF validation failed.'); resolveResult(reply.result); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(request));
  });
}
/**
 * Receipts are verified only against a central trust root supplied by the verifying party. The root
 * frozen in the document policy was chosen by the installation and is reported, not trusted.
 */
function verifyCommittedReceipts(core, policy, original, centralTrustRoot) {
  const participants = core.recipients.filter(recipient => recipient.independentApproval).map(recipient => {
    const approval = recipient.independentApproval;
    if (!centralTrustRoot) return { recipientId: recipient.id, receiptSha256: approval.receiptSha256, sealCommitment: 'included', receiptSignature: 'not-checked' };
    const result = verifyApprovalReceipt(approval.receipt, verifyBundle(approval.trustBundle, centralTrustRoot), { prepared: original });
    return { recipientId: recipient.id, receiptSha256: approval.receiptSha256, sealCommitment: 'included', receiptSignature: result.signature, keyTrust: result.keyTrust,
      emailAccess: result.emailAccess.address, preparedPdf: result.preparedPdf };
  });
  return { service: policy.service, frozenTrustRoot: policy.trustRoot, trustRoot: centralTrustRoot ? (centralTrustRoot === policy.trustRoot ? 'supplied-matches-frozen' : 'supplied-differs-from-frozen') : 'not-supplied',
    participants, approvedContent: 'prepared-original', completedContentRelationship: 'unverified' };
}
export async function verifySealedEvidence(manifest, original, completed, uploaded, trustedFingerprint, centralTrustRoot) {
  if (!manifest || manifest.schemaVersion !== 2) throw new Error('This verifier requires sealed schema-v2 evidence.');
  for (const bytes of [original, completed, ...(uploaded === undefined ? [] : [uploaded])]) if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > MAX_PDF_BYTES) throw new Error('PDF input is missing or oversized.');
  if (trustedFingerprint !== undefined) trustedFingerprint = normalizeFingerprint(trustedFingerprint);
  const encoded = manifest.evidenceCoreBase64;
  if (typeof encoded !== 'string' || encoded.length > 45 * 1024 * 1024) throw new Error('Evidence core is missing or oversized.');
  const coreBytes = Buffer.from(encoded, 'base64');
  if (coreBytes.length > 32 * 1024 * 1024 || coreBytes.toString('base64') !== encoded) throw new Error('Invalid exact evidence core encoding.');
  const directory = await mkdtemp(join(tmpdir(), 'signhere-verify-'));
  try {
    await chmod(directory, 0o700);
    const input = join(directory, 'completed.pdf'), preparedPdfFile = join(directory, 'original.pdf'), evidenceCoreFile = join(directory, 'evidence-core.json');
    await Promise.all([writeFile(input, completed, { mode: 0o600 }), writeFile(preparedPdfFile, original, { mode: 0o600 }), writeFile(evidenceCoreFile, coreBytes, { mode: 0o600 })]);
    // The PDF's authenticated commitment is checked before trusting core contents.
    const seal = await validatePdf({ input, preparedPdfFile, evidenceCoreFile, ...(trustedFingerprint ? { expectedFingerprint: trustedFingerprint } : {}) });
    const consistency = verifyEvidence(manifest, original, completed, uploaded);
    const { core } = decodeEvidenceCore(manifest);
    if (seal.manifest.documentId !== manifest.document.id || seal.manifest.installationId !== core.installationId || seal.manifest.evidenceDigest !== hash(coreBytes)
      || seal.manifest.preparedHash !== hash(original) || (seal.manifest.checkpoint.sequence !== core.signingCheckpoint.sequence || seal.manifest.checkpoint.hash !== core.signingCheckpoint.hash)
      || seal.manifest.policy.timestamp !== core.events[0].data.protectionPolicy.timestamp) throw new Error('Seal and evidence bindings disagree.');
    // Independent approval: the seal commits to the exact receipt of every approving participant.
    const frozenIndependent = core.events[0].data.protectionPolicy.independentApproval;
    const committed = core.recipients.filter(recipient => recipient.independentApproval).map(recipient => ({ recipientId: recipient.id, receiptSha256: recipient.independentApproval.receiptSha256 }));
    if (Boolean(frozenIndependent) !== (seal.manifest.policy.independentApproval === 'email') || canonical(seal.manifest.approvalReceipts ?? null) !== canonical(frozenIndependent ? committed : null)) throw new Error('Seal and independent approval commitments disagree.');
    const approvals = frozenIndependent ? verifyCommittedReceipts(core, frozenIndependent, original, centralTrustRoot) : undefined;
    if (manifest.document.seal?.fingerprintSha256 !== seal.certificateFingerprint || manifest.seal?.certificateFingerprint !== seal.certificateFingerprint) throw new Error('Exported seal identity differs from the PDF.');
    return { documentId: manifest.document.id, signatures: consistency.signatures, pdfHash: hash(completed), evidenceCoreHash: hash(coreBytes),
      integrity: seal.integrity, coverage: seal.coverage, profile: seal.profile, evidence: 'complete', completionMetadata: 'unsealed-consistency-only', issuerTrust: seal.issuerTrust,
      certificateFingerprint: seal.certificateFingerprint, certificateValidity: seal.certificateValidity, revocation: seal.revocation,
      trustedTimestamp: false, identityVerified: false, qualifiedSignature: false, uploadedSourceVerified: consistency.uploadedSourceVerified,
      ...(approvals ? { independentApproval: approvals } : {}) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const centralIndex = args.indexOf('--central-trust-root');
  const centralTrustRoot = centralIndex >= 0 ? args.splice(centralIndex, 2)[1] : undefined;
  const trustIndex = args.indexOf('--trust-fingerprint');
  const trustInput = trustIndex >= 0 ? args.splice(trustIndex, 2)[1] : undefined;
  try {
    if (centralIndex >= 0 && !/^[A-Za-z0-9_-]{43}$/.test(centralTrustRoot ?? '')) throw new Error('--central-trust-root must be the 43-character central trust root public key.');
    const trustedFingerprint = trustIndex >= 0 ? normalizeFingerprint(trustInput) : undefined;
    if (args.length < 3 || args.length > 4 || (trustIndex >= 0 && !/^[a-f0-9]{64}$/.test(trustedFingerprint ?? ''))) throw new Error('Usage: node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf [uploaded.pdf] [--trust-fingerprint HEX] [--central-trust-root KEY]');
    const manifest = parseEvidenceJson(readBoundedFile(args[0], MAX_EVIDENCE_JSON_BYTES));
    const [original, completed, uploaded] = args.slice(1).map(file => readBoundedFile(file, MAX_PDF_BYTES));
    const result = await verifySealedEvidence(manifest, original, completed, uploaded, trustedFingerprint, centralTrustRoot);
    if (result.independentApproval?.participants.some(item => item.receiptSignature && item.receiptSignature !== 'not-checked' && (item.receiptSignature !== 'valid' || item.keyTrust !== 'trusted' || item.preparedPdf !== 'matched'))) throw new Error('An independent approval receipt is not trusted: ' + JSON.stringify(result.independentApproval.participants));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.issuerTrust === 'unknown' ? 3 : 0;
  } catch (error) { console.error('Verification failed: ' + error.message); process.exitCode = 1; }
}
