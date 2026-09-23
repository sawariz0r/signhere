# Signhere sealing and independent verification plan

Status: proposal for the next implementation phase; awaiting Claude Opus 5.5 critique. No sealing implementation is included in this planning task.
Date: 2026-09-24.

## Decision and scope

Keep self-hosting to an application and PostgreSQL, with no required Signhere account, Redis, paid certificate, identity provider, or timestamp service. New installations generate a unique local sealing identity. The open-source core supports importing an operator's document-signing certificate and configuring an external RFC 3161 timestamp service. BankID signing is a later signing-method adapter; it will provide participant authorization evidence bound to the frozen document, not replace the platform seal.

Implement a trustworthy local seal, independently verifiable evidence, durable finalization and essential certificate lifecycle before describing this release as protected by PDF digital signatures. Trusted timestamping is a separate optional milestone; timestamped/PAdES B-T claims require that milestone to pass. Draw remains self-asserted consent with a personal link. A platform certificate, even CA-issued, cannot establish that the people named in an operator's records consented. A hostile operator with the sealing key can issue another seal. Independently retained copies, trusted timestamps and later provider-signed participant evidence address distinct threats.

No historical completed PDF, recipient assignment, signature, or audit event will be rewritten. Existing unsealed documents stay explicitly identifiable as legacy evidence.

## Current implementation facts

- React/TypeScript interface, Express/Node application, PostgreSQL blobs and events; Docker Compose has two services.
- Raw uploaded PDF and the prepared signing PDF are retained when flattening changes bytes. Signatures bind prepared originalHash.
- A checked sender checkbox now creates a separate immutable recipient ID even when an entered party has the same email. That senderRecipientId is frozen into the creation event.
- Draw signatures include exact consent, claimed and assigned names, drawing, document hash and observed request metadata.
- The final signer currently causes PDF generation inside the document transaction; PDF failure rolls back that final signature. There is no durable finalization job.
- Current states are pending/completed/cancelled; database triggers and schema-v1 verifier enforce the existing event order and immutability.
- PDFs contain readable signature appendices and a hash-chain checkpoint, but no private-key PDF seal or independent timestamp. The JSON verifier checks internal consistency only.
- PDF workers currently limit JS heap and time, not native/WASM total memory. Production process isolation remains unfinished.
- Docker does not work on this development machine. Real local PostgreSQL and native processes are available. Actual Docker image validation must run on a working CI/host before release.

## Security and trust model

Distinguish four results in exports and verification: byte/signature integrity, issuer trust, trusted-time evidence, and participant identity/authorization assurance. These must never collapse into one universal green verified badge.

A valid seal from an unknown certificate means mathematically intact, issuer not trusted. Accept an issuer only through explicit trusted roots or an independently established certificate/key fingerprint. An embedded self-signed certificate or a key URL supplied by the document is not its own trust anchor. Retain old public certificates and references for historical checks. Explicit trust configuration and network requirements must be visible to the verifier.

A trusted timestamp proves existence of the covered value by the indicated time, not exact human signing time or consent. A local self-signed seal has no independent time evidence. A BankID login is not document approval; the future integration must use the signing operation and validate its document-bound evidence. BankID API credentials are separate from both HTTPS and PDF sealing certificates.

## 1. Specify evidence and signing boundaries first

Keep SigningMethod (draw now, BankID/Freja later), PdfSealer, TimestampProvider and EvidenceVerifier separate. Core code freezes content/recipients, validates transitions, constructs payloads and owns persistence; plugins cannot edit other recipients or declare an envelope completed.

Define a versioned SigningIntent containing application/domain separator, installation ID, document/revision ID, recipient ID, prepared PDF SHA-256, method/version, consent version and exact wording, and a unique server-generated attempt/nonce. Retain exact canonical UTF-8 bytes as well as their digest. Method-specific consent must not claim a drawing for a future BankID-only signature. Existing consent and v1 hash canonicalization remain unchanged for old records.

