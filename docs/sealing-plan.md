# Signhere sealing and independent verification plan

Status: revised proposal after a completed Claude Opus 5.5 critique and independent scope review. The critique reviewed the earlier draft; the dispositions below describe our subsequent decisions. Implementation was authorized subsequently. This document retains the target design; see the implementation review and deployment notes for delivered scope and outstanding validation.

Review: [Claude critique and scope](reviews/2026-09-24-claude-sealing-critique.md).
Date: 2026-09-24.

## Decision and scope

Keep self-hosting to an application and PostgreSQL, with no required Signhere account, Redis, paid certificate, identity provider, or timestamp service. Fresh installations automatically generate a unique local sealing identity on first boot; no certificate command is required for the default setup. The planned open-source core will support importing an operator's document-signing certificate and configuring an external RFC 3161 timestamp service. BankID signing is a later signing-method adapter; it will provide participant authorization evidence bound to the frozen document, not replace the platform seal.

Implement a trustworthy local seal, independently verifiable evidence, durable finalization and essential certificate lifecycle before describing this release as protected by PDF digital signatures. Trusted timestamping is a separate optional milestone; timestamped/PAdES B-T claims require that milestone to pass. Draw remains self-asserted consent with a personal link. A platform certificate, even CA-issued, cannot establish that the people named in an operator's records consented. A hostile operator with the sealing key can issue another seal. Independently retained copies, trusted timestamps and later provider-signed participant evidence address distinct threats.

No historical completed PDF, recipient assignment, signature, or audit event will be rewritten. Existing unsealed documents stay explicitly identifiable as legacy evidence.

## Current implementation facts

- React/TypeScript interface, Express/Node application, PostgreSQL blobs and events; Docker Compose has two services.
- Raw uploaded PDF and the prepared signing PDF are retained when flattening changes bytes. Signatures bind prepared originalHash.
- A checked sender checkbox now creates a separate immutable recipient ID even when an entered party has the same email. That senderRecipientId is frozen into the creation event.
- Draw signatures include exact consent, claimed and assigned names, drawing, document hash and observed request metadata.
- The final signer currently causes PDF generation inside the document transaction; PDF failure rolls back that final signature. There is no durable finalization job.
- Current states are pending/completed/cancelled; database triggers and schema-v1 verifier enforce the existing event order and immutability.
- Final PDF generation currently loads the prepared PDF, appends evidence pages and serializes it; it does not rasterize all original pages. PDFs contain readable signature appendices and a hash-chain checkpoint, but no private-key PDF seal or independent timestamp. The JSON verifier checks internal consistency only.
- PDF workers currently limit JS heap and time, not native/WASM total memory. Production process isolation remains unfinished.
- Docker does not work on this development machine. Real local PostgreSQL and native processes are available. Actual Docker image validation must run on a working CI/host before release.

## Security and trust model

Distinguish four results in exports and verification: byte/signature integrity, issuer trust, trusted-time evidence, and participant identity/authorization assurance. These must never collapse into one universal green verified badge.

A valid seal from an unknown certificate means mathematically intact, issuer not trusted. Accept an issuer only through explicit trusted roots or an independently established certificate/key fingerprint. An embedded self-signed certificate or a key URL supplied by the document is not its own trust anchor. Retain old public certificates and references for historical checks. Explicit trust configuration and network requirements must be visible to the verifier.

A trusted timestamp proves existence of the covered value by the indicated time, not exact human signing time or consent. A local self-signed seal has no independent time evidence. A BankID login is not document approval; the future integration must use the signing operation and validate its document-bound evidence. BankID API credentials are separate from both HTTPS and PDF sealing certificates.

## 1. Specify evidence and signing boundaries first

Keep SigningMethod (draw now, BankID/Freja later), PdfSealer, TimestampProvider and EvidenceVerifier separate. Core code freezes content/recipients, validates transitions, constructs payloads and owns persistence; plugins cannot edit other recipients or declare an envelope completed.

