# Signhere initial architecture

Signhere is an initial foundation for a small, self-hosted document signing service. The supplied prototype defines the product experience; this architecture adds persistence, authorization and evidence boundaries around it. It has not been independently security reviewed or certified for production or legal compliance.

## Product scope

The supplied `design/prototype/signhere.dc.html` contains these nine screen labels:

1. `01 Skapa konto` — initial account creation.
2. `02 Dokument` — document list and status filters.
3. `03 Nytt dokument` — PDF upload, title and recipients.
4. `04 Dela länk` — recipient link sharing.
5. `05 Dokument-detalj` — document and recipient progress.
6. `06 Verifikat` — evidence record.
7. `07 Verifiera` — document verification.
8. `08 Team` — team settings and members.
9. `09 Signera (mottagare)` — read, draw, consent and confirmation.

The prototype is design input, not an authority for backend security or a source of legal guarantees. Its sample state, simulated hashes and recipient shortcuts do not establish production behavior. The first real signing method is draw; BankID and Freja are future integrations.

## Runtime and deployment

| Component | Initial choice | Reason |
| --- | --- | --- |
| Interface | React, Vite and TypeScript | Reproduce the supplied screens with a maintainable typed interface. |
| HTTP application | Express 5 on Node.js 24 | Serve the built interface and same-origin API from one service. |
| Database | PostgreSQL through `pg` | Use explicit transactions and document row locks to coordinate concurrent signatures. |
| Persistence | PostgreSQL volume with original/final PDF blobs | Keep accounts, document bytes and evidence in one backup and transaction boundary. |
| Deployment topology | One application service and one database service | Keep the initial self-hosted installation small and understandable. |

Production HTTPS termination belongs at the host's reverse proxy. A localhost development connection is not evidence that a public deployment has correct TLS, proxy trust or cookie configuration.

There is no required hosted signing service, Redis or external object store. Compose currently specifies PostgreSQL 17; the local development instance is PostgreSQL 18.6 from the official Windows download route. Docker setup and environment details belong in the root README; this document describes the constraints that setup must preserve.

Docker execution is unavailable on the development machine. Local validation uses real PostgreSQL and direct Node.js execution; Compose configuration validation is distinct from building or running a Docker image. No Docker runtime validation is claimed.

## Data and atomicity

The database holds team-scoped users and documents, recipient records, hashed access tokens, sessions, original PDF bytes, final PDF bytes, signature evidence and audit events. Saving PDF blobs in the database deliberately avoids a transaction that commits evidence while a separate filesystem or object-store write is missing.

