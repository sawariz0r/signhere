# Signhere reviews with Claude

> Historical review record: earlier sections describe their dated implementation snapshot, including features that were deferred then. For the current local-sealing foundation and remaining gates, see [implementation status](sealing-implementation.md), [architecture](architecture.md) and [SES cross-check](ses-spec-crosscheck.md).

Date: 2026-09-23. The local Claude Code CLI reported canonical model `claude-opus-5-5`. Two consultations informed this foundation: an initial architecture discussion and a later source review explicitly authorized by the user. Neither is an independent security audit, legal opinion or production certification.

## Initial architecture consultation

The first attempt stopped on expired OAuth credentials. After the user renewed authentication, a read-only, tools-disabled consultation completed. Claude considered the proposed single-node simple-electronic-signature foundation sound and identified these priorities:

- Protect last-signer completion from races and crashes; publish completed state only when its artifacts exist.
- Preserve original PDF bytes separately from the generated completed PDF and retain both hashes.
- Isolate PDF processing, bound its work, inspect parsed objects, and reject unsupported active content, existing signatures and revision structures.
- Bind consent and signatures to the exact document digest shown to the recipient.
- Treat recipient links as bearer credentials and use origin checks, clickjacking protection and no-referrer headers.
- Distinguish the sender-assigned recipient identity from the name claimed by the person signing.
- Bound password-hashing concurrency and restrict login attempts.
- Limit public verification to completed artifact hashes without personal details.
- Export portable evidence and an independently retainable audit checkpoint.
- Define retention, erasure and operator trust boundaries before production use.

The user subsequently requested PostgreSQL if it could run without Docker. A real portable PostgreSQL 18.6 instance now runs on loopback without a Windows service. The application uses explicit transactions and per-document row locks. Original and final PDF bytes remain database blobs so signatures, evidence and final artifacts share one commit boundary.

## Authorized source review

The later consultation inspected a source snapshot, read-only. It covered the database, security/signing helpers, PDF worker/engine and offline-verification code available to that review. Claude explicitly reported that it did **not** review `app.ts`; its requested `server/auth.ts` path did not exist. Authentication helpers are in `server/security.ts`, with routes in `server/app.ts`. A separate internal Codex review examined those routes.

The source review identified the following work, accepted for implementation and verification:

| Area | Accepted correction |
| --- | --- |
| Audit checkpoint | Bind the exported checkpoint to the final signature event and hashed completion event; reject inconsistent duplicate checkpoint fields. |
| Audit serialization | Normalize event payloads to the JSON representation PostgreSQL stores before computing their canonical hashes. |
| Database guards | Extend immutability beyond row updates: reject unsupported deletion/truncation and guard insertion into closed documents and invalid event-chain transitions. |
| Connection failures | Handle pool/client errors, preserve the original transaction failure if rollback also fails, and discard broken connections. |
| PDF structure | Distinguish a harmless bookmark `/Prev` pointer from a trailer's previous-revision pointer; keep the conservative unsupported-PDF policy explicit. |
| Plugin boundary | Deep-freeze the registered method and expose controlled lookup rather than a mutable exported registry; validate bounded plain-JSON provider evidence. |

These are review dispositions, not a claim that every originally reported detail applied to the final source. The code was changing during the review. For example, the completion event already contained a checkpoint by the time the final signing route was inspected. The final implementation and targeted tests determine whether a finding is resolved.

The internal route review additionally found and addressed or queued these concrete checks: invitation URLs must match frontend routes; creation events must bind the full recipient assignment, sender and document metadata; exported metadata must agree with those hashed snapshots; document lists should not load every signature and audit payload. Concurrent setup, signing/retry/cancellation, token rotation, cross-team access, expiry and finalization rollback remain important integration-test scenarios.

## Deliberate scope decisions

Only the draw method is enabled. Its evidence records self-asserted identity and link possession. An identity provider's authentication result, a provider signature over document data, a platform PDF seal and a trusted timestamp are separate capabilities.

Durable external-provider attempts and background finalization jobs are deferred. The current synchronous draw flow performs bounded PDF work inside a per-document transaction and commits only when final artifacts are ready. This avoids a half-published completion without introducing a queue. Future provider network calls must use persisted asynchronous attempts rather than holding a document lock while a remote user signs.