Define a versioned SigningIntent containing application/domain separator, installation ID, document/revision ID, recipient ID, prepared PDF SHA-256, method/version, consent version and exact wording, and a unique server-generated attempt/nonce. Retain exact canonical UTF-8 bytes as well as their digest. Method-specific consent must not claim a drawing for a future BankID-only signature. Existing consent and v1 hash canonicalization remain unchanged for old records.

Specify one canonical producer format for new evidence (evaluate RFC 8785 with strict JSON bounds) and share test vectors across implementations. Store the exact intent/core bytes in PostgreSQL bytea; parsed JSON is only an index/view. Verify committed bytes before strict parsing, reject duplicate keys, invalid Unicode, BOM and excess sizes, and never hash a reserialized verifier interpretation. Specify Unicode and numeric handling explicitly: preserve the accepted name exactly; any normalization or stroke quantization must happen before approval and be visible in the data being approved. Do not silently recanonicalize old audit events. Establish a schema-v2 evidence package without claiming legal signature qualification.

Freeze a minimal evidence core through the last accepted signature: document/source hashes, immutable recipient/sender assignments, exact signing intents/consents, method evidence, and signing checkpoint. Bound its size and preserve provider proof as exact bytes or immutable separately hashed objects. Privacy-minimize the content exposed to every PDF recipient; decide explicitly which request metadata stays in the restricted JSON export.

The evidence core must exclude the completed PDF hash and post-seal completion event. Put the core or its digest plus unambiguous schema/checkpoint into the bytes covered by the PDF signature. Produce the final sealed PDF, hash those final bytes, and then store the completion event/outer export. This avoids embedding a PDF's own full-file hash and cryptographically binds separately exported evidence to the seal.

Default to a minimal public seal manifest plus a detached evidence core: the PDF protects the core digest, schema, checkpoint and prepared-document digest, while the authorized bundle carries the exact core bytes. Include a fresh 256-bit random blinding nonce inside that private core before freezing/hashing it; do not expose the nonce in the public manifest or publish unsalted hashes of individual IP addresses or other guessable private fields. The verifier distinguishes PDF-only integrity from full evidence verification and rejects detached evidence that does not match the protected commitment. Publicly displayed participant names/drawings remain an explicit product disclosure choice; a commitment is not encryption or a substitute for access control.

## 2. Introduce durable finalization before remote services

Use PostgreSQL for the job; no additional deployment service. The app can run a small bounded job runner with database leases. Add finalizing to the document state machine and retain operational attempt/retry/failure data in a separate jobs table.

In the final signature transaction, persist that person's accepted signature and event, freeze the signing checkpoint, retain and revalidate the protection policy already fixed at creation, transition pending -> finalizing, and enqueue one job using a unique document/revision key. Commit promptly. Future BankID completion cannot be undone by a later PDF/TSA failure; draw should follow the same rule.

Outside a document transaction, claim the job with FOR UPDATE SKIP LOCKED, a lease and incrementing generation/fencing token. Build the evidence-bound candidate PDF, seal it, optionally timestamp it, and validate the exact output with the selected validator. Persist immutable input references, selected policy/key version and bounded attempt metadata. Rebuild failed attempts from frozen inputs; do not introduce a general intermediate-PDF resume store. Retain the successful proof with the published artifact and define bounded retention for received external proofs needed to account for an ambiguous request. No TSA, HSM, provider network operation or long PDF work may run while holding a document row lock.

Publish completed bytes, their digest, seal metadata and the completion event in one short transaction that rechecks document state, signing checkpoint, policy and current lease token. At most one artifact is published. External requests might be repeated after an ambiguous network failure; do not promise exactly-once TSA/signing-provider execution. Attempts remain recorded, and stale workers cannot commit.

Freeze the protection policy at creation for new documents. Select and persist the actual sealing key/certificate version when a finalization attempt starts; never silently switch it mid-attempt. Define explicit recovery if a queued key becomes unusable. Cancellation is allowed only while pending; once all approvals are accepted, finalization errors preserve those approvals and expose retry/action-needed state. Operational retries must not mutate the frozen evidence core or append events into its checkpoint. During finalizing, allow no new recipient.viewed, link.rotated or other signing-chain events: only the eventual document.completed follows the frozen final recipient.signed checkpoint. Put later access/operations in a separate restricted log. Retry, failed and action-needed are job states, not additional document states. A single bounded runner is sufficient initially.

