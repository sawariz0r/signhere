import { readFile } from 'node:fs/promises';
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
  }
  files['README.txt'] = strToU8(`Signhere portable verification package

Keep these exact files together. original.pdf is the prepared PDF shown to signers; uploaded.pdf, when present, is the original before flattening.

${manifest.schemaVersion === 2 ? `Install Node.js 22+ and Python 3.11+. In an isolated Python environment, install: python -m pip install -r pdf-seal/requirements.txt
Set SIGNHERE_SEAL_PYTHON to that Python executable.
Run: node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf` : 'Install Node.js 22+. Run: node verify-evidence.mjs evidence.json original.pdf completed.pdf'}${artifacts.uploaded ? ' uploaded.pdf' : ''}

${manifest.schemaVersion === 2 ? `Optional: add --trust-fingerprint followed by a SHA-256 certificate fingerprint obtained through an independently trusted channel. The bundled certificate is not its own trust anchor. Exit 0: integrity/evidence pass and explicit fingerprint matches; exit 3: integrity/evidence pass but issuer unknown; exit 1: verification failed. Revocation is not checked.

The private evidence contains participant and request details. Share it only with authorized recipients. The platform seal does not verify drawn-signature identity and has no trusted timestamp. A valid seal does not prevent the installation operator from issuing another seal.` : 'Legacy evidence checks internal consistency only. It is not a cryptographic PDF seal or independent proof of issuer identity.'}

Verifier source is AGPL-3.0-only. Inspect it or obtain a trusted copy independently before running software supplied with a document.
`);
  const zipped = zipSync(files, { level: 0 });
  return Buffer.from(zipped.buffer, zipped.byteOffset, zipped.byteLength);
}
