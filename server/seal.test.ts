import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, rename, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, PDFName, PDFString } from 'pdf-lib';
import { createLocalIdentity, inspectIdentity, signPdf, verifyPdf, preflightSealPdf, SealInputError, type SealManifest, type SealIdentity } from './seal.js';

import { captureRegularFile, checkPreparedCandidate, checkSealVerdict, MAX_SEAL_TAIL_BYTES } from './sealing/boundaries.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let directory: string, original: Buffer, sealed: Buffer, identity: SealIdentity, manifest: SealManifest;
const core = Buffer.from('{"schema":2,"nonce":"private-test-nonce","events":[]}');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'signhere-seal-test-'));
  identity = await createLocalIdentity(join(directory, 'identity'), 'test-installation');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('Signhere interoperability fixture', { x: 30, y: 500, font });
  original = Buffer.from(await pdf.save({ useObjectStreams: false }));
  manifest = { schema: 'signhere-seal-v1', evidenceSchema: 2, installationId: 'test-installation', documentId: 'test-document',
    preparedHash: hash(original), evidenceDigest: hash(core), checkpoint: { sequence: 3, hash: 'a'.repeat(64) },
    certificateFingerprint: identity.fingerprintSha256, policy: { timestamp: 'off' } };
  const result = await signPdf(original, manifest, { p12File: join(directory, 'identity', 'identity.p12'), expectedFingerprint: identity.fingerprintSha256 });
  sealed = result.bytes;
  assert.equal(result.metadata.integrity, 'valid');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('seal independently verifies exact PDF, protected manifest, and detached evidence', async () => {
  const result = await verifyPdf(sealed, { expectedFingerprint: identity.fingerprintSha256, expectedManifest: manifest, evidenceCore: core, preparedPdf: original });
  assert.equal(result.issuerTrust, 'pinned');
  assert.equal(result.evidence, 'digest-matched');
  assert.equal(result.preparedPdf, 'digest-matched');
  assert.equal(result.timestamp, 'absent');
  assert.equal(result.identityVerified, false);
  assert.equal(result.pdfHash, hash(sealed));
  assert.deepEqual(sealed.subarray(0, original.length), original, 'incremental signing preserves exact candidate PDF prefix');
});
test('embedded self-signed certificate is not a trust anchor', async () => {
  assert.equal((await verifyPdf(sealed)).issuerTrust, 'unknown');
  await assert.rejects(verifyPdf(sealed, { expectedFingerprint: 'b'.repeat(64) }), /fingerprint/);
});
test('signed PDF content alteration and unsigned trailing bytes fail', async () => {
  const changed = Buffer.from(sealed);
  const position = changed.indexOf(Buffer.from('/MediaBox'));
  assert.ok(position > 0);
  const firstDigit = changed.indexOf(48, position);
  changed[firstDigit] = 49;
  await assert.rejects(verifyPdf(changed), /invalid/);
  await assert.rejects(verifyPdf(Buffer.concat([sealed, Buffer.from('\n% unsigned tail\n')])), /entire file|coverage|Unsigned/);
});
test('detached evidence, prepared PDF and expected protected manifest mismatches fail', async () => {
  await assert.rejects(verifyPdf(sealed, { evidenceCore: Buffer.from('{"schema":2}') }), /evidence/);
  await assert.rejects(verifyPdf(sealed, { preparedPdf: Buffer.from('%PDF-1.7 wrong file') }), /Prepared PDF/);
  await assert.rejects(verifyPdf(sealed, { expectedManifest: { ...manifest, documentId: 'swapped-document' } }), /manifest/);
});
test('identity creation cannot overwrite an existing key and inspection returns public metadata', async () => {
  const p12 = join(directory, 'identity', 'identity.p12');
  const before = hash(await readFile(p12));
  await assert.rejects(createLocalIdentity(join(directory, 'identity'), 'replacement-installation'));
  assert.equal(hash(await readFile(p12)), before);
  assert.deepEqual(await inspectIdentity(p12), identity);
});
test('existing signatures and required timestamp policy fail closed', async () => {
  const options = { p12File: join(directory, 'identity', 'identity.p12'), expectedFingerprint: identity.fingerprintSha256 };
  await assert.rejects(signPdf(sealed, manifest, options), /unsigned/);
  await assert.rejects(signPdf(original, manifest, { ...options, timestampPolicy: 'required' }), /not available/);
  await assert.rejects(signPdf(original, manifest, { ...options, expectedFingerprint: 'b'.repeat(64) }), /pinned/);
});
test('private evidence strict parsing rejects duplicate keys even with a valid commitment', async () => {
  const ambiguous = Buffer.from('{"schema":2,"schema":1}');
  const result = await signPdf(original, { ...manifest, evidenceDigest: hash(ambiguous) }, { p12File: join(directory, 'identity', 'identity.p12'), expectedFingerprint: identity.fingerprintSha256 });
  await assert.rejects(verifyPdf(result.bytes, { evidenceCore: ambiguous }), /Duplicate/);
});

