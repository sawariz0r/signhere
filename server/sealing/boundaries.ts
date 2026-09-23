import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SealManifest, SealVerification } from '../seal.js';
export const MAX_SEAL_BYTES = 32 * 1024 * 1024;
export const MAX_SEAL_TAIL_BYTES = 96 * 1024;
export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface PreparedRange { digest: string; start: number; end: number; inputHash: string; inputLength: number }

/** Capture a bounded regular file by descriptor; reject symlinks/hardlinks and
 * changes across the read. Never reopen a sandbox-produced pathname for signing. */
export async function captureRegularFile(path: string, maximum = MAX_SEAL_BYTES): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Seal stage output is not a regular file without extra hard links.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.nlink !== 1 || (before.dev !== 0 && initial.dev !== before.dev) || initial.ino !== before.ino || initial.size < 8 || initial.size > maximum) throw new Error('Seal stage output is invalid or oversized.');
    const bytes = Buffer.alloc(initial.size + 1);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const final = await file.stat();
    if (offset !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs || final.nlink !== 1) throw new Error('Seal stage output changed while being captured.');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
export function checkPreparedCandidate(prepared: Buffer, candidate: Buffer, ranges: PreparedRange) {
  if (prepared.length <= candidate.length || prepared.length > MAX_SEAL_BYTES || prepared.length - candidate.length > MAX_SEAL_TAIL_BYTES || !prepared.subarray(0, candidate.length).equals(candidate)) throw new Error('PDF preparation changed the candidate or exceeded the incremental tail budget.');
  if (!ranges || ranges.inputHash !== hash(candidate) || ranges.inputLength !== candidate.length || !Number.isSafeInteger(ranges.start) || !Number.isSafeInteger(ranges.end)
    || ranges.start < candidate.length || ranges.end >= prepared.length || ranges.end - ranges.start !== 65538 || !/^[a-f0-9]{64}$/.test(ranges.digest)) throw new Error('PDF preparation returned invalid bounds.');
  if (!prepared.subarray(ranges.start, ranges.end).equals(Buffer.from('<' + '0'.repeat(65536) + '>'))) throw new Error('PDF preparation returned an invalid signature placeholder.');
  const digest = createHash('sha256').update(prepared.subarray(0, ranges.start)).update(prepared.subarray(ranges.end)).digest('hex');
  if (digest !== ranges.digest) throw new Error('PDF preparation digest differs from captured bytes.');
}
export function checkSealVerdict(metadata: SealVerification, captured: Buffer, expected: { manifest?: SealManifest; fingerprint?: string } = {}) {
  if (!metadata || metadata.integrity !== 'valid' || metadata.coverage !== 'entire-file' || metadata.profile !== 'signhere-seal-v1' || metadata.timestamp !== 'absent'
    || metadata.identityVerified !== false || metadata.qualifiedSignature !== false || metadata.revocation !== 'not-checked' || metadata.pdfHash !== hash(captured)) throw new Error('PDF verifier returned a mismatched verdict.');
  if (!metadata.manifest || metadata.manifest.schema !== 'signhere-seal-v1' || metadata.manifest.certificateFingerprint !== metadata.certificateFingerprint
    || (expected.manifest && !isDeepStrictEqual(metadata.manifest, expected.manifest)) || (expected.fingerprint && metadata.certificateFingerprint !== expected.fingerprint)) throw new Error('PDF verifier returned a mismatched manifest or certificate.');
  if (!/^[a-f0-9]{64}$/.test(metadata.certificateFingerprint) || new X509Certificate(metadata.certificatePem).fingerprint256.replaceAll(':', '').toLowerCase() !== metadata.certificateFingerprint) throw new Error('PDF verifier certificate bytes do not match its fingerprint.');
  if (metadata.issuerTrust !== (expected.fingerprint ? 'pinned' : 'unknown')) throw new Error('PDF verifier returned an unexpected trust claim.');
}