Keep participant evidence separate from operational seal policy. Bind the requested protection policy and actual pre-seal identity metadata in the signed public manifest; verify actual certificates/timestamps against it, then record the result in the completion export. Permit an explicitly recorded key replacement or equivalent provider recovery only if it satisfies the frozen policy. Required timestamping cannot become off to make a stuck job succeed. Any future downgrade would need a separately designed, clearly disclosed product/consent flow; it is not part of this plan.

Update database constraints/triggers intentionally for these transitions. Migrate completed/cancelled records without changing their policy, hashes or events. The implementation preserves an explicit legacy-v1 completion branch for existing pending documents, so an upgrade does not strand real data. Production creation always chooses v2. Legacy pending documents retain the former synchronous behavior and remain labelled unsealed; completed artifacts and old events are not rewritten. The branch may be removed only after an inventory shows there are no pending v1 documents. This revises the proposed upgrade-blocking gate based on existing user data and Claude's implementation critique. New schema-v2 documents cannot complete without a verified seal. Define API compatibility so clients understand that accepted signature and fully finalized PDF are different states. After acceptance, show the signer that they have signed while the PDF is being prepared; refresh/retry must not ask them to sign again or approve a technical preparation step. Show the sender an actionable finalization error without changing the signing flow.

## 3. Add local keys and standard PDF sealing

Run a small interoperability spike before choosing the signing library. Evaluate maintained, license-compatible implementations (including @libpdf/core and @signpdf components), and record exact versions, supported algorithms, signing/validation gaps and runtime needs. Do not implement ASN.1/CMS/PDF signature mathematics ourselves. Changing a PDF SubFilter alone is not evidence of complete PAdES conformance. The spike must check signed-attribute/certificate binding, full-chain embedding, supported RSA/ECDSA choices, fixed-size Contents capacity and overflow handling, and reader behavior. Reject overflow and ambiguous PDF structures; never truncate proof.

Also spike incremental assembly over the exact prepared PDF rather than rewriting its existing serialized structure. If supported safely, retain its byte length/hash and test exact prefix recovery. A matching prefix proves preservation of source bytes, not that later objects display unchanged source pages: appended revisions can shadow earlier content. Validate allowed generated changes and render source-page regression fixtures with independent readers; keep the exact prepared PDF in the export either way. State any remaining rendering/derivation trust explicitly. This remains a library/format decision, not an asserted capability.

Use a platform seal with no visible appearance over the contract pages. Its locally generated certificate identity, PDF Reason and UI describe the installation sealing completed evidence, never an individual approving the contract. Imported certificate subjects are issuer-defined and are not rewritten; an invisible field may still use a library-required zero-size/hidden widget. Keep participant drawings in the existing appendix. Decide and document DocMDP/certification behavior in the spike; reader warnings for locally trusted/self-signed certificates must be explained without promising a universal green check.

Target independently checked PAdES B-B for local sealing and B-T when a timestamp is configured. Do not advertise LT/LTA until revocation material, validation rules and archival renewal are implemented and tested. Use an independent validator such as pyHanko and an external PDF reader, plus applicable conformance checks; these may be test tools rather than new required runtime services. If a Node-only runtime cannot safely implement required validation, revisit the bundled runtime rather than shipping a weak verifier.

Auto-generate a unique private key and self-signed certificate only when both the key volume is empty and the database has no instance identity marker. Use exclusive initialization, atomic key-file writes and a defined crash-reconciliation path so parallel first boots cannot overwrite identity. Compose keeps two services and two persistent volumes: PostgreSQL data and keys. Protect private keys separately from database data; never bake them into the image or expose them in repository/logs/database rows. Use restrictive permissions and support a mounted external secret.

