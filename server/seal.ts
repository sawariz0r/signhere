import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, isAbsolute, delimiter } from 'node:path';

/** The strict PDF parser rejected this candidate. Infrastructure/configuration
 * failures deliberately remain ordinary errors so HTTP callers can return 503. */
export class SealInputError extends Error {
  readonly code = 'INVALID_PDF';
  constructor(message = 'Unsupported or malformed prepared PDF.') { super(message); this.name = 'SealInputError'; }
}

export interface SealManifest {
  schema: 'signhere-seal-v1';
  evidenceSchema: 2;
  installationId: string;
  documentId: string;
  evidenceDigest: string;
  preparedHash: string;
  checkpoint: { sequence: number; hash: string };
  certificateFingerprint: string;
  policy: { timestamp: 'off' };
}
export interface SealIdentity {
  fingerprintSha256: string;
  certificatePem: string;
  chainPem: string;
  notBefore: string;
  notAfter: string;
  keyAlgorithm: string;
}
export interface SealVerification {
  profile: 'signhere-seal-v1';
  integrity: 'valid';
  coverage: 'entire-file';
  issuerTrust: 'pinned' | 'unknown';
  timestamp: 'absent';
  certificateFingerprint: string;
  certificatePem: string;
  certificateValidity: 'current' | 'outside-current-validity';
  manifest: SealManifest;
  evidence: 'not-supplied' | 'digest-matched';
  preparedPdf: 'not-supplied' | 'digest-matched';
  pdfHash: string;
  identityVerified: false;
  qualifiedSignature: false;
  revocation: 'not-checked';
}
export interface SealKeyOptions {
  p12File: string;
  passwordFile?: string;
  expectedFingerprint: string;
  timestampPolicy?: 'off' | 'required';
}
import { captureRegularFile, checkPreparedCandidate, checkSealVerdict, hash, MAX_SEAL_BYTES, type PreparedRange } from './sealing/boundaries.js';
const MAX_BYTES = MAX_SEAL_BYTES;
const MAX_OUTPUT = 128 * 1024;
function python() {
  const configured = process.env.SIGNHERE_SEAL_PYTHON;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('SIGNHERE_SEAL_PYTHON must be an absolute interpreter path.');
    return configured;
  }
  const local = resolve('.local', 'seal-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(local)) return local;
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('PDF seal Python runtime is not installed.');
}
const engine = () => resolve('scripts/pdf-seal/engine.py');

/** Deployment isolation hook. The fixed launcher must execute the supplied Python
 * command with the operation directory as its only writable mount and without
 * access to the key volume/network. It is an administrator executable, not a shell.
 * Development without a launcher is explicitly not an OS security sandbox. */