Specify one canonical format for new evidence (evaluate RFC 8785 with strict JSON bounds) and share test vectors across implementations. Do not silently recanonicalize old audit events. Establish a schema-v2 evidence package without claiming legal signature qualification.

Freeze a minimal evidence core through the last accepted signature: document/source hashes, immutable recipient/sender assignments, exact signing intents/consents, method evidence, and signing checkpoint. Bound its size and preserve provider proof as exact bytes or immutable separately hashed objects. Privacy-minimize the content exposed to every PDF recipient; decide explicitly which request metadata stays in the restricted JSON export.

The evidence core must exclude the completed PDF hash and post-seal completion event. Put the core or its digest plus unambiguous schema/checkpoint into the bytes covered by the PDF signature. Produce the final sealed PDF, hash those final bytes, and then store the completion event/outer export. This avoids embedding a PDF's own full-file hash and cryptographically binds separately exported evidence to the seal.

Keep confidential evidence detached if necessary: the signed PDF commits to its exact digest, while the authorized evidence bundle carries the bytes. The verifier must distinguish PDF-only integrity from full evidence verification and must reject detached evidence that does not match the protected commitment.

## 2. Introduce durable finalization before remote services

Use PostgreSQL for the job; no additional deployment service. The app can run a small bounded job runner with database leases. Add finalizing to the document state machine and retain operational attempt/retry/failure data in a separate jobs table.

In the final signature transaction, persist that person's accepted signature and event, freeze the signing checkpoint, retain and revalidate the protection policy already fixed at creation, transition pending -> finalizing, and enqueue one job using a unique document/revision key. Commit promptly. Future BankID completion cannot be undone by a later PDF/TSA failure; draw should follow the same rule.

Outside a document transaction, claim the job with a lease and generation/fencing token, build the evidence-bound candidate PDF, seal it, optionally timestamp it, and independently validate the exact output. Persist immutable attempt inputs and candidate results needed to resume after process failure. No TSA, HSM, provider network operation or long PDF work may run while holding a document row lock.

Publish completed bytes, their digest, seal metadata and the completion event in one short transaction that rechecks document state, signing checkpoint, policy and current lease token. At most one artifact is published. External requests might be repeated after an ambiguous network failure; do not promise exactly-once TSA/signing-provider execution. Attempts remain recorded, and stale workers cannot commit.

Freeze the protection policy at creation for new documents. Select and persist the actual sealing key/certificate version when a finalization attempt starts; never silently switch it mid-attempt. Define explicit recovery if a queued key becomes unusable. Cancellation is allowed only while pending; once all approvals are accepted, finalization errors preserve those approvals and expose retry/action-needed state. Operational retries must not mutate the frozen evidence core or append events into its checkpoint.

Update database constraints/triggers intentionally for these transitions. Migrate old records without changing their policy, hashes or events; legacy pending documents retain the old behavior/label or can be cancelled and recreated by their owner. New schema-v2 documents cannot complete without a verified seal. Define API compatibility so clients understand that accepted signature and fully finalized PDF are different states.

## 3. Add local keys and standard PDF sealing

Run a small interoperability spike before choosing the signing library. Evaluate maintained, license-compatible implementations (including @libpdf/core and @signpdf components), and record exact versions, supported algorithms, signing/validation gaps and runtime needs. Do not implement ASN.1/CMS/PDF signature mathematics ourselves. Changing a PDF SubFilter alone is not evidence of complete PAdES conformance.

Target independently checked PAdES B-B for local sealing and B-T when a timestamp is configured. Do not advertise LT/LTA until revocation material, validation rules and archival renewal are implemented and tested. Use an independent validator such as pyHanko and an external PDF reader, plus applicable conformance checks; these may be test tools rather than new required runtime services. If a Node-only runtime cannot safely implement required validation, revisit the bundled runtime rather than shipping a weak verifier.

