import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Strokes } from './plugins.js';
import { createHash } from 'node:crypto';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export interface PdfSigner { name: string; signedName?: string; email: string; signedAt: string; strokes: Strokes; methodId: string; methodVersion: string; consent?: { text: string; version: string }; }
export interface PdfPreparation { kind: 'flatten'; engine: 'mupdf'; engineVersion: string; sourceHash: string; sourceSize: number; annotationCount: number; formFieldCount: number; noteCount: number; }
export interface AuditCheckpoint { sequence: number; hash: string; }
export interface PdfAttachmentOf { documentId: string; title: string; completedHash: string; number: number; }
let active = 0;
const waiters: Array<() => void> = [];
async function acquire() {
  if (active >= 2) {
    if (waiters.length >= 4) throw new Error('PDF-hanteringen är upptagen. Försök igen om en stund.');
    await new Promise<void>(resolve => waiters.push(resolve));
  } else active++;
}
function release() { const next = waiters.shift(); if (next) next(); else active--; }

async function run<T>(operation: 'validate' | 'prepare' | 'finalize', args: unknown[]): Promise<T> {
  await acquire();
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'signhere-pdf-'));
    const development = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(new URL(development ? './pdf-worker.ts' : './pdf-worker.js', import.meta.url));
    const nodeArgs = ['--max-old-space-size=192', ...(development ? ['--import', import.meta.resolve('tsx')] : []), entry];
    const launcher = process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER;
    if (process.env.SIGNHERE_REQUIRE_PDF_SANDBOX === 'true' && !launcher) throw new Error('PDF sandbox launcher is required for this deployment.');
    return await new Promise<T>((resolve, reject) => {
      const child = spawn(launcher || process.execPath, launcher ? [directory!, process.execPath, ...nodeArgs] : nodeArgs, {
        cwd: directory, windowsHide: true, shell: false, detached: process.platform !== 'win32',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, LANG: 'C.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = Buffer.alloc(0), diagnostics = 0, failure: Error | undefined;
      const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } };
      const timer = setTimeout(() => { failure = new Error('PDF-filen tog för lång tid att bearbeta. Exportera en enklare PDF.'); kill(); }, 20_000);
      child.stdout.on('data', chunk => {
        if (output.length <= 48 * 1024 * 1024) output = Buffer.concat([output, chunk]);
        if (output.length > 48 * 1024 * 1024) { failure = new Error('PDF-resultatet överskrider storleksgränsen.'); kill(); }
      });
      child.stderr.on('data', chunk => { diagnostics += chunk.length; if (diagnostics > 64 * 1024) { failure = new Error('PDF-bearbetningen kunde inte slutföras.'); kill(); } });
      child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new Error('PDF-bearbetningen kunde inte startas.')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure) { reject(failure); return; }
        try {
          const reply = JSON.parse(output.toString('utf8'));
          if (code || !reply.ok) throw new Error(reply.error ?? 'PDF-filen kunde inte bearbetas inom resursgränserna.');
          if (operation === 'finalize') resolve(Buffer.from(reply.bytesBase64, 'base64') as T);
          else if (operation === 'prepare') resolve({ ...reply.result, bytes: Buffer.from(reply.bytesBase64, 'base64') } as T);
          else resolve(reply.result as T);
        } catch (error) { reject(error instanceof Error ? error : new Error('Ogiltigt PDF-resultat.')); }
      });
      child.stdin.end(JSON.stringify({ version: 1, operation, bytesBase64: Buffer.from(args[0] as Uint8Array).toString('base64'), args: args.slice(1) }));
    });
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); release(); }
}
export async function validatePdf(bytes: Buffer) {
  if (bytes.length > MAX_PDF_BYTES || bytes.length < 8 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Ladda upp en PDF på högst 10 MB.');
  return run<{ pages: number; hash: string }>('validate', [bytes]);
}
export async function preparePdf(bytes: Buffer) {
  if (bytes.length > MAX_PDF_BYTES || bytes.length < 8 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Ladda upp en PDF på högst 10 MB.');
  const result = await run<{ bytes: Uint8Array; pages: number; hash: string; preparation: PdfPreparation | null }>('prepare', [bytes]);
  return { ...result, bytes: Buffer.from(result.bytes) };
}
export async function finalizePdf(original: Uint8Array, title: string, documentId: string, originalHash: string, consent: { text: string; version: string }, signers: PdfSigner[], auditCheckpoint?: AuditCheckpoint, sealExpected = false, attachmentOf?: PdfAttachmentOf) {
  return Buffer.from(await run<Uint8Array>('finalize', [original, title, documentId, originalHash, consent, signers, auditCheckpoint, sealExpected, ...(attachmentOf ? [attachmentOf] : [])]));
}
