# Signhere architecture

Signhere keeps the supplied Swedish product flow small while separating participant approval, durable evidence and the installation's PDF seal. The current local-sealing foundation is a development preview. It is not an independently audited signing service, an eID provider or a legal certification.

## Product and runtime

The prototype defines account creation, document list/upload/sharing/details, evidence, public verification, team administration and recipient signing. The first versioned participant method is `draw`; BankID and Freja remain future integrations. Prototype claims and sample state are design input, not backend security guarantees.

| Component | Choice and boundary |
| --- | --- |
| UI/API | React/TypeScript and Express, served from one origin in production. |
| Database | PostgreSQL; transactions, document-row locks and immutable-data guards coordinate acceptance and publication. |
| PDF preparation | MuPDF WebAssembly flattens supported forms/annotations locally; pdf-lib constructs the evidence appendix. |
| Cryptographic seal | Bundled Python/pyHanko signs and verifies the installation's PDF/CMS profile. Parser operations are separated from key access. |
| Deployment | Two services: application and PostgreSQL. No required central account, external signing service, Redis or object store. SMTP or Resend is optional, for emailing completed copies. |
| Persistence | PostgreSQL volume for document bytes/evidence/jobs, existing app setup-state volume, separate private key volume. |

Public HTTPS terminates at the operator's reverse proxy. Non-localhost application origins require HTTPS. Proxy trust must match deployment routing before forwarded addresses can be relied on as network observations. Compose currently uses PostgreSQL 17; local tests use real PostgreSQL directly.

Docker cannot run on the development machine. The repository has Docker lifecycle/isolation CI and static checks, but no local container execution is claimed. See [deployment](deployment.md) for the exact host requirements and recovery procedures.

## Immutable signing input

Upload preserves the exact source bytes and SHA-256. The server rejects encrypted files, existing digital signatures and unsupported/active structures. Supported annotations and widgets are flattened with JavaScript disabled. Comment text becomes a static notes appendix; already static PDFs retain their bytes. Preparation is not a universal PDF repair service.

Document creation freezes the prepared copy. All recipients see and approve that same hash. The database's `original` and `originalHash`, and an exported `original.pdf`, mean this **prepared signing PDF**. If conversion changed the source, `uploaded.pdf` preserves the original upload, and immutable preparation metadata records its hash, size, engine and conversion counts. Sender preview is optional and is never an extra signing authorization step.

A new signing transaction has its own document UUID, also used as transaction ID and intent revision ID. Correcting bytes or participant assignments requires a new transaction; the current model has no separate multi-revision document entity. `includeSender` appends the authenticated sender as a separate recipient without replacing entered parties, even if email addresses match. The creation event records `senderRecipientId`; each assignment has its own intent, capability and acceptance.

Each v2 recipient intent is canonical, domain-separated data containing installation ID, document/revision ID, recipient ID, prepared PDF hash, method ID/version, exact consent text/version and a 256-bit random nonce. Exact intent bytes and hash are retained. The server checks that submitted acceptance matches this frozen intent rather than whichever consent happens to be the application default later.

## Approval and durable completion

A draw approval requires the assigned personal link, a claimed name, validated vector strokes and affirmative consent. The checkbox starts unchecked. The server records intended name/email separately from the claimed name, plus method/version, intent, prepared hash, exact consent, observed IP/user-agent and server UTC acceptance time. `authenticationMethod` is `personal_signing_link`; provider evidence explicitly says identity is not verified. Consent and signature arrive as one submission, so their server acceptance times coincide.

Within a document-row transaction, the application accepts a recipient at most once, appends its hash-linked `recipient.signed` event and saves the same evidence on the recipient. An identical retry returns the accepted result; a changed submission is rejected. Separate recipient IDs each need acceptance, including the sender's assignment.

For **v2**, the last approval freezes the canonical evidence core through the last participant event and enqueues finalization in that same transaction. The HTTP request can then report `finalizing`; it does not claim a completed PDF already exists. A durable PostgreSQL job worker claims a lease, builds the candidate PDF, seals it and validates the result. Publication stores final bytes, final SHA-256, seal metadata, completion state and `document.completed` together. Generation fencing prevents an expired/stale worker from publishing. Transient failures retry with bounds/backoff; operator-action failures preserve approvals and remain visible. Cancellation applies only while still pending, not after all parties have accepted.