Generate a unique private key and self-signed certificate once during explicit instance provisioning. Persist them in a dedicated protected key directory/volume, separate from document/database backups and never in the image, repository, logs or database rows. Use restrictive permissions and support a mounted external secret. Do not regenerate silently when a previously initialized instance has lost its keys. A clean-install identity marker and key identifier must survive restarts and identify mismatched restored data/key sets.

Provide a public certificate/fingerprint export, explicit rotation, expiry warnings, key/certificate matching checks and encrypted offline backup guidance. Retain public certificates, algorithms, fingerprints and validity periods used for old documents. Restoring verification of old PDFs should not require old private keys. Fail closed for expired/missing/unusable signing keys; distinguish historical cryptographic integrity from current certificate trust/validity.

First support local PKCS#12/PFX or equivalent PEM secret import; define the narrow sealer interface for future HSM/remote signing, without implementing remote adapters now. Configuration belongs to the deployment administrator, not every signer. Keep the default user flow unchanged.

Treat PDF parsing and private-key access as separate boundaries. Isolate hostile parsing with enforced process/OS memory and execution limits; give parsing workers no sealing secrets or unnecessary network access. Merely clearing environment variables or using a same-user child process is not a security sandbox. The chosen deployment isolation must preserve the simple two-service setup or explicitly justify any additional container. Scope and enforce what the signing process itself parses; a trusted-looking intermediate PDF is not automatically safe.

## 4. Add independent verification and portable exports

Extend the CLI to validate PDF ByteRange/CMS integrity, signature coverage and protected evidence commitments, then validate the evidence core/outer export and participant bindings. Reject unexpected incremental modifications and unsigned trailing revisions; do not validate only an earlier signed revision while showing a modified current document. Future permitted archival updates require explicit rules rather than a blanket allow.

Support explicit certificate fingerprints/trust roots, clear unknown-issuer results, and separately validated RFC 3161 tokens. Never trust certificate subjects, signature appearance images or server-claimed assurance flags as proof. Avoid arbitrary network fetches from uploaded certificate/PDF URLs; network revocation fetching must have an explicit policy, SSRF protection and bounded requests.

Keep /verify public. Add local cryptographic verification without requiring a match in the originating installation's database; if browser validation cannot safely support the chosen format, clearly separate local checks from the standalone verifier and optional server lookup. Server lookup remains an additional known-document check. Files should not be uploaded for verification by default, and no recipient details should leak through public hash lookup.

Offer a portable verification package: exact prepared PDF, final sealed PDF, evidence core/export, certificate chain and available timestamp/revocation evidence; include the raw upload when conversion needs separate proof. Generate the portable archive on demand from immutable stored artifacts; a second export queue is unnecessary. Support authenticated owner export and scoped, renewable access for authorized participants, with retention rules beyond a short-lived invitation link. Permanent participant accounts are not required. Preserve method assurance labels; a platform seal never upgrades draw to verified identity.

## 5. Optional timestamping and production operations

Expose explicit timestamp policies: off, or required with an administrator-configured provider. For required mode, no un-timestamped success fallback. Timeouts, invalid responses or rejected trust chains keep finalization pending/failed for retry. Verify message imprint, algorithm, nonce when used, TSA signature/chain/EKU and time before accepting the result. Persist exact returned proof; send only the required digest to the service.

Use bounded timeouts, retries/backoff and observability that avoids documents, tokens or key material. Validate external certificate/TSA configuration before enabling it. Network endpoints are privileged deployment settings and need SSRF-safe request handling. Actual retention of OCSP/CRL and archival validation is a separately tested milestone, not an implication of merely receiving a timestamp.

Maintain minimal application DML database privileges separately from migrations. Exercise key+database backup/restore, lost-key behavior, wrong-key restores, certificate expiry/rotation and interrupted upgrades. Run clean Docker start, restart/persistence and restore checks on a working host/CI; do not claim Docker validation from this machine.

## Implementation order and exit criteria