When the database marker exists but a key is missing, keep read/verification/download paths available, retain accepted signatures and put finalization in action-needed. Refuse sealing on a key/fingerprint mismatch. Never silently adopt a replacement key. Provide an explicit lost-key rotation/recovery command that preserves historical public certificates and the recorded identity change. Loss affects future signing and trust continuity; suspected theft needs a separate compromise response and must not be treated as routine loss.

Provide a public certificate/fingerprint export, explicit rotation, expiry warnings, key/certificate matching checks and encrypted offline backup guidance. Retain public certificates, algorithms, fingerprints and validity periods used for old documents. Restoring verification of old PDFs should not require old private keys. Fail closed for expired/missing/unusable signing keys; distinguish historical cryptographic integrity from current certificate trust/validity.

Use local PKCS#12/PFX or equivalent PEM behind one narrow sealer boundary. Include administrator-mounted BYO certificate input in C if it uses the same independently validated path; otherwise record the gap and defer that feature to D. No certificate-management UI or remote/HSM adapter is required now. Configuration belongs to the deployment administrator, not every signer. Keep the default user flow unchanged.

Treat PDF parsing and private-key access as separate boundaries. Isolate hostile parsing with enforced process/OS memory and execution limits; give parsing workers no sealing secrets or unnecessary network access. Merely clearing environment variables or using a same-user child process is not a security sandbox. The chosen deployment isolation must preserve the simple two-service setup or explicitly justify any additional container. Scope and enforce what the signing process itself parses; a trusted-looking intermediate PDF is not automatically safe. Prefer an isolated worker building a signature placeholder, with the key holder performing only bounded range checks, hashing and maintained-library CMS operations where the library supports it. This minimizes parsing near the key but is not a substitute for robust PDF/CMS validation or a security boundary against app compromise. An app process holding the key loses that key if the app is compromised. A memory cap addresses exhaustion; it does not prevent file/key access.

## 4. Add independent verification and portable exports

Extend the CLI using a maintained PDF/CMS validator to check integrity, signature coverage and protected evidence commitments, then the evidence core/outer export and participant bindings. The initial Signhere output profile contains one platform PDF signature covering byte zero through the exact file end, excluding only its one legitimate Contents value. Reject extra signatures, ambiguous signature objects, gaps/overlaps, unsigned tails and every later revision. Participant drawings are evidence, not separate PDF signature dictionaries. B-T must fit this profile with an in-CMS signature timestamp; if a library requires an appended document timestamp, it needs a new explicit profile. Do not write a general PDF difference engine or mistake a regex ByteRange check for validation. Nonconforming third-party PDFs are unsupported, not automatically forged. Future permitted archival updates require a new profile and validation rules.

Support explicit certificate fingerprints/trust roots, clear unknown-issuer results, and separately validated RFC 3161 tokens. Never trust certificate subjects, signature appearance images or server-claimed assurance flags as proof. Publish the installation certificate and fingerprint at a stable well-known endpoint for explicit enrollment; HTTPS proves control of that domain at retrieval time, not prior trust, participant consent or uncompromised operator history. Never automatically follow a trust URL supplied by the PDF. Avoid arbitrary network fetches from uploaded certificate/PDF URLs; network revocation fetching must have an explicit policy, SSRF protection and bounded requests.

Keep /verify public. For the initial release it clearly labels the current hash lookup, offers the standalone verifier/package instructions, and does not present a database match as cryptographic verification. Defer browser CMS verification until it can safely support the chosen profile without requiring a match in the originating installation's database. Server lookup remains an additional known-document check. Files should not be uploaded for verification by default, and no recipient details should leak through public hash lookup.

Offer a portable verification package: exact prepared PDF, final sealed PDF, evidence core/export, certificate chain and available timestamp/revocation evidence; include the raw upload when conversion needs separate proof. Generate the portable archive on demand from immutable stored artifacts; a second export queue is unnecessary. Support authenticated owner export and scoped, renewable access for authorized participants, with retention rules beyond a short-lived invitation link. Permanent participant accounts are not required. Preserve method assurance labels; a platform seal never upgrades draw to verified identity.

## 5. Optional timestamping and production operations