Accepted approvals and the frozen protection policy survive restarts and failed finalization. Retrying may not silently remove required protection or edit evidence. Explicit operator workflows handle lost/rotated keys and a failed job pinned to an obsolete key. See [deployment](deployment.md#lost-keys-rotation-and-optional-external-services).

Legacy v1 documents retain their original synchronous completion path and hash-chain evidence. The final signer transaction generates the appendix and commits only when it succeeds; failures roll back that acceptance. Existing pending v1 documents may finish in v1. They are never silently upgraded or represented as cryptographically sealed. Production document creation always uses v2; the legacy creation option is an internal test fixture.

## Seal, evidence and trust

The platform certificate is separate from the participant method and the site's HTTPS certificate. First boot creates a unique installation identity and local private key automatically. The default certificate is self-signed; optional certificate/password file inputs support an operator's external certificate. A certificate purchase is not required to detect tampering against a trusted retained fingerprint.

The completed PDF contains document pages and per-signer evidence appendices, then one PDF/CMS seal. The protected manifest binds the prepared PDF hash, exact private evidence-core digest, signing checkpoint, frozen protection policy and actual certificate. The full private audit core is exported separately, rather than embedding IP addresses and user agents into a public manifest. It is blinded with a random nonce before commitment.

Adding evidence pages reserializes the prepared PDF; the completed file does not contain the exact prepared file as a byte prefix. The seal operation preserves the exact candidate prefix it receives. Independent verification of prepared-byte binding uses the separately retained `original.pdf`; broad source-page rendering-equivalence regression remains a release check.

| Assertion | Meaning / limit |
| --- | --- |
| PDF integrity and coverage | Cryptographic signature and strict byte-range/profile checks detect covered-byte changes and unsupported unsigned tails. |
| Evidence binding | Recomputed prepared/core hashes and canonical semantic checks tie exported participant approvals to the protected manifest. |
| Issuer trust | Unknown by default. Explicit independently obtained certificate fingerprint may establish which installation key sealed it. An included certificate is not its own trust anchor. |
| Human identity | Draw plus personal-link possession is self-asserted approval, not eID verification. |
| Time | Server UTC observations. No RFC 3161 trusted timestamp, long-term timestamp preservation or trusted signing-time assertion is implemented. |
| Certificate status | Reported separately; offline verification does not query revocation services. |

The maintained pyHanko implementation uses the documented PDF/CAdES profile; see [engine profile and validation limits](pdf-sealing-spike.md). This is not a formal PAdES conformance or qualified-seal claim. Timestamp-required policies must fail closed rather than downgrade to a local clock. The current shipped local policy has timestamping off.

The exact completed-file hash is external to that file. Including its own whole-file SHA-256 in the appendix would create a circular dependency. Completion metadata therefore follows the frozen signed evidence core and is checked for consistency separately; the verifier must not imply the final completion event is inside the earlier commitment.

The offline v2 verifier needs no Signhere account, database or live server. It validates CMS/PDF coverage and the private evidence bundle, and reports issuer trust separately. Legacy verification checks hash-chain/internal consistency only. Public `/verify` computes a PDF hash in the browser and sends only that digest to this installation for a completed-record lookup; it is not a remote cryptographic validator or an independent trust authority.

Neither database guards nor a self-signed seal protects against a hostile host operator who holds the key. Such an operator can issue a replacement signed record. Independently retained originals, evidence, fingerprints and completed PDFs are valuable anchors. External certificates improve issuer trust distribution; trusted timestamps and eID authentication solve separate problems.

## Access and audit boundaries

First-owner setup requires a private installation token and closes once initialized. Accounts use scrypt and server-managed cookie sessions. Expensive password hashing has a concurrency limit. Team-scoped authorization protects management and private evidence exports; a creator is not an isolated owner inside their team. Owner-role checks additionally protect selected administrative operations.

Recipient capabilities contain 256 random bits and are stored as hashes. They are delivered in URL fragments, supplied from memory to the API, omitted from audit/log payloads and protected with no-referrer responses. The unsigned lifetime is configurable with `SIGNHERE_SIGNING_LINK_TTL_DAYS` (1–365 days; default 7), applying when links are created or rotated. Pending cancellation or rotation revokes signing access.

After acceptance, signing authority is consumed; exact retries remain idempotent. The original capability also remains a read-only receipt while the document is pending or finalizing, and until at least 30 days after completion, so a lost response or a slow co-signer does not strand the participant. This is deliberately different from destroying the raw token after a single request. A separate receipt exchange is deferred. The expiry behavior is described in the README and [SES cross-check](ses-spec-crosscheck.md).

Signed bearer receipts and separate completed-copy links provide the completed PDF only. They do not provide the full private JSON/ZIP evidence. Authorized team members can export the complete bundle or create/revoke recipient copy links. Signed PDFs necessarily contain participant names/contact and consent details; a personal link remains a credential whose forwarding grants access.

Audit events are append-only under the restricted runtime database role and linked by canonical hashes. `document.created` also records initial participant assignments; `recipient.viewed` means the first successful signing-session access, not proof of page reading. `recipient.signed` atomically records consent, submitted signature and signer completion. `document.completed` records final publication. The [SES event mapping](ses-spec-crosscheck.md#audit-event-mapping) distinguishes these combined semantics from separately observed actions.

## Parser and database isolation

Production Node PDF work runs as a child process rather than a worker thread. Python PDF parsing and validation also run through the required Linux launcher; the key holder receives bounded signing inputs and does not parse PDF object graphs. The launcher uses Landlock filesystem restrictions and seccomp syscall filters, clears inherited descriptors/environment and restricts public runtime/code plus a private job directory. Key/setup files, other jobs, external sockets and cross-process memory access are denied. Windows development does not provide this Linux boundary.

This protects key confidentiality from a confined parser, not from compromise of the parent application or host. Parser output remains untrusted and needs parent-side validation before publication. File/range checks do not establish that a compromised PDF transformer preserved visible contract meaning; the transformation pipeline remains inside the signing-integrity trust boundary. The launcher is not an externally audited general-purpose sandbox. See [deployment isolation details](deployment.md#pdf-parser-boundary-in-the-linux-image).

Input, stroke, output, process-deadline and CPU limits bound ordinary work. Node/V8/WASM virtual reservations require a large address-space allowance; Compose limits the whole application container's resident/native memory to 768 MiB. Native allocation exhaustion can still kill that container. Actual maximum-size/concurrency and temporary-storage behavior remain load-test gates.

Fresh Compose installs use separate non-superuser migrator/schema-owner and DML runtime roles. Immutable-data guards are meaningful against that restricted runtime role; an owner can disable them. The migration pool closes after startup DDL, but a compromised application container could still read its supplied migration credentials. Stronger separation requires an external migration deployment step. Existing volumes require an explicit role/ownership migration and restore rehearsal; fresh initialization scripts do not rerun automatically.

## Operations and remaining gates

PostgreSQL holds raw/prepared/completed PDFs, evidence, job state, installation identity and historical public certificates. Private keys live separately. Stop writes/rotation for a simple coherent paired backup; use PostgreSQL's supported dump tooling, encrypt the key archive and configuration, store the pair off-host and rehearse restoration to an isolated installation. A database-only backup can retain historical verification material but cannot restore future signing with the original key. Restore mismatch must fail closed, not create a replacement identity silently.

Database blobs keep publication atomic but grow backups and memory pressure. Document/storage quotas, measured concurrency, retention/erasure and backup-age policies remain operational work. Multiple application instances would additionally need coordinated rate limits and scheduling; PostgreSQL job leases alone do not establish high availability. Future asynchronous eID methods need persisted attempts and authenticated/replay-safe callbacks. The existing finalization queue does not implement those provider workflows.

Before production claims, complete actual Linux Docker lifecycle/isolation/restore tests, maximum-size/concurrency tests, independent PDF-reader validation, malformed-PDF and rendering regressions, and external security/legal review. Test in-flight jobs around key loss/rotation and backups ahead of either database or keys. Keep runtime permission denials and cross-team/capability denial tests in the release checks.

Requested Claude Opus 5.5 architecture and source reviews informed these boundaries and follow-up fixes. They are review input, not independent certification. See [implementation status and review dispositions](sealing-implementation.md), [Claude review](claude-review.md), [approved sealing plan](sealing-plan.md), [SES cross-check](ses-spec-crosscheck.md) and [signing-method boundaries](signing-methods.md).