async function call<T>(operation: 'create' | 'inspect' | 'prepare' | 'cms' | 'verify', request: Record<string, unknown>, directory?: string): Promise<T> {
  const parser = operation === 'prepare' || operation === 'verify';
  const launcher = parser ? process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER : undefined;
  if (parser && process.env.SIGNHERE_REQUIRE_PDF_SANDBOX === 'true' && !launcher) throw new Error('PDF sandbox launcher is required for this deployment.');
  const executable = launcher || python();
  const args = launcher ? [directory!, python(), engine(), operation] : ['-I', '-B', engine(), operation];
  return new Promise<T>((accept, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, cwd: directory, detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
        TMP: process.env.TMP, LANG: 'C.UTF-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderrLength = 0, settled = false, abortError: Error | undefined;
    const abort = (error: Error) => {
      if (abortError || settled) return;
      abortError = error;
      if (process.platform === 'win32' && child.pid) {
        // Python creates no children during normal work. Kill the entire tree
        // if a parser fails or is compromised, and wait for the child's close.
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('exit', () => child.kill('SIGKILL'));
      } else {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else accept(result as T);
    };
    const timer = setTimeout(() => abort(new Error('PDF seal operation exceeded its time limit.')), 45_000);
    child.stdout.on('data', chunk => {
      if (abortError) return;
      if (stdout.length + chunk.length > MAX_OUTPUT) { abort(new Error('PDF seal response exceeded its size limit.')); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', chunk => {
      stderrLength += chunk.length;
      if (stderrLength > MAX_OUTPUT) abort(new Error('PDF seal diagnostic output exceeded its size limit.'));
    });
    child.on('error', error => finish(new Error(`PDF seal runtime unavailable: ${error.message}`)));
    child.on('close', code => {
      if (abortError) { finish(abortError); return; }
      try {
        const reply = JSON.parse(stdout.toString('utf8')) as { ok: boolean; result?: T; error?: string; errorCode?: string };
        if (code !== 0 || !reply.ok) {
          const message = typeof reply.error === 'string' ? reply.error.slice(0, 400) : 'PDF seal operation failed.';
          finish(operation === 'prepare' && code === 1 && reply.ok === false && reply.errorCode === 'INVALID_PDF' ? new SealInputError(message) : new Error(message));
        }
        else finish(undefined, reply.result);
      } catch { finish(new Error('PDF seal runtime returned an invalid response.')); }
    });
    child.stdin.on('error', () => { /* close/error above owns result */ });
    child.stdin.end(JSON.stringify(request));
  });
}
async function workspace<T>(work: (directory: string) => Promise<T>) {
  const base = process.env.SIGNHERE_SEAL_WORK_DIR || tmpdir();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, 'signhere-seal-'));
  await chmod(directory, 0o700);
  try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function size(bytes: Buffer) { if (bytes.length < 8 || bytes.length > MAX_BYTES) throw new Error('Invalid PDF seal input size.'); }
export async function createLocalIdentity(directory: string, installationId: string): Promise<SealIdentity> {
  return call<SealIdentity>('create', { directory: resolve(directory), installationId });
}
export async function inspectIdentity(p12File: string, passwordFile?: string): Promise<SealIdentity> {
  return call<SealIdentity>('inspect', { p12File: resolve(p12File), ...(passwordFile ? { passwordFile: resolve(passwordFile) } : {}) });
}
async function prepareCaptured(bytes: Buffer, manifest: SealManifest, chainPem: string) {
  return workspace(async directory => {
    const input = join(directory, 'candidate.pdf'), output = join(directory, 'prepared.pdf'), cert = join(directory, 'chain.pem');
    await Promise.all([writeFile(input, bytes, { mode: 0o600, flag: 'wx' }), writeFile(cert, chainPem, { mode: 0o600, flag: 'wx' })]);
    const ranges = await call<PreparedRange>('prepare', { input, output, certificateFile: cert, manifest }, directory);
    const captured = await captureRegularFile(output);
    checkPreparedCandidate(captured, bytes, ranges);
    return { captured, ranges };
  });
}
/** Public-only dry run for the appendix candidate before invitations are issued.
 * It proves this candidate can pass the strict parser/placeholder stage, not that
 * every future resource failure is impossible or that its rendering is authentic. */
export async function preflightSealPdf(bytes: Buffer, identity: Pick<SealIdentity, 'fingerprintSha256' | 'certificatePem'> & { chainPem?: string }): Promise<void> {
  size(bytes);
  await prepareCaptured(bytes, { schema: 'signhere-seal-v1', evidenceSchema: 2, installationId: 'preflight-installation', documentId: 'preflight-document',
    evidenceDigest: '0'.repeat(64), preparedHash: hash(bytes), checkpoint: { sequence: 1, hash: '0'.repeat(64) },
    certificateFingerprint: identity.fingerprintSha256, policy: { timestamp: 'off' } }, identity.chainPem ?? identity.certificatePem);
}
export async function signPdf(bytes: Buffer, manifest: SealManifest, options: SealKeyOptions): Promise<{ bytes: Buffer; metadata: SealVerification }> {
  size(bytes);
  if (options.timestampPolicy && options.timestampPolicy !== 'off') throw new Error('Required timestamping is not available in this release; no unsigned fallback is allowed.');
  const identity = await inspectIdentity(options.p12File, options.passwordFile);
  if (identity.fingerprintSha256 !== options.expectedFingerprint || manifest.certificateFingerprint !== options.expectedFingerprint) throw new Error('Sealing identity does not match the pinned certificate.');
  // Preparation, key access and verification have distinct directories. No parser
  // ever receives a path to the trusted CMS input/output directory.
  const prepared = await prepareCaptured(bytes, manifest, identity.chainPem);
  const sealed = await workspace(async privateDirectory => {
    const input = join(privateDirectory, 'prepared.pdf'), output = join(privateDirectory, 'signed.pdf');
    await writeFile(input, prepared.captured, { mode: 0o600, flag: 'wx' });
    const result = await call<{ outputHash: string; outputLength: number; fingerprintSha256: string }>('cms', { ...prepared.ranges,
      candidateSha256: hash(bytes), candidateLength: bytes.length, input, output, p12File: resolve(options.p12File),
      ...(options.passwordFile ? { passwordFile: resolve(options.passwordFile) } : {}), expectedFingerprint: options.expectedFingerprint }, privateDirectory);
    const captured = await captureRegularFile(output);
    if (result.fingerprintSha256 !== options.expectedFingerprint || result.outputLength !== captured.length || result.outputHash !== hash(captured) || !captured.subarray(0, bytes.length).equals(bytes)) throw new Error('CMS output differs from the captured artifact.');
    return captured;
  });
  // Verify only a copy of captured bytes. A compromised verifier cannot overwrite
  // the bytes returned for publication, and its claimed metadata is checked here.
  const metadata = await verifyPdf(sealed, { expectedFingerprint: options.expectedFingerprint, expectedManifest: manifest });
  checkSealVerdict(metadata, sealed, { fingerprint: options.expectedFingerprint, manifest });
  return { bytes: sealed, metadata };
}
export async function verifyPdf(bytes: Buffer, options: { expectedFingerprint?: string; expectedManifest?: SealManifest; evidenceCore?: Buffer; preparedPdf?: Buffer } = {}): Promise<SealVerification> {
  size(bytes);
  return workspace(async directory => {
    const input = join(directory, 'signed.pdf');
    await writeFile(input, bytes, { mode: 0o600, flag: 'wx' });
    const request: Record<string, unknown> = { input, expectedFingerprint: options.expectedFingerprint, expectedManifest: options.expectedManifest };
    if (options.evidenceCore) {
      request.evidenceCoreFile = join(directory, 'evidence-core.json');
      await writeFile(request.evidenceCoreFile as string, options.evidenceCore, { mode: 0o600, flag: 'wx' });
    }
    if (options.preparedPdf) {
      request.preparedPdfFile = join(directory, 'original.pdf');
      await writeFile(request.preparedPdfFile as string, options.preparedPdf, { mode: 0o600, flag: 'wx' });
    }
    const metadata = await call<SealVerification>('verify', request, directory);
    checkSealVerdict(metadata, bytes, { fingerprint: options.expectedFingerprint, manifest: options.expectedManifest });
    return metadata;
  });
}
