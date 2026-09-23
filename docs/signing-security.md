# How signing and sealing are secured

This describes the implemented `signhere-seal-v1` profile for new evidence-v2 documents. Signhere records a Simple Electronic Signature (SES) using a personal link and a drawn signature, then applies a cryptographic seal with the installation's certificate. A sender who selects “Jag ska också signera” is a separate required participant, with their own link and approval record.

The participant approves the document; the installation's private key seals the resulting PDF and evidence commitment. Participants do not receive personal cryptographic certificates. BankID and Freja are not implemented, and the drawing is not biometric or e-ID identity verification.

Existing evidence-v1 documents keep their original format and completion path. They are not retrospectively sealed. This document is an engineering description, not a legal opinion or a security certification.

## 1. Freeze the document before inviting anyone

1. The server inspects and calculates SHA-256 of the uploaded PDF bytes.
2. Supported interactive content is automatically flattened before signing. The unmodified upload, its hash and conversion metadata are retained when conversion occurs.
3. The prepared PDF is stored as the immutable signing copy. API and export names `original` / `originalHash` refer to this **prepared copy**; `uploaded.pdf` refers to the pre-conversion source when different.
4. Creation performs a public-certificate dry run through appendix generation and seal preparation before issuing links. This catches deterministic preparation failures; it cannot guarantee later resources will remain available.
5. The document, participants, method versions and protection policy become immutable. Changing them requires a new transaction and new approvals.

Every participant views and approves the same prepared SHA-256. The current document UUID is also the transaction/revision identifier. The raw upload hash is bound through the creation evidence when preparation changed the file.

The final PDF writer adds certificate/evidence pages and reserializes the prepared PDF. It does not embed the exact prepared file bytes. Those exact bytes remain available separately in the verification package, and their hash is protected by the final seal. The cryptographic binding alone does not prove that different PDF renderers display identical pages.

Sources: [upload and PDF preparation](../server/pdf-engine.ts), [creation route](../server/app.ts).

## 2. Give each participant a separate capability

Each link contains a token from `randomBytes(32)`: 256 bits of cryptographic randomness. PostgreSQL stores its SHA-256 hash against one participant and one document, not the plaintext token. Token lookup determines the accessible participant/document; changing a document ID does not grant access.

The token is placed after `#` in the signing URL and submitted in API bodies. Fragments are not part of the initial HTTP URL. Application logs and audit records do not record the raw token; reverse proxies, telemetry and support tooling must also avoid collecting request bodies or copied links.

Unsigned links expire after 7 days by default. `SIGNHERE_SIGNING_LINK_TTL_DAYS` accepts 1–365 days for new or rotated links. A team user can invalidate an unsigned link by rotating it, or cancel a pending document. Whoever possesses a live link can use it: this is not independent verification of the person's identity or control of the assigned email account.

After acceptance, the original link remains usable for a read-only receipt and completed-PDF download for 30 days. An exact repeated submission returns the saved result; a different submission is rejected. Signing authority is consumed, but the token is **not destroyed**. Separate completed-copy links also expire after 30 days and can be revoked by the team. The original accepted receipt capability has no separate revocation endpoint.

Sources: [token generation](../server/security.ts), [capability endpoints](../server/app.ts).

## 3. Bind explicit consent to the participant and exact PDF

Before links are issued, Signhere stores an immutable, canonical UTF-8 signing intent per participant. It contains:

- Schema and domain (`signhere/document-approval`), installation ID, document/revision ID and recipient ID.
- Prepared PDF SHA-256 and signing method ID/version.
- Exact consent text/version and a fresh 256-bit nonce.

The signing screen uses that frozen consent, even if application defaults later change. Consent starts unchecked. A successful submission must include affirmative acceptance, the matching consent version, prepared document hash and intent hash, together with the claimed name and validated drawing strokes.

The server assigns one UTC instant to consent acceptance and signature acceptance because both are submitted atomically. It records the assigned name/contact, claimed name, drawing, method/version, `authenticationMethod: personal_signing_link`, exact intent and consent, document/transaction ID, observed IP and bounded user-agent. The draw plugin explicitly records `identityVerified: false` and self-asserted assurance.

The IP and user-agent are observations, not identity proofs. The first `recipient.viewed` event records a successfully opened signing session; it does not prove that the participant read every page or separately record PDF delivery.

Sources: [intent and evidence format](../server/evidence.ts), [draw plugin and consent](../server/plugins.ts), [signing API](../server/app.ts), [signing UI](../web/sign.tsx).

