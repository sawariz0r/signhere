# Sealing foundation implementation, 2026-09-24

This implements local PDF seals, portable verification, durable finalization and certificate lifecycle (the plan's A-C foundation). It is an SES application: drawn signatures and personal-link possession do not establish e-ID identity. BankID is still a future method. Trusted timestamping is a separate, disabled milestone; `required` fails closed. No PAdES qualification or production-readiness claim is made.

## Delivered behavior

- New production documents use evidence v2. Exact per-recipient approval context, consent and prepared-document hash are frozen before links are issued. Consent is read from that snapshot throughout signing and finalization, so a software update cannot change a pending agreement's consent.
- PDF creation performs a public-certificate sealing preflight before anyone is invited. Existing automatic flattening remains; the raw upload is retained when its bytes differ. Every signer approves the same prepared bytes, not a server-regenerated version.
- Accepted signatures commit independently of PDF work. The final approval freezes the evidence core and enqueues a PostgreSQL job. Leases, fencing and immutable attempt history make retries and process restarts safe. The UI says the signature is saved while the PDF is being prepared.
- The finished PDF contains a single installation CMS seal covering the complete file, including an evidence-core digest and document/installation/checkpoint bindings. The exact final PDF hash is stored outside that PDF. Altered bytes, unsigned tails and mismatched evidence fail the portable verifier.
- Each installation provisions its own persistent local identity. BYO PKCS#12 is supported; historical public certificates survive explicit rotation. Missing or mismatched key state does not silently regenerate an identity. Administrators have explicit rotation, lost-key recovery and pinned-job retry commands.
- Authorized team users can export a complete portable bundle. Participant receipt and renewed copy links return the sealed PDF only; they do not disclose all participants' IP/user-agent evidence. Renewed copy links can be revoked without changing signed evidence.
- `/verify` remains public and hashes files locally for a database match. It clearly distinguishes that lookup from independent cryptographic verification. Offline verification needs no running Signhere instance and reports integrity separately from explicit fingerprint trust, timestamp absence and identity assurance.

## Claude Opus 5.5 review dispositions

Three actual tools-disabled CLI reviews used `claude-opus-5-5`: [design](reviews/2026-09-24-claude-sealing-implementation-design.md) [implementation source](reviews/2026-09-24-claude-sealing-code-review.md), and [follow-up on fixes](reviews/2026-09-24-claude-sealing-followup.md). Source review received no credentials, private keys, database records, contract contents or design assets. Claude did not execute tests; local checks below are separate evidence.

| Finding | Disposition |
| --- | --- |
| A1: deterministic PDF failure after approval | Creation dry-runs the appendix and public prepare stage before issuing invitations. Finalization can still fail from operational outages, handled by durable retries. |
| A2: transient key errors stop retrying | Unavailability uses bounded retry/backoff; mismatch, unsafe permissions, expiry and recovery requirements remain explicit operator states. |
| A3: rotation strands pinned jobs | Explicit administrator CLI can retry with the current identity. Ordinary retry never silently changes the job's pinned identity. |
| A4: consent drift | Session, acceptance, submission digest, frozen evidence and appendix all use persisted consent. Regression covers an earlier consent version. |
| A5: parser stage can replace CMS artifacts | Prepare, private-key CMS and verify have separate temporary directories. Node captures bounded regular files by descriptor, checks candidate prefix/tail/ranges, and retains its own CMS bytes before verification. CMS checks the supplied candidate digest/length and returns output digest; Node checks requested manifest and certificate against results. |
| A6: incompatible size budgets | Canonical drawn strokes are capped at 64 KiB, recipients at 25, and link-rotation history at 1000 events. Separate bounded viewing/download/export lanes hold slots until finish/close, cap each principal, briefly queue excess requests and use a progress-based socket idle timeout. ZIP output avoids an extra whole-buffer copy. |
| A7: participant evidence disclosure | Full JSON/ZIP requires authenticated team access. Bearer downloads contain only the sealed PDF. Copy-link revocation is scoped to one document/recipient. |
| A8: permanent trust verdicts | Store certificate, manifest and PDF hash facts only. Trust, integrity and certificate-time judgments are recomputed by the verifier. The public certificate endpoint explicitly is not a trust anchor. |
| A9: smaller issues | Owner authorization for retry, terminal codes for deterministic frozen-state failures, intent digest in submission hash, public health without internal reason codes, and truthful dumpability comments. CLI fingerprint handling is checked separately. |

Isolation protects private-key confidentiality from the sandboxed PDF processes. It does not make a compromised parser/rendering pipeline a trustworthy account of visible contract content: a bounded incremental tail can still alter PDF interpretation. The Node application and PDF transformations remain in the signing-integrity trust boundary. This limitation is not solved by calling the key worker independent.

## SES spec comparison

See [the requirement-by-requirement cross-check](ses-spec-crosscheck.md). One deliberate difference remains: after approval, the personal signing link retains read-only receipt access for 30 days, and an exact idempotent retry returns the saved result. It cannot create a second or different signature. This is not literal raw-token invalidation; a separate receipt-capability exchange is deferred. Creation/rotation expiry is configurable from 1 to 365 days, default 7.

Semantic audit events combine actions performed in one transaction: `document.created`, `recipient.viewed`, `recipient.signed` and `document.completed`. A viewed event means signing-session access, not proof the person read every page. V2 signature evidence explicitly includes personal-link authentication, consent acceptance/signing UTC time, recipient and document/transaction identifiers. A document ID is also the transaction/revision ID; corrections require a new document.

Existing v1 completed artifacts and evidence are unchanged. Existing v1 pending documents complete through their tested legacy path and remain unsealed; they are never silently upgraded. New production entrypoints cannot opt into legacy creation.

## Validation and remaining gates

Final native checks: 76 Node tests, 74 passed and 2 POSIX-only checks skipped on Windows; 9 Python engine tests passed. TypeScript/production build and the real browser workflow passed. These are local results, not container execution.

The real PostgreSQL/API suite covers immutable evidence, queue fencing/retry, legacy behavior, key provisioning and recovery, sender/client separation and standalone exports. The browser test covers the supplied Swedish flow including mobile drawing. Cryptographic engine tests reject malformed coverage, changed evidence, extra revisions and certificate substitution. OpenSSL independently accepted the CMS signed bytes; Poppler rendered the candidate and sealed file identically, but its bundled signature backend was unavailable, so it did not independently validate the PDF signature.

Before a production release, run the actual Docker image and Landlock/seccomp tests on Linux, maximum-size/concurrency memory tests, mismatched database/key restore drills, an independent PDF reader/signature validation corpus, and an independent security review. Windows development runs are not an OS sandbox assurance. Docker/WSL were unavailable here; their execution was not attempted as a workaround.

[RFC 3161 feasibility](rfc3161-feasibility.md) records successful mock validation and the remaining transport/trust work. Trusted timestamps, revocation checking and BankID are not enabled. A local seal detects alteration relative to a retained trusted fingerprint/copy; an operator holding its key can issue another seal and a drawing is not biometric identity verification.


### Follow-up dispositions

The actual third Opus review caught two integration issues. Replaced the global single export slot with separate bounded lanes (two concurrent document views, one completed download, one private export), per-principal caps and a five-second bounded queue. Slow but progressing downloads have no fixed total deadline. Added concurrency/queue/error-cleanup regressions.

PDF infrastructure errors now produce a service-unavailable response instead of telling the sender to re-export their file. A cached single-flight readiness probe runs a tiny trusted document through the real appendix/public sealing pipeline; missing required isolation fails readiness and document creation before invitations. Creation snapshots the validated key identity once and passes its full public chain to preflight. The public prepare stage checks CMS placeholder capacity with a dry run.

Other follow-up points were checked: the actual Python function is `async def` (the source excerpt had accidentally omitted `async`); identity creation already uses `mkdir(mode=0o700)` and rotation now asserts that on POSIX; missing-key retries were already bounded to five attempts. Maximum-size/concurrency Linux resource measurement remains a release gate, not a promise inferred from the tiny readiness probe.

Local deployment check: the main development app was restarted after a PostgreSQL backup. All four existing completed documents retained their original/final hashes and event counts; the installation provisioned one sealing identity. Existing documents remain legacy and were not rewritten.
