import { parentPort, workerData } from 'node:worker_threads';
import { validatePdfBytes, preparePdfBytes, createCompletedPdf } from './pdf-engine.js';
try {
  const result = workerData.operation === 'validate'
    ? await validatePdfBytes(Buffer.from(workerData.args[0]))
    : workerData.operation === 'prepare'
      ? await preparePdfBytes(Buffer.from(workerData.args[0]))
      : await createCompletedPdf(...workerData.args as Parameters<typeof createCompletedPdf>);
  parentPort!.postMessage({ ok: true, result });
} catch (error) {
  parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'PDF-filen kunde inte bearbetas.' });
}
