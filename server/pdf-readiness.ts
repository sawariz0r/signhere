import { PDFDocument } from 'pdf-lib';
import { finalizePdf, sha256 } from './pdf.js';
import { preflightSealPdf, type SealIdentity } from './seal.js';
type PublicIdentity = Pick<SealIdentity, 'fingerprintSha256' | 'certificatePem'> & { chainPem?: string };
/** Cached, single-flight public-only probe of the actual appendix/parser path. */
export function createPdfReadiness() {
  let cache: { fingerprint: string; checkedAt: number; ready: boolean } | undefined;
  let pending: { fingerprint: string; result: Promise<boolean> } | undefined;
  return async function ready(identity: PublicIdentity): Promise<boolean> {
    if (pending) { if (pending.fingerprint === identity.fingerprintSha256) return pending.result; await pending.result; return ready(identity); }
    if (cache?.fingerprint === identity.fingerprintSha256 && Date.now() - cache.checkedAt < 30000) return cache.ready;
    const result = (async () => {
      let success = false;
      try {
        const pdf = await PDFDocument.create(); pdf.addPage([72, 72]); const original = Buffer.from(await pdf.save());
        const candidate = await finalizePdf(original, 'Readiness probe', '00000000-0000-4000-8000-000000000000', sha256(original), {text:'Probe',version:'probe'},
          [{name:'Probe',email:'probe@example.invalid',signedAt:'2000-01-01T00:00:00.000Z',strokes:[[[0,0],[1,1]]],methodId:'draw',methodVersion:'1.0.0'}], {sequence:1,hash:'0'.repeat(64)}, true);
        await preflightSealPdf(candidate, identity); success = true;
      } catch { console.error('signhere: pdf_pipeline_unavailable'); }
      cache = { fingerprint: identity.fingerprintSha256, checkedAt: Date.now(), ready: success };
      return success;
    })();
    pending = { fingerprint: identity.fingerprintSha256, result };
    try { return await result; } finally { pending = undefined; }
  };
}