Expose explicit timestamp policies: off, or required with an administrator-configured provider. For required mode, no un-timestamped success fallback. Timeouts, invalid responses or rejected trust chains leave the document finalizing, with the job waiting to retry or requiring operator action. Verify message imprint, algorithm, nonce when used, TSA signature/chain/EKU and time before accepting the result. Persist exact returned proof; send only the required digest to the service.

Use bounded timeouts, retries/backoff and observability that avoids documents, tokens or key material. Validate external certificate/TSA configuration before enabling it. Network endpoints are privileged deployment settings and need SSRF-safe request handling. Actual retention of OCSP/CRL and archival validation is a separately tested milestone, not an implication of merely receiving a timestamp.

Maintain minimal application DML database privileges separately from migrations. Exercise key+database backup/restore, lost-key behavior, wrong-key restores, certificate expiry/rotation and interrupted upgrades. Run clean Docker start, restart/persistence and restore checks on a working host/CI; do not claim Docker validation from this machine.

## Implementation order and exit criteria

| Milestone | Work | Required evidence before proceeding |
| --- | --- | --- |
| A | Evidence/signing specification, PDF library/validator and isolation spike, Docker CI baseline | Exact-byte test vectors; no hash cycle; independently validated sample and tamper failures; source-preservation limits and dependency/license choice documented; clean two-service Docker start/restart with key volumes on a working host. |
| B | PostgreSQL finalization job/state machine and schema migration | Final signature remains accepted on worker failure; restart, concurrent last signatures, duplicate callbacks/retries, stale leases and cancellation races cannot lose consent or publish twice; old evidence still verifies byte-exact. |
| C | First-boot local keys and recovery, standard seal, portable package and verifier; BYO secret input if the same validated path | Fresh setup needs no external provider; key backup/restore, loss/mismatch, expiry and rotation pass; no false issuer trust; PDF/evidence tampering rejected; source pages preserved under documented checks; independent reader/validator interoperability demonstrated. |
| D | Optional required TSA and any deferred BYO certificate configuration | Invalid setup fails clearly; outages never silently downgrade; wrong TSA imprint/nonce/cert rejected; timestamped output validates independently. |

Milestones A-C form the local-sealing feature scope. A deployable self-hosted release also requires working Docker CI, persistent key/data restore checks, enforced hostile-PDF isolation, restricted runtime database privileges and the existing security/legal review, retention and authentication release gates. These gates do not wait for D; until they pass, A-C is a local development preview. D must pass before advertising external timestamping. Browser cryptographic verification, rich certificate-management UI, automatic renewal and remote key adapters can follow the first CLI-verifiable release. No BankID or Freja integration, arbitrary plugin marketplace, mandatory HSM, Redis, automatic email delivery, or recurring archival-renewal service is part of this immediate implementation plan.

## BankID work reserved for later

Implement the signing operation, not login-as-consent. Supply clear document context for the human and bind the exact SigningIntent/document digest to provider-signed data. Persist and validate asynchronous attempts, provider transaction references, returned signed evidence, certificate/status evidence and the exact identity claim against the intended participant. A successful browser return does not authorize completion. Keep future method-specific evidence/consent and assurance separate from platform sealing. Provider configuration/agreements remain operator choices; do not introduce a required central Signhere service.

## Review dispositions

Claude's verdict was **approve the direction, revise before implementation**. Its full response is retained separately; recommendations below are evaluated decisions, not automatic adoption of every claim.

