# PDF seal engine decision and interoperability spike

Date: 2026-09-24. Implementation scope: local sealing and offline integrity checks. Optional trusted timestamping remains unavailable and fails closed when requested.

## Selected implementation

Signhere uses **pyHanko 0.37.0** for PDF/CMS signing and validation, **pyhanko-certvalidator 0.32.1** for certificate validation primitives, **cryptography 50.0.1** for PKCS12/X.509/key operations, and **asn1crypto 1.5.1** through the maintained CMS implementation. Exact transitive versions and distribution hashes are pinned in `scripts/pdf-seal/requirements.txt`. Python 3.12 was used for the spike. pyHanko, pyhanko-certvalidator and asn1crypto use MIT licenses; cryptography is Apache-2.0 OR BSD-3-Clause.

The implementation deliberately includes a Python runtime in the application image. LibPDF's advertised signing support does not include an implemented signature verifier, and node-signpdf provides signing primitives rather than the maintained PDF/CMS verification needed here. Using one established signing/validation library avoids implementing ASN.1, PDF signature arithmetic or a general revision difference engine. Independent OpenSSL validation provides a second cryptographic implementation in the spike; it is not a substitute for complete independent PDF-reader validation.

## Output profile and trust

The initial `signhere-seal-v1` profile has exactly one invisible platform signature field, `SignherePlatformSeal`, with `/ETSI.CAdES.detached`, SHA-256 and an embedded certificate chain supplied by the signing identity. Local certificates use RSA-3072 and SHA-256; imported RSA >= 2048 and ECDSA P-256/P-384 are supported. RSA-PSS and other algorithms are not part of this initial profile. The signature identifies the installation sealing the completed contract and evidence, not a human participant. It is an approval signature, without DocMDP certification. Existing participant drawings remain in the appendix.

The intended standards target is PAdES B-B. This implementation checks the required digest, content type and signingCertificateV2 attributes and relies on pyHanko's certificate-binding validation. It does **not** claim a full independently certified PAdES conformance assessment simply because a SubFilter is present. B-T, LT and LTA are not supported or advertised. `timestampPolicy: required` is rejected without falling back to an un-timestamped seal.

The verifier requires signature coverage from byte zero to the exact file end, excluding only the exact parsed hex Contents value. It rejects extra fields/signatures/SignerInfos, unsigned tails or later revisions, weak/unsupported keys and digest algorithms, nonzero data after the CMS value, and unsigned CMS attributes. This is deliberately a narrow profile, not a general verdict that other signed PDF formats are forged. No document-directed network fetch is allowed. Revocation status is explicitly `not-checked`.

Integrity and issuer trust are separate. A valid self-signed seal returns `integrity: valid, issuerTrust: unknown` unless the operator/verifier supplied an independently obtained matching certificate SHA-256 fingerprint. A wrong pin fails. Certificate validity at current time is a separate result; historical integrity can remain valid after expiry. A platform seal does not establish participant identity or consent; `identityVerified` and `qualifiedSignature` remain false. No trusted signing time is available.

## Evidence commitment

A small, uncompressed catalog stream named `/SignhereSeal` is added before sealing and covered by the PDF signature. It carries the schema, evidence schema, installation and document IDs, detached evidence digest, prepared PDF digest, final signing checkpoint, actual signer certificate fingerprint and frozen protection policy. The signing worker checks the public identity against this manifest; the final verifier checks it against the actual CMS certificate and the caller's expected manifest before publication.

Detached evidence is hashed as exact bytes. Optional evidence/prepared PDF inputs are compared to the protected commitments; evidence JSON rejects duplicate keys, BOM, unpaired Unicode surrogates and non-finite numbers. This primitive reports `digest-matched`; semantic event/recipient/intent binding belongs to the outer evidence verifier. Missing detached evidence is `not-supplied`, never complete evidence verification. No IP address, email, nonce or private evidence body is copied into the public manifest.

## Separate parsing from key access

`server/seal.ts` exposes:

- `createLocalIdentity(directory, installationId)`: creates `identity.p12` and `certificate.pem` using fsynced staging files and exclusive atomic publication; never overwrites a key.
- `inspectIdentity(p12File, passwordFile?)`: returns public metadata only and checks key/certificate correspondence, supported algorithms and signing usage.
- `preflightSealPdf(candidate, publicIdentity)`: performs the strict public preparation stage before invitations; no private key is needed.
- `signPdf(bytes, manifest, { p12File, passwordFile?, expectedFingerprint, timestampPolicy? })`: returns sealed bytes and verified metadata.
- `verifyPdf(bytes, { expectedFingerprint?, expectedManifest?, evidenceCore?, preparedPdf? })`: verifies a portable PDF without database/server access.

The process sequence is `prepare -> cms -> verify`. The public `prepare` worker parses the PDF, adds the manifest and signature placeholder, and returns bounded digest/range information. The separate key-holding `cms` worker does not parse PDF objects: it checks exact placeholder bounds/content, recomputes the covered SHA-256 digest from the bounded file, loads the pinned identity and delegates CMS construction to pyHanko. Each stage has a fresh, separate 0700 directory. Node captures prepared output by a bounded descriptor read with symlink/hardlink and stability checks, validates the exact candidate prefix and a 96 KiB incremental tail budget, and copies it to a private CMS directory never exposed to either parser. The key worker independently rechecks the Node-supplied candidate hash/length and returns the sealed output hash. Node captures those bytes before creating a separate verifier-only copy. Verifier metadata must match the requested manifest/fingerprint and the already captured bytes.