## 4. Commit accepted approvals and preserve them through failure

Acceptance uses a PostgreSQL transaction and a per-document row lock. Cancellation, link rotation and simultaneous approvals coordinate through the same lock. The participant's saved result and audit event commit together. A submission hash supports exact retries without adding a second approval.

Audit events are ordered and SHA-256 hash linked. Each hash covers the document ID, sequence, type, UTC time, event data and previous hash. V2 events include random nonces. Database triggers reject ordinary editing/deletion of events, document replacement, changed participant assignments and changes to accepted signatures.

The last required approval freezes the exact evidence-core bytes: document metadata, all participants and their intents, and every event through the final approval checkpoint. The core has its own random nonce. Its digest later becomes part of the protected PDF manifest.

That same transaction moves the document to `finalizing` and enqueues a durable PostgreSQL job. A worker builds the PDF outside the document transaction. Expiring leases, generation checks, retry limits and immutable attempt history prevent an expired worker from publishing over a newer attempt. A failed worker preserves all accepted approvals; participants do not need to sign again.

A job pins its sealing identity. Publication rechecks the frozen evidence, checkpoint, policy and active lease, then commits final PDF bytes, final SHA-256, completion event and job completion together. Changing a failed job's pinned certificate requires an explicit administrative recovery action.

These database guards depend on using the restricted runtime role. A database owner or privileged operator can bypass them; a hash chain alone cannot prevent that operator from rewriting an entire chain.

Sources: [database guards and event hashing](../server/db.ts), [frozen evidence](../server/evidence.ts), [durable finalization](../server/finalization.ts).

## 5. Seal the completed PDF and its evidence commitment

The candidate PDF contains the prepared document pages and signing appendices with participant details, consent, method, personal-link authentication, UTC signing time, transaction ID and prepared-document hash. It explicitly states that identity was not verified through electronic identification.

The seal uses maintained pyHanko/CMS libraries and SHA-256. A fresh installation generates its own RSA-3072 private key and self-signed X.509 certificate. An administrator may instead supply supported PKCS#12 certificate/key files. The website's TLS certificate, this installation seal certificate and future BankID evidence have separate purposes.

The PDF has one `SignherePlatformSeal` signature with `/ETSI.CAdES.detached`. Its protected catalog manifest binds:

- Profile/evidence schema and installation/document IDs.
- SHA-256 of the exact frozen evidence core and exact prepared PDF.
- Final approval checkpoint sequence/hash and sealing-certificate SHA-256 fingerprint.
- Frozen timestamp policy, currently `off`.

The verifier requires the PDF `ByteRange` to cover the entire file except the signature's own `Contents` value. It validates that excluded value, CMS cryptography and signed certificate binding, and rejects unsigned tails/revisions, additional signature fields and unexpected unsigned CMS attributes. This is a deliberately constrained Signhere profile, not a formal PAdES conformance claim.

After sealing, Signhere verifies the captured output before publishing it. It calculates and stores SHA-256 of the **exact final sealed PDF** externally. A PDF cannot contain its own complete-file hash without a circular dependency. The later `document.completed` event and outer export metadata are therefore consistency checks outside the earlier sealed evidence core; the offline verifier reports that distinction.

Sources: [sealing wrapper](../server/seal.ts), [boundary checks](../server/sealing/boundaries.ts), [PDF/CMS engine](../scripts/pdf-seal/engine.py).

## 6. Verify independently of the running platform

The public `/verify` page hashes a selected PDF in the browser and looks up that hash on the current installation. The file is not uploaded by this check. A match means it matches that server's completed record; it is not independent cryptographic verification or independent issuer trust.

An authorized team account can download a portable verification ZIP containing the completed PDF, exact prepared PDF, raw upload when different, evidence JSON/core, public certificate, verifier source and pinned Python dependencies. Participant receipt/copy links deliver the PDF only, without the full private IP/user-agent evidence of other participants.

To verify an extracted v2 package, use Node.js 22+ and Python 3.11+. Inspect the supplied verifier code or obtain a trusted copy independently. Set up an isolated Python environment; these example commands use a POSIX shell:

```sh
python3 -m venv .verify-python
.verify-python/bin/python -m pip install --require-hashes -r pdf-seal/requirements.txt
export SIGNHERE_SEAL_PYTHON="$PWD/.verify-python/bin/python"
node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf
# If uploaded.pdf is present, include it as the fourth file argument:
node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf uploaded.pdf
# Add explicit issuer trust using a fingerprint obtained independently:
node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf --trust-fingerprint CERTIFICATE_SHA256
```