test('public preflight succeeds with no private key available and rejects unsupported signature fields', async () => {
  const key = join(directory, 'identity', 'identity.p12'), unavailable = join(directory, 'identity', 'temporarily-unavailable.p12');
  await rename(key, unavailable);
  try { await preflightSealPdf(original, { fingerprintSha256: identity.fingerprintSha256, certificatePem: identity.certificatePem }); }
  finally { await rename(unavailable, key); }
  const pdf = await PDFDocument.load(original);
  const field = pdf.context.register(pdf.context.obj({ FT: PDFName.of('Sig'), T: PDFString.of('ExistingUnsignedSignature') }));
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [field] }));
  await assert.rejects(preflightSealPdf(Buffer.from(await pdf.save({ useObjectStreams: false })), identity), /unsigned/);
  await assert.rejects(preflightSealPdf(Buffer.from('%PDF-1.7\ninvalid xref\n%%EOF'), identity), SealInputError);
});
test('sandbox output capture rejects linked files and bounds output before allocation', async () => {
  const source = join(directory, 'capture-source.pdf'), alias = join(directory, 'capture-alias.pdf');
  await writeFile(source, original, { flag: 'wx', mode: 0o600 }); await link(source, alias);
  await assert.rejects(captureRegularFile(alias), /regular file/);
  await rm(alias);
  await assert.rejects(captureRegularFile(source, 8), /oversized/);
  assert.deepEqual(await captureRegularFile(source), original);
});
test('compromised preparation cannot replace the candidate or expand its tail arbitrarily', () => {
  const matched = /\/ByteRange\s*\[0\s+(\d+)\s+(\d+)\s+(\d+)\]/.exec(sealed.toString('latin1'));
  assert.ok(matched); const start = Number(matched[1]), end = Number(matched[2]);
  const prepared = Buffer.from(sealed); prepared.fill(48, start + 1, end - 1);
  const digest = createHash('sha256').update(prepared.subarray(0, start)).update(prepared.subarray(end)).digest('hex');
  const ranges = { digest, start, end, inputHash: hash(original), inputLength: original.length };
  checkPreparedCandidate(prepared, original, ranges);
  const changed = Buffer.from(prepared); changed[20] ^= 1;
  assert.throws(() => checkPreparedCandidate(changed, original, ranges), /changed the candidate/);
  assert.throws(() => checkPreparedCandidate(Buffer.concat([prepared, Buffer.alloc(MAX_SEAL_TAIL_BYTES)]), original, ranges), /tail budget/);
  assert.throws(() => checkPreparedCandidate(prepared, original, { ...ranges, start: 1 }), /invalid bounds/);
});
test('Node rejects forged verifier metadata even if the reported PDF hash matches', async () => {
  const metadata = await verifyPdf(sealed, { expectedFingerprint: identity.fingerprintSha256 });
  checkSealVerdict(metadata, sealed, { manifest, fingerprint: identity.fingerprintSha256 });
  assert.throws(() => checkSealVerdict({ ...metadata, certificateFingerprint: 'b'.repeat(64) }, sealed, { manifest, fingerprint: identity.fingerprintSha256 }), /mismatched manifest or certificate/);
  assert.throws(() => checkSealVerdict({ ...metadata, manifest: { ...manifest, documentId: 'swapped' } }, sealed, { manifest }), /mismatched manifest or certificate/);
  const unsigned = Buffer.concat([original, Buffer.from('not a signature')]);
  assert.throws(() => checkSealVerdict({ ...metadata, pdfHash: hash(unsigned) }, sealed, { manifest }), /mismatched verdict/);
});

test('preflight distinguishes invalid PDF input from runtime and certificate configuration failures', async () => {
  const savedPython = process.env.SIGNHERE_SEAL_PYTHON, savedRequired = process.env.SIGNHERE_REQUIRE_PDF_SANDBOX, savedLauncher = process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER;
  const serviceFailure = (error: unknown) => error instanceof Error && !(error instanceof SealInputError);
  try {
    process.env.SIGNHERE_SEAL_PYTHON = join(directory, 'missing-python-runtime.exe');
    await assert.rejects(preflightSealPdf(original, identity), serviceFailure);
    if (savedPython === undefined) delete process.env.SIGNHERE_SEAL_PYTHON; else process.env.SIGNHERE_SEAL_PYTHON = savedPython;
    process.env.SIGNHERE_REQUIRE_PDF_SANDBOX = 'true'; delete process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER;
    await assert.rejects(preflightSealPdf(original, identity), serviceFailure);
    if (savedRequired === undefined) delete process.env.SIGNHERE_REQUIRE_PDF_SANDBOX; else process.env.SIGNHERE_REQUIRE_PDF_SANDBOX = savedRequired;
    if (savedLauncher === undefined) delete process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER; else process.env.SIGNHERE_PDF_SANDBOX_LAUNCHER = savedLauncher;
    await assert.rejects(preflightSealPdf(original, { ...identity, fingerprintSha256: 'b'.repeat(64) }), serviceFailure);
    await assert.rejects(preflightSealPdf(Buffer.from('%PDF-1.7\nbroken PDF data'), identity), SealInputError);
  } finally {
    for (const [name, value] of Object.entries({ SIGNHERE_SEAL_PYTHON: savedPython, SIGNHERE_REQUIRE_PDF_SANDBOX: savedRequired, SIGNHERE_PDF_SANDBOX_LAUNCHER: savedLauncher })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