Recipient-capability exchange into short-lived cookies is also deferred. Fragment links, in-memory capability handling, no-referrer responses and hashed server-side token storage are the current boundary. Link possession still grants access; forwarding a link forwards that authority.

A local hash chain is a consistency mechanism, not a trusted timestamp or a cryptographic PDF signature. The first version makes no PAdES, advanced or qualified signature claim. A privileged host/database operator can rewrite local records; retained copies and checkpoints provide comparison material.

## Remaining release gates

- **PDF memory and isolation:** worker limits cap JavaScript heap use, not ArrayBuffer/native allocations or total RSS. Compressed streams can exceed the upload size substantially. Enforce decoded-stream and OS-level process-memory limits, preferably with a separate processing process, before treating hostile input as contained.
- **Database privileges:** the development application role is not a superuser, but it owns its schema and migrations. An owner can alter or disable its own triggers. Separate migration ownership from runtime DML grants for a hardened production deployment; triggers cannot establish operator-independent authenticity.
- **Authentication resilience:** current per-IP rate limiting and the bounded scrypt queue reduce abuse, but a process-global queue can still deny service to legitimate users under distributed load. Evaluate account-aware throttling, proxy trust and load behavior.
- **Retention and evidence access:** define personal-data retention/erasure, backup expiry and completed-copy access after recipient links expire.
- **Operational validation:** measure storage/concurrency limits, test backups and restoration, and validate the actual Docker image on a working Docker host. This machine used native PostgreSQL and Node.js; static Compose validation is not container execution.
- **Independent review:** complete an independent security assessment and jurisdiction/document-specific legal review before describing a deployment as production-ready or legally suitable.

See [Architecture](architecture.md), [Signing methods](signing-methods.md) and [Research](research.md) for the resulting boundaries and primary references.

## Final local checks

The final local run passed 14 automated tests (10 real PostgreSQL integration tests and 4 PDF-worker tests), TypeScript checks and a production build. A browser test passed signup, PDF upload and rendering, mobile draw signing, completed-file download, offline evidence verification, public hash verification and team invitation/member permissions. A PostgreSQL `pg_dump`/`pg_restore` roundtrip preserved the completed document and verifiable evidence in a disposable schema. Runtime dependency audit reported no published vulnerabilities at the time of checking. Compose configuration validated; Docker image execution was not available on this machine. These bounded checks do not replace the release gates above.

## 2026-09-24: next-phase PDF sealing plan

At the user's request, a tools-disabled Claude Opus 5.5 consultation reviewed the proposed sealing/finalization architecture and selected current source excerpts. The CLI confirmed `claude-opus-5-5`. Its verdict was to approve the direction and revise before implementation. See the [full critique and review scope](reviews/2026-09-24-claude-sealing-critique.md) and [revised implementation plan with dispositions](sealing-plan.md).

This is planning only. Durable finalization, PDF seals, key provisioning and trusted timestamps described there are proposed future work, superseding the earlier deferral as planning priorities, not claims that these features now exist. No application code was changed by this consultation.


## 2026-09-24: implemented local sealing foundation

The A-C foundation is now implemented and underwent actual Opus 5.5 design and source critiques, with a follow-up on fixes. Earlier deferrals and test counts above describe the original foundation, not the current implementation. See [delivered behavior, review dispositions and current release gates](sealing-implementation.md) and [SES spec cross-check](ses-spec-crosscheck.md). Trusted timestamping remains disabled.

## 2026-09-24: Fable 5.1 review of trust without BankID

At the user's request, Claude CLI ran a brief-only design review with the exact model `claude-fable-5-1`, confirmed by returned model metadata. The substantive written review completed in 60,268 ms. Its verdict was **revise**: local verification and timestamps improve the sealed record, but independent participant approval needs an additional mechanism.

The [full response and review scope](reviews/2026-09-24-fable-non-bankid-trust.md) are preserved alongside [assessed recommendations and corrections](reviews/2026-09-24-fable-trust-dispositions.md). In particular, self-hosted passkey enrollment and deterministic challenges do not alone defeat a dishonest operator or viewer; historical timestamp validity is not automatically lost on certificate expiry. The recommended next design is optional independent, document-bound approval with portable participant receipts.

Claude received the prepared architecture brief only. It did not inspect source, browse, or execute tests. This consultation changed documentation only and is not a security audit, legal certification, or implemented feature.