| Milestone | Work | Required evidence before proceeding |
| --- | --- | --- |
| A | SigningIntent/evidence-v2/protection-policy specification, library/validator and isolation spike | Published test vectors; no hash cycle; independent verifier accepts sample self-signed PDF with pinned trust and rejects altered content/evidence; dependency/license decision and feasible process/key isolation documented. |
| B | PostgreSQL finalization job/state machine and schema migration | Final signature remains accepted on worker failure; restart, concurrent last signatures, duplicate callbacks/retries, stale leases and cancellation races cannot lose consent or publish twice; old evidence still verifies byte-exact. |
| C | Local key provisioning and recovery, standard seal, portable package and verifier | Fresh setup needs no external provider; keys persist; missing/wrong-key restore, backup, expiry and basic rotation checks pass; unknown issuer never appears trusted; final PDF/evidence alterations fail; source pages/signatures visually preserved; local and external certificate engine fixtures validated independently (operator BYO setup remains D). |
| D | Operator BYO certificate configuration and optional required TSA | Invalid certificate setup fails clearly; outages never silently downgrade; wrong TSA imprint/nonce/cert rejected; timestamped output validates independently. |

Milestones A-C form the local-sealing feature scope. A deployable self-hosted release also requires working Docker CI, persistent key/data restore checks, enforced hostile-PDF isolation, restricted runtime database privileges and the existing security/legal review, retention and authentication release gates. These gates do not wait for D; until they pass, A-C is a local development preview. D must pass before advertising external timestamping. Browser cryptographic verification, rich certificate-management UI, automatic renewal and remote key adapters can follow the first CLI-verifiable release. No BankID or Freja integration, arbitrary plugin marketplace, mandatory HSM, Redis, automatic email delivery, or recurring archival-renewal service is part of this immediate implementation plan.

## BankID work reserved for later

Implement the signing operation, not login-as-consent. Supply clear document context for the human and bind the exact SigningIntent/document digest to provider-signed data. Persist and validate asynchronous attempts, provider transaction references, returned signed evidence, certificate/status evidence and the exact identity claim against the intended participant. A successful browser return does not authorize completion. Keep future method-specific evidence/consent and assurance separate from platform sealing. Provider configuration/agreements remain operator choices; do not introduce a required central Signhere service.

## Review questions for Claude

1. Which steps are missing, unsafe, or overengineered for the small self-hosted target?
2. Is the evidence core -> sealed PDF -> completion export sequence complete and verifiable without circular dependencies?
3. Are lease/fencing, frozen policy/key versions, cancellation, failed finalization and legacy migrations defined coherently?
4. Where does self-signed sealing actually improve security, and where do trusted certs/TSA/BankID still leave operator trust?
5. What must ship with the local-sealing release versus wait for TSA/BankID? Suggest a smaller safe scope if needed.
6. What adversarial and interoperability acceptance tests are missing? Identify library/runtime assumptions that require a spike rather than assertion.

## Primary references checked

- [DocuSeal local certificate generation](https://github.com/docusealco/docuseal/blob/47c090e1f1548be0d8ab58347c83363539e8b5b6/lib/generate_certificate.rb) and [optional RFC 3161 configuration](https://www.docuseal.com/faq/how-do-i-configure-rfc-3161-timestamp-server).
- [Documenso platform signing model](https://docs.documenso.com/docs/concepts/signing-certificates) and [certificate configuration](https://docs.documenso.com/docs/self-hosting/configuration/signing-certificate).
- [OpenSign self-hosted certificate setup](https://docs.opensignlabs.com/docs/self-host/docker/run-locally/).
- [ETSI PAdES baseline standard](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf), [RFC 3161](https://www.rfc-editor.org/info/rfc3161/), [Adobe trust services](https://helpx.adobe.com/ie/acrobat/kb/trust-services.html).
- [BankID signing API](https://developers.bankid.com/api-references/auth--sign/sign).
- [LibPDF capabilities and current verification limitation](https://github.com/libpdf-js/core), [node-signpdf](https://github.com/vbuch/node-signpdf), [pyHanko validation and its conformance-check limitations](https://docs.pyhanko.eu/en/latest/cli-guide/validation.html).