| Critique | Decision in this revision |
| --- | --- |
| B1: preserve prepared PDF bytes through incremental assembly | Add a spike and exact-byte test, but reject the implication that a matching prefix proves unchanged display. Keep the original and test generated modifications/rendering. |
| B2: reduce modification-policy scope | Adopt a strict one-seal, whole-current-file profile; use maintained validation rather than building a difference engine or a regex verifier. |
| B3: reduce parsing near private keys | Accept as a spike/design constraint. A minimal patcher or memory cap alone is not a sandbox, and app compromise remains key compromise. |
| B4: default key provisioning | Auto-generate only on truly fresh instances; preserve access during key failure; require explicit recovery and record trust changes. |
| B5: separate policy from participant proof | Accept separation, but keep policy cryptographically bound to the artifact and reject a required-TSA-to-off override. Recovery must meet the frozen policy. |
| B6: specify finalizing behavior | Define document/job states, prohibit signing-chain writes after checkpoint, fence every publication, and keep a single runner initially. |
| B7-B8: exact evidence bytes and privacy | Hash retained bytes; use strict parsing and versioned numeric/Unicode rules. Use one blinded detached core rather than a new per-field commitment scheme. |
| B9: seal presentation | Identify the instance as sealer, preserve participant drawings separately, explain issuer trust and spike DocMDP/reader behavior. |
| B10: legacy pending data | Retain explicit legacy pending behavior while all new production documents use v2; no automatic cancellation or silent historical rewrite. This supersedes the draft upgrade preflight after implementation review. |
| Smaller implementation | Rebuild failed attempts; defer browser CMS, a participant portal, remote signers and archival renewal. Keep basic authorized export access. |
| Docker and operations | Move Docker baseline to A; keep key recovery/rotation and production isolation as first-release gates, despite suggestions to defer parts of them to D. |

## Adversarial acceptance matrix

- **PDF/CMS:** content edits, unsigned appended revisions/tails, overlapping/out-of-bounds ranges, malformed or extra Contents/signatures/SignerInfos, wrapping/shadow fixtures, digest/attribute/certificate swaps, weak algorithms and placeholder overflow. Validate the exact published bytes, not just a candidate before patching.
- **Evidence:** one-byte edits, wrong original, missing/mismatched detached core, duplicate keys, Unicode/numeric edge cases, BOM/oversize input, reordered/replaced participant proof and wrong sender/recipient binding. A missing private bundle means partial verification, never complete evidence verification.
- **Jobs:** crash at each persistence boundary, simultaneous final signatures, duplicate enqueue/callback, cancellation race, two workers, expired lease and stale publication. Accepted signatures survive every finalization failure.
- **Keys:** empty first boot, concurrent provisioning, partial initialization, missing/mismatched restored volumes, unsafe permissions, corrupt P12/wrong password/chain order, expiry, rotation, loss and compromise recovery distinctions.
- **TSA (D):** wrong digest/nonce/policy, invalid chain or timeStamping EKU, invalid time/certificate interval, rejection, oversized/slow response, internal redirects and DNS rebinding. No required-policy downgrade.
- **Interoperability and deployment:** pyHanko plus applicable PAdES conformance checks, another independent reader/validator (for example Poppler pdfsig), Acrobat Reader manual checks, PDF.js/source-page render regressions, bounded worst-case PDF handling, Docker clean start/restart and key+data restoration. Check licenses and exact versions before adopting any tool; CI validators need not become runtime services.

## Primary references checked

- [DocuSeal local certificate generation](https://github.com/docusealco/docuseal/blob/47c090e1f1548be0d8ab58347c83363539e8b5b6/lib/generate_certificate.rb) and [optional RFC 3161 configuration](https://www.docuseal.com/faq/how-do-i-configure-rfc-3161-timestamp-server).
- [Documenso platform signing model](https://docs.documenso.com/docs/concepts/signing-certificates) and [certificate configuration](https://docs.documenso.com/docs/self-hosting/configuration/signing-certificate).
- [OpenSign self-hosted certificate setup](https://docs.opensignlabs.com/docs/self-host/docker/run-locally/).
- [ETSI PAdES baseline standard](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.02.01_60/en_31914201v010201p.pdf), [RFC 3161](https://www.rfc-editor.org/info/rfc3161/), [Adobe trust services](https://helpx.adobe.com/ie/acrobat/kb/trust-services.html).
- [BankID signing API](https://developers.bankid.com/api-references/auth--sign/sign).
- [LibPDF capabilities and current verification limitation](https://github.com/libpdf-js/core), [node-signpdf](https://github.com/vbuch/node-signpdf), [pyHanko validation and its conformance-check limitations](https://docs.pyhanko.eu/en/latest/cli-guide/validation.html).