This separation protects key confidentiality and prevents the verifier from replacing the published file. It does **not** establish signing integrity against a compromised PDF processor: a permitted incremental tail can still shadow page objects. The finalization/preparation/validation processors remain trusted for document rendering and PDF semantics. The source digest and exact prefix checks do not prove unchanged display; a second validator and rendering regression corpus remain necessary.

The wrapper provides a fixed-executable `SIGNHERE_PDF_SANDBOX_LAUNCHER` hook for prepare/verify, with arguments `job-directory python-path engine-path operation`. `SIGNHERE_REQUIRE_PDF_SANDBOX=true` fails closed without the launcher. Parsing workers receive no key paths or secrets. Python's Linux limits cap address space at 768 MiB, CPU at 30 seconds and output file size. Node uses isolated Python imports (`-I`), caps process time/output, kills the full process group/tree and awaits exit before removing the job directory. It recomputes the exact returned PDF hash and candidate prefix after validation. The deployment launcher must also insert `-I`. These resource limits alone are **not** a filesystem/network sandbox; actual production isolation depends on the deployment launcher and its supported-host checks. Windows development calls without that launcher are not a production isolation claim.

Generated keys are unencrypted PKCS12 protected by the private directory/file access policy (0700/0600 on Unix), never stored in the database. The database marker, exclusive initialization lock, recovery/rotation and public certificate history are the key manager's responsibility. Admin-mounted PKCS12 can use a password file; the file is UTF-8/binary password bytes with trailing CR/LF removed. Private keys/passwords are not written to IPC stdout, command-line arguments or manifests.

## Verified behavior

A generated one-page PDF was signed through the actual interrupted-signing path. pyHanko validated the output and OpenSSL's `cms -verify -binary -noverify` independently verified the extracted CMS against the exact covered bytes. `-noverify` intentionally checks cryptographic integrity without pretending the locally generated issuer is externally trusted. The original candidate PDF remained an exact byte prefix of the signed file.

Eleven Node integration tests exercise the production wrapper: exact prefix/full-file checks, matching evidence/original/manifest, unknown and wrong issuer pins, changed PDF content, appended unsigned bytes, mismatched evidence, exclusive key creation, rejection of already signed inputs, required timestamp rejection and duplicate JSON evidence. Eight Python tests additionally exercise an encrypted imported ECDSA key, expiry, wrong/missing password, nonzero CMS padding, mutation between preparation and key operation, placeholder overflow and strict JSON edge cases, private candidate/tail bounds and owner-password encryption. Public preflight is also tested with the private key temporarily unavailable, unsigned signature fields and broken xrefs.

The existing Node appendix builder rewrites the prepared source PDF. Consequently, signing preserves the exact appendix candidate, **not** the earlier prepared source serialization. The exact prepared PDF is included separately in the portable package and its digest is protected by the seal. A prefix alone cannot prove unchanged visual rendering; source-page rendering regression tests and the trust in appendix generation remain relevant. Incremental appendix assembly was not adopted without a proven safe writer/renderer path.

The bundled Poppler 26.07.0 reader loaded the sealed fixture as a one-page A4 PDF without JavaScript/encryption. Rendering the exact candidate and signed result at 96 DPI produced byte-identical PNGs (SHA-256 `612e5911a57c2cfc5f73dbe6f70f294ea0e3fd9c550599f84a9d9b434e872fe6`). Its signature API was also tried, but this bundled build returns `NOT_VERIFIED` and omits `pdfsig`/a usable crypto backend; that attempt is not counted as independent PDF signature validation.

Required release follow-up: run an independent PDF signature reader with a working crypto backend (e.g. Poppler pdfsig/Acrobat) and relevant structural profile checks in addition to the successful OpenSSL CMS test, verify source-page rendering regressions, and pass Docker/host-isolation integration tests on a supported host. No full PAdES conformance or universal Acrobat green check is claimed by this spike.

## Running tests and standalone primitive

```powershell
python -m venv .local/seal-python
.local/seal-python/Scripts/python.exe -m pip install --require-hashes -r scripts/pdf-seal/requirements.txt
npx tsx --test server/seal.test.ts
.local/seal-python/Scripts/python.exe scripts/pdf-seal/test_engine.py
```

Linux uses `.local/seal-python/bin/python`, or `SIGNHERE_SEAL_PYTHON` points to the deployed interpreter. `engine.py verify` accepts one JSON request on stdin:

```json
{"input":"/absolute/path/completed.pdf","expectedFingerprint":"independently-obtained-sha256-fingerprint","evidenceCoreFile":"/absolute/path/evidence-core.json","preparedPdfFile":"/absolute/path/original.pdf"}
```

Only `input` is required; omit the fingerprint for unknown-issuer verification. The machine result is `{ "ok": true, "result": ... }`; failures return exit 1 with a bounded error. The portable package's Node verifier supplies the human-facing interface and evidence semantics.

Primary references: [pyHanko signing](https://docs.pyhanko.eu/en/latest/lib-guide/signing.html), [pyHanko validation limitations](https://docs.pyhanko.eu/en/latest/cli-guide/validation.html), [pyHanko release](https://pypi.org/project/pyHanko/0.37.0/), [LibPDF](https://github.com/libpdf-js/core), [node-signpdf](https://github.com/vbuch/node-signpdf).
