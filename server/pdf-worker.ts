import { validatePdfBytes, preparePdfBytes, createCompletedPdf } from './pdf-engine.js';
try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 40 * 1024 * 1024) throw new Error('PDF-bearbetningen överskrider storleksgränsen.');
    chunks.push(Buffer.from(chunk));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (request.version !== 1 || !['validate', 'prepare', 'finalize'].includes(request.operation) || !Array.isArray(request.args)) throw new Error('Ogiltig PDF-begäran.');
  const bytes = Buffer.from(request.bytesBase64, 'base64');
  if (request.operation === 'validate') process.stdout.write(JSON.stringify({ ok: true, result: await validatePdfBytes(bytes) }));
  else if (request.operation === 'prepare') {
    const { bytes: prepared, ...result } = await preparePdfBytes(bytes);
    process.stdout.write(JSON.stringify({ ok: true, result, bytesBase64: prepared.toString('base64') }));
  } else {
    const result = await createCompletedPdf(...[bytes, ...request.args] as unknown as Parameters<typeof createCompletedPdf>);
    process.stdout.write(JSON.stringify({ ok: true, bytesBase64: result.toString('base64') }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'PDF-filen kunde inte bearbetas.' }));
  process.exitCode = 1;
}