Each document mutation uses a dedicated PostgreSQL client for its transaction. `SELECT ... FOR UPDATE` locks the document row while signatures and the audit chain are changed. All statements in that transaction use the same client, rather than unrelated pool queries. [PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS), [node-postgres transactions](https://node-postgres.com/features/transactions).

Document upload preserves the source bytes and their SHA-256 digest. Supported annotations and form widgets are flattened before sending using the bundled MuPDF WebAssembly engine, with JavaScript disabled and strict checks before and after conversion. Text comments become a static notes appendix. The authenticated preparation endpoint provides an optional preview. Document creation prepares the uploaded source on the server and freezes the resulting signing copy; no sender preview acknowledgement is required. Older clients may send a preview hash, which is accepted for compatibility but never used as signing authority. Recipients review the frozen PDF and their signatures must bind its digest. The frozen `original`/`originalHash` fields identify this prepared signing PDF. Nullable immutable `uploaded` and `preparation` columns (schema migration 2) retain the pre-conversion source and its hash/engine/counts; the creation audit event includes the same metadata. Documents without conversion retain their exact bytes and need no duplicate blob. Sending freezes the document and recipient scope used for signing. A correction requires a new document or revision rather than replacing the bytes under an existing consent record.

Each accepted signing action must bind the recipient, method and version, document digest, consent and submitted evidence in the same transaction as its audit event and recipient-state update. Final completion stores the final PDF and evidence together with the completion state. It must not report a completed document if PDF generation or persistence failed.

Sender inclusion is explicit: `includeSender` preserves all entered parties and appends the authenticated sender as a separate recipient, including when email addresses match. The creation event freezes `senderRecipientId` (or explicit `null`) along with the full recipient list. The UI selects the sender by that ID, not by email. Each recipient ID has its own token, explicit consent, signature evidence and hash-linked signing event. Existing records and completed evidence are never rewritten to add a missing signer; corrected assignments require a new document.

For the final signer, the bounded PDF worker runs while the document transaction retains its row lock. The transaction commits only after the generated PDF, its digest, the signature evidence and the final audit event are ready. Worker failure rolls back the pending mutation. Retried or concurrent submissions must not create duplicate accepted signatures or overwrite another recipient's evidence. This deliberately serializes work for a document; keep worker deadlines bounded and do not extend this pattern to long provider network calls.

A separate durable finalization queue is deferred. The current local generation followed by atomic commit avoids publishing a half-completed document. External providers will require persisted attempts and resumable jobs because their work can outlive an HTTP request.

## Authorization boundaries

- **Instance setup:** the first owner is created using a private setup token supplied through environment or a private file. Setup closes once the owner exists; a public first-visitor-wins endpoint is not acceptable.
- **Accounts:** passwords use scrypt; browser sessions use server-managed cookie authentication. The scrypt parameters require approximately 128 MiB of working memory, with a 256 MiB allocation ceiling and a concurrency semaphore so parallel login requests cannot create unbounded hashing work. Password hashes and session secrets are never returned to the interface.
- **Team operations:** owners manage membership; members act within their team's authorized document scope. Every server lookup and mutation must enforce this scope, including downloads and evidence exports.
- **Recipient operations:** signing links carry random 256-bit capabilities. The database stores their hashes, not their raw values. A token grants the recipient's limited document access, not a team account.

Signing links place the capability in the URL fragment. The interface supplies it to the API from memory; responses use a no-referrer policy. Exchanging capabilities for short-lived recipient cookies is deferred. Fragments reduce accidental exposure in ordinary HTTP URL logs and referrers, but the full link is still a secret accessible to the browser and anyone to whom it is forwarded. Never put raw capabilities in audit payloads, analytics or application logs.

Cookie security, mutation-origin checks, request limits and server-side input validation remain part of the HTTP boundary. A reverse proxy's forwarded IP headers may be treated as evidence only when that proxy is explicitly trusted. IP addresses and user-agent strings are observations, not identity proof.

## Signing and evidence

The draw method accepts a stated full name, a signature drawing and affirmative consent after the recipient has an opportunity to review the document. Keep the sender-assigned name distinct from the name claimed by the recipient. The server records the consent wording/version, drawing digest and document binding; a client-side checked box or a successful image upload alone cannot authorize completion.

The initial output is a PDF containing the original document and an evidence appendix, plus a JSON evidence export with hash-linked events. These are application-generated records. The first build does **not** implement PAdES, X.509 PDF signing, trusted timestamping, a public certificate trust chain, or qualified electronic signatures.

A hash comparison can establish whether bytes match a retained digest. The event chain can be checked for consistency and compared with a separately preserved copy; an audit checkpoint in the completed PDF provides another retainable reference. Neither can independently establish the human identity behind a link, the accuracy of the server's clock, or the honesty of the server operator. An operator with database access can rewrite the document and entire chain. Public verification is restricted to completed artifact hashes and does not reveal recipient personal information or pending-document details. Offline verification compares retained PDFs with the exported manifest.

The evidence export should retain the original and final document digests separately. The final PDF cannot straightforwardly contain its own full-file SHA-256 digest: changing its appendix changes that digest. The final-byte digest therefore belongs in the separately generated evidence export or database record. The appendix may identify the original digest and the evidence snapshot used to produce it.

Recipient methods and future PDF sealing remain separate extension boundaries. An identity provider can strengthen evidence of who approved specific data. A PDF seal can make later modifications detectable against a signing key. Neither function should silently be substituted for the other. See [Signing methods](signing-methods.md) and [Research](research.md).

## Operations and scaling tradeoffs

Use PostgreSQL's `pg_dump` for a consistent logical backup while the database is running, and test restoration into a separate database. Pre-conversion uploads, signing originals and final PDF blobs are included with the evidence records. Preserve required private instance configuration separately; a database dump does not back up the application's configuration files. A plain copy of a running PostgreSQL data directory is not a substitute for a supported backup method. [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html).

Keep the Node.js and PostgreSQL images maintained, and verify supported upgrade/restore paths before changing database major versions. The portable local instance listens only on `127.0.0.1:15432`, uses SCRAM authentication and a private generated application credential, and creates no Windows service. Its application role is not a superuser. This development setup does not establish that a separately deployed database has equivalent permissions or network restrictions.

Database blobs simplify consistency but grow database files, backups and memory pressure during PDF processing. Workers, connection pools and per-document locks still impose throughput limits. The first deployment has no horizontal scaling or high-availability guarantee. Establish measured document-size, concurrency and storage limits before exposing larger workloads.

Add a durable outbox/job queue for asynchronous providers and notification delivery, and revisit finalization scheduling when measured workload requires it. If document bytes move to object storage, use immutable keys, digest checks and explicit recovery for partially completed writes; do not assume a database transaction also commits the object store. Multiple application instances additionally need shared rate-limit and worker coordination; a network database alone does not supply those features.

PDF validation, MuPDF WebAssembly preparation and generation use bounded workers with parsed-object checks and rejection of active content, existing signatures and incremental revisions. These workers bound execution time and JavaScript heap use, not total process memory: Node.js worker resource limits exclude ArrayBuffer, WebAssembly and native allocations, and a global out-of-memory failure can still terminate the application. Compressed PDF streams can expand substantially beyond the input-file size. [Node.js worker resource limits](https://nodejs.org/api/worker_threads.html#new-workerfilename-options).

Total RSS/native-memory and decompression-output caps remain an explicit production release gate. Move hostile parsing into a separate child process with enforced operating-system resource limits, and bound decoded stream sizes before treating per-document memory use as contained. Worker threads are not a complete operating-system security sandbox or malware scanner. Automated certificate management, trusted timestamp preservation and third-party plugin isolation are not implemented. PDFs remain untrusted input even when their extension and basic structure are valid.

Formal personal-data retention and erasure tooling remains a release gate. Decide which documents and evidence an operator must retain, how deletion affects verification, and how backups age out before representing the system as production-ready.

## Review priorities

Before promoting a deployment beyond an initial foundation, verify cross-team access denial, recipient-token scope, setup closure, concurrent submissions, failed finalization recovery, evidence export consistency, backup restoration and tampered-file rejection. Review public verification responses for unintended disclosure of document or recipient details. Reassess key management and evidence validation before adding an external signing provider.

The requested read-only Claude Opus 5.5 consultation completed after renewed OAuth authentication. The CLI reported `claude-opus-5-5`. Its architecture critique informed PDF processing limits, concurrency protection and evidence boundaries; it is not an independent security audit or legal certification. See [Claude review](claude-review.md).