On Windows, use the virtual environment's `Scripts/python.exe` and set `SIGNHERE_SEAL_PYTHON` to its absolute path. The fingerprint argument is the certificate's 64-hex-character SHA-256 value, not the PDF hash. Include `uploaded.pdf` before the option when also verifying the raw source.

The verifier checks PDF cryptography/coverage, the evidence commitment and full participant/intent/audit bindings without contacting Signhere. Dependency installation may require network access; verification itself does not.

| Exit code | Meaning |
| --- | --- |
| `0` | Integrity/evidence passed and the explicitly trusted certificate fingerprint matched. |
| `3` | Integrity/evidence passed, but the issuer is unknown because no fingerprint was pinned. |
| `1` | Verification failed. |

A fingerprint bundled with the same document cannot authenticate itself. Obtain and retain it through an independently trusted channel. `/.well-known/signhere-sealing.json` publishes the current public certificate and fingerprint for discovery, but trusting that same server alone is not an independent trust decision. The verifier reports certificate validity at verification time; it does not check revocation or establish validity at a trusted historical signing time.

Sources: [portable package](../server/verification-package.ts), [offline verifier](../scripts/verify-sealed-evidence.mjs), [evidence consistency checks](../scripts/verify-evidence.mjs).

## 7. Protect the installation and its sealing authority

Private key files live outside database records and image layers, in the persistent `/keys` volume in Docker. Linux ownership and permission checks require private directories and application-owned secret files without group/other permissions. Generated PKCS#12 keys are not password encrypted: storage permissions, host security, disk encryption and encrypted backups protect them. Imported certificate passwords are supplied through files, not literal command arguments.

Database identity markers, exclusive provisioning and certificate fingerprints prevent accidental silent replacement of an existing installation identity. Missing, mismatched or expired keys stop new sealing; historical read/download access remains available. Explicit rotation/recovery retains public certificate history. Preserve old independently trusted fingerprints for historical verification.

PDF parsing and key-bearing CMS signing run in separate processes and private job directories. The Linux image requires the Landlock/seccomp launcher for parser operations, restricting accessible files, network/process operations and inherited environment/descriptors. The key-bearing stage performs bounded CMS work without parsing PDF structures. Time/output/concurrency limits and container resource limits reduce exhaustion exposure.

Parser isolation protects key confidentiality; it does not prove that a compromised PDF transformer preserved the visible contract. The transformation pipeline remains part of the signing-integrity trust boundary. This boundary does not protect the key from the parent application, its administrator or a compromised host. Windows development lacks the Linux parser sandbox. Docker/Linux execution and independent security review remain release checks; static inspection and Windows tests do not establish those guarantees.

Public deployments require HTTPS, an accurately configured public origin and trusted reverse-proxy ranges. The app uses same-origin checks on mutations, JSON-only requests, security headers, rate limits and bounded bodies. Accounts use scrypt password hashes and hashed session tokens; HTTPS session cookies are Secure, HttpOnly and SameSite=Strict. Authenticated document/evidence access is team scoped.

Fresh Docker installations use separate migration and restricted runtime database roles. Supplying migration credentials to the same application container is still a limitation against full application compromise. Existing volumes need an explicit role/ownership upgrade; changing a password does not remove old owner privileges.

Back up the database, key volume and deployment configuration as a coherent encrypted pair, keep copies off-host and test restoration. Database records contain the PDFs and private evidence; a database-only backup cannot restore the same installation's future sealing authority. Names, contacts, signatures, IPs and user-agents are personal data: restrict evidence sharing and set appropriate retention/access policies. See [deployment, key rotation and recovery](deployment.md) for commands and operational details.

## Trust limits and future signing methods

A valid seal demonstrates integrity under the signing certificate. With an independently pinned fingerprint, it also ties that artifact to the expected installation key. It does not establish who physically drew a signature, prove that a document was read, provide trusted time, or stop someone controlling the installation/key from issuing another valid record. Independently retained PDFs, evidence and fingerprints are useful records outside that operator's control.

The current profile has no trusted timestamp, revocation checking, qualified-signature claim or automatic public certificate trust. Requesting required timestamping fails closed instead of silently weakening the policy. These properties are not supplied by the default self-signed certificate or by the drawn signature.

Future BankID/Freja methods must bind verified provider evidence to the participant, transaction and exact prepared hash. The versioned plugin context and frozen intent provide that foundation; provider integration, asynchronous state, authenticated callbacks and replay protection remain to be implemented. Provider evidence and the installation PDF seal will remain distinct layers.
