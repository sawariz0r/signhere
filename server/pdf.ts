import { Worker } from 'node:worker_threads';
import type { Strokes } from './plugins.js';
import { createHash } from 'node:crypto';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export interface PdfSigner { name: string; signedName?: string; email: string; signedAt: string; strokes: Strokes; methodId: string; methodVersion: string; }
export interface PdfPreparation { kind: 'flatten'; engine: 'mupdf'; engineVersion: string; sourceHash: string; sourceSize: number; annotationCount: number; formFieldCount: number; noteCount: number; }
export interface AuditCheckpoint { sequence: number; hash: string; }
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
  try {
    return await new Promise<T>((resolve, reject) => {
      const development = import.meta.url.endsWith('.ts');
      let entry = new URL('./pdf-worker.js', import.meta.url);
      if (development) {
        const loader = import.meta.resolve('tsx/esm/api');
        const target = new URL('./pdf-worker.ts', import.meta.url).href;
        const code = `import { tsImport } from ${JSON.stringify(loader)}; await tsImport(${JSON.stringify(target)}, ${JSON.stringify(import.meta.url)});`;
        entry = new URL(`data:text/javascript,${encodeURIComponent(code)}`);
      }
      const worker = new Worker(entry, {
        workerData: { operation, args }, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
      let settled = false;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Do not free the concurrency slot while a timed-out worker still lives.
        void worker.terminate().then(() => {
          if (error) reject(error); else resolve(result as T);
        }, () => reject(error ?? new Error('PDF-bearbetningen kunde inte avslutas.')));
      };
      const timer = setTimeout(() => finish(new Error('PDF-filen tog för lång tid att bearbeta. Exportera en enklare PDF.')), 12_000);
      worker.once('message', (reply: { ok: boolean; result?: T; error?: string }) => finish(reply.ok ? undefined : new Error(reply.error ?? 'PDF-filen kunde inte bearbetas.'), reply.result));
      worker.once('error', () => finish(new Error('PDF-filen kunde inte bearbetas inom resursgränserna.')));
      worker.once('exit', () => { if (!settled) finish(new Error('PDF-bearbetningen avslutades oväntat.')); });
    });
  } finally { release(); }
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
export async function finalizePdf(original: Uint8Array, title: string, documentId: string, originalHash: string, consent: { text: string; version: string }, signers: PdfSigner[], auditCheckpoint?: AuditCheckpoint) {
  return Buffer.from(await run<Uint8Array>('finalize', [original, title, documentId, originalHash, consent, signers, auditCheckpoint]));
}
