# Central trust platform: simple connection and digest-only receipts

Status: proposed implementation plan, 2026-10-17. Documentation only; no service, payment, deployment or new signing assurance exists yet. This is the current scope for draft PR #12. The [earlier extended design](central-service-extended-design.md) and CEN-001–015 are historical research, not launch requirements. Start implementation from [CEN-016–022](backlog/signhere-central/README.md).

## Product decision

Install Signhere, choose **Använd centrala tillitsplattformen**, and receive 14 days free. No account, card, certificate purchase, inbound network access or pasted API key. After the trial, the owner can sign up and buy a small yearly plan or a lifetime plan. Self-hosted signing remains available without central registration. Checking previously issued receipts never requires payment.

The first release records the SHA-256 fingerprint of an exact completed PDF and returns a portable central signature over that record. The backend receives no PDF, title, filename, document ID, parties, addresses, drawings, consent, prepared-file hash or audit evidence. Billing contact information has a separate purpose and never enters document receipts.

Suggested owner copy:

> Gör det möjligt att kontrollera dokumentets fingeravtryck även om din instans stängs. Vi sparar bara fingeravtrycket och ett verifieringskvitto – aldrig dokumentet eller uppgifter om parterna. Prova gratis i 14 dagar, utan konto eller kort. Därefter väljer du årsbetalning eller engångsbetalning. Tidigare kvitton kan fortsätta verifieras utan kostnad.

Explain in a short expandable detail that network metadata is processed and that registering a fingerprint does not verify people's identity or consent. Final Swedish copy needs UX review.

## Supported trust claim

| Result | Supported statement |
| --- | --- |
| Central record matches | This exact file fingerprint was registered by an enrolled installation at the service's recorded time. |
| Portable receipt signature matches | A trusted central receipt key signed the receipt covering this file's SHA-256. Online lookup is unnecessary. |
| Local seal/evidence checks pass | The separate existing verifier reports supported PDF integrity/evidence and issuer trust results. |
| No central record | No record was found; this does not establish forgery or invalidate local signing. |
| Central unavailable | Online status is unavailable; a retained receipt can still be checked offline. |

A blind digest service cannot inspect a PDF, establish completion, validate its seal, witness consent, establish civil/organisation identity or prevent a hostile operator registering invented records. Enrollment proves possession of an installation credential. Do not present a universal green “valid signature” badge. Registration time is durable first central admission of this hash, not human signing time; later receipt signing/delivery preserves that recorded time. No RFC 3161, Adobe/OS certificate trust, qualified signature, independent approval or non-equivocation claim.

The approved-A/completed-B attack in the earlier plan remains relevant: receipt(B) registers B; it never proves anyone approved B or its visible pages equal A. Keep registration, local cryptographic integrity, issuer trust, identity and approval separate in verifier output.

## One-click connection

1. The instance owner enables the feature in **Inställningar → Instans**, also offered during setup, default off. The browser calls its own server. Protect owner mutations with session authorization, origin and CSRF checks.
2. The server generates a dedicated Ed25519 connection key in the private key volume, separate from the PDF seal key. PostgreSQL retains its public thumbprint, central installation ID and service identity. Include both key and state in coherent backup/restore.
3. Obtain a five-minute central enrollment challenge, sign it, and enroll idempotently by public-key thumbprint. The central clock records `trialStartedAt` on first successful enrollment and `trialEndsAt = start + 14 × 24 hours`. Retries and same-key restores return original dates. The button states that enabling starts the trial, even before the first document.
4. Authenticate operations with a maintained HTTP Message Signatures implementation (RFC 9421) over HTTPS. Bind method, authority/path, content type/digest, key ID, fresh authentication nonce and creation/expiry times. Proposed validity: five minutes and maximum two minutes clock skew; nonce retention ten minutes. Keep business idempotency IDs separate from authentication nonces; each retry signs a fresh request. CEN-016 supplies exact covered-component rules and vectors.
5. Only outbound HTTPS is needed. No central fetch of the instance, domain ownership check, webhook callback or arbitrary URL supplied by a PDF. Private/NAT installations work.

Use single-use challenges, body-bound business request IDs and bounded replay state. A clock error never resets the trial. PDF seal rotation does not change enrollment. Connection-key rotation requires proof from old and new keys, preserving plan and key history. Paid-account recovery replaces a lost key and disables the old credential without rewriting receipts. Anonymous lost-key continuity cannot be proven: disclose new enrollment and abuse limits. Clones sharing a key share the same trial/quota. One plan covers one logical installation, including recovery, rather than arbitrary fleets.

## Minimal wire contract and stored data

These are proposed contracts for CEN-016, not implemented endpoints. Reject unknown fields, duplicate JSON keys, unsupported versions, wrong content type and oversized/malformed inputs. Proposed request cap: 8 KiB.

| Operation | Allowed data and result |
| --- | --- |
| `POST /v1/enrollment-challenges` | Public key → random challenge and expiry; no email/instance URL. |
| `POST /v1/installations` | Public key and signed challenge → installation ID, original trial dates, entitlement. |
| `POST /v1/records` | Authenticated payload exactly `{schema: "signhere-register-v1", sha256: <64 lowercase hex>}` → immutable signed receipt. Request ID is random and unrelated to local document IDs. |
| `POST /v1/lookup` | Exactly one SHA-256 → one retained receipt or `not_found`; public, no account or file. |
| `GET /v1/entitlement` | Instance authentication → server-derived state/dates. |
| Key rotation / billing linking | Separate authenticated control operations specified in CEN-017/021; no document fields. |
| Public trust material | Release-root-authenticated current/historical receipt keys, stable service identity and incident status. |

Receipt: protected JWS header with fixed `alg`, `kid`, `typ`; payload exactly `schema`, stable `serviceId`, random `receiptId`, `sha256` and server `registeredAt`. No installation identifier, PDF certificate, document context, billing data or subscription expiry. Default proposal is Ed25519/EdDSA for compact receipts; CEN-016 must prove browser/server/offline compatibility before freezing it. ES256 is the alternative if custody or supported clients require it. Never negotiate algorithms from an untrusted artifact.

Central tables:

| Table | Minimum fields |
| --- | --- |
| `installations`, `connection_keys` | Random IDs, public keys/thumbprints, original trial dates, key status/history, optional opaque billing-account relation. |
| `records` | Unique SHA-256, receipt ID, central time, signing-key ID, exact immutable signed receipt. No permanent submitter/account relation. |
| `submission_operations` | Temporary installation/request-ID relation, hash, central admission state/time and result reference; purge terminal operations within 30 days; retain unresolved admitted work until recovered. |
| `request_replays`, `enrollment_challenges` | Expiring random IDs, request digest/result relation, challenge/expiry; no document context. |
| `entitlements` | Installation/account relation, yearly/lifetime type, effective dates, payment references, suspension. |
| Billing state | Customer contact/processor IDs, purchase terms/version, deduplicated events; separate access from public records. No hashes, receipt IDs or document counts in processor metadata. |

Deduplicate globally by SHA-256 and return the original signed receipt/time, including after expiry or submission from another installation. Public exact-hash lookup reveals no submitter or document list. The receipt records first central observation, never unique ownership or a fresh time for a later submission. A known hash reveals membership; hashes and temporary submission metadata are not anonymous. POST bodies keep digests out of ordinary URL logs. Strict schemas cannot stop a malicious caller encoding arbitrary bits into a purported hash; supported clients send only genuine digests and rejected payloads are never persisted.

No document parser/upload handler in the central backend. No PDFs in storage, backups, queues, diagnostics, analytics, support tools or mail. Disable body capture throughout proxy, app, tracing, error reporting and provider defaults. Process network metadata minimally: propose ten-minute nonce retention and challenge cleanup within one hour, rotating keyed IP-abuse buckets up to 24 hours, scrubbed error codes seven days and encrypted rolling backups 30 days. No raw persistent access logs on sensitive routes. Final region/provider and billing retention obligations are launch decisions, not legal retention claims.

Issued records remain available independently of subscription while the service operates. Publish deletion, backup-aging and shutdown terms; keep offline proof exports available. Account deletion does not silently imply removal of historical proof; choose and disclose that policy before real customers.

## Integration with completion

Keep the final PDF byte-for-byte. Its own whole-file hash and receipt cannot be embedded in the same final file without circularity or a new signature revision. Deliver `trust-receipt.jws` beside the PDF and in a portable package.

Apply the MVP to newly created evidence-v2 documents, including each bilaga independently; no automatic legacy/history backfill. Capture opt-in for each new transaction. Later settings affect future transactions and never rewrite completed artifacts. MVP registration is additive; it does not promise “required central proof before completion.” Existing required timestamp policy remains separate and fails closed as designed.

Use the transactional publication hook in `server/finalization.ts` to enqueue one local `trust_registrations` row alongside completed bytes/hash and completion event. Compose with the existing email enqueue hook. Store local document ID, frozen hash, destination/service identity, stable request ID, state/lease/generation, attempts, next retry and safe error code. No network call inside document transactions or PDF/key workers.

A PostgreSQL-leased worker registers the frozen completed hash after publication. Validate receipt signature, trusted key, service identity and exact hash before storing exact receipt bytes. Fence stale workers. Retry transient errors with bounded exponential backoff/jitter and `Retry-After`; proposed range five seconds to one hour for up to 48 hours, then visible owner-action state. No silently abandoned work. `payment_required` pauses until purchase, retaining queued work and existing receipts. A receipt already present is always freely retrievable. New work durably admitted centrally before expiry completes under that admission even if signing happens later; new, unadmitted hashes require current entitlement. Admission and deduplication are atomic and recoverable after crashes. Late registration uses actual central acceptance time, never backdated document time.

Display document completion separately from central states: `pending`, `registered`, `retrying`, `payment_required`, `action_required`, `disabled`. Only a verified receipt enables `registered`. Turning the connection off stops further sends and retains proofs; the owner can explicitly resume eligible queued work. Central outage must not turn local success into a false central-success badge.

Extend `server/verification-package.ts` with the receipt and instructions. Give recipients a narrowly scoped receipt/proof download through existing document access, without the private audit core or other parties' details. Immediate PDF delivery must not wait for central registration. A separate follow-up receipt or later proof download resolves that race; it never changes the emailed PDF. CEN-019 must choose one clear default and test pending/ready delivery.

## Verification

Use a dedicated trust origin without marketing scripts. Selecting a PDF hashes its bytes locally. An explicit “Kontrollera fingeravtryck” action sends only that digest to public lookup. No automatic upload, filename telemetry, remote PDF viewer, error attachment, certificate-directed fetch or third-party script. Restrictive CSP, no account required.

Online verification checks the returned receipt signature against independently trusted central keys and reports exact-file registration/time. Full browser-local CMS/PDF validation needs a separate library/profile spike and is deferred. The existing offline seal/evidence verifier remains a separate cryptographic path; a database hash match cannot stand in for it.

Portable verification takes PDF plus receipt, hashes locally and verifies against installed trusted keys, without lookup. The CLI supports receipt checking without a private evidence package and optionally combines it with existing seal/evidence results. Receipt verification and authenticated historical public-key distribution ship together. Distribute authenticated verifier releases separately; software bundled by an untrusted sender is not itself trustworthy.

Bootstrap from a shipped release root/manifest, never a receipt-supplied key or arbitrary `jku` URL. Keep historical keys, rotation proofs and incident cutoffs. A stable service ID is independent of TLD and endpoint configuration; a domain move must not invalidate receipts or silently replace authority. Central compromise can produce false receipts/time, and offline checks cannot discover new incidents without fresh status. A compromised key can sign a falsely old time; a receipt’s own date does not prove it predates compromise. Report historical uncertainty unless independent evidence establishes the cutoff. Describe this residual trust; no independent timestamp, permanent availability or transparency guarantee.

## Trial and payment lifecycle

| State | New registrations | Historical checks |
| --- | --- | --- |
| Disabled | None | Free |
| Trial before central `trialEndsAt` | Allowed within published quota | Free |
| Trial expired / unpaid | Pause; prompt owner to sign up | Free |
| Yearly before `paidUntil` | Allowed | Free |
| Lifetime | Allowed under purchased one-installation terms | Free |
| Yearly cancelled | Allowed until paid-through date, then paused | Free |
| Refund/chargeback/abuse suspension | Defined billing policy controls future issuance | Existing proofs stay intact; security incidents reported separately |

Trial boundary is durable central admission time, not local clock or enqueue time. No card, mandatory signup, automatic charge or silent renewal for the trial. Show dates immediately and prompt the owner near/after expiry. Signers never see payment demands. No anonymous-trial reminder emails.

Recommend one year prepaid with explicit renewal, plus one-time lifetime purchase. If auto-renewal is later selected, obtain checkout consent. One logical installation, with recovery/transfer rules; no per-signer fee. Actual small yearly/lifetime amounts remain the owner's pricing decision. Buying during the trial preserves its remaining time; yearly access extends from the later of payment, trial end or current paid-through date. CEN-021 defines a calendar anniversary/leap-day rule before implementation.

The authenticated owner creates a short-lived billing-link session bound to that instance and one-time state. Open central signup/hosted checkout; poll entitlement outbound. A browser redirect never grants a paid plan. Verified, deduplicated processor webhooks or server reconciliation update entitlements from authoritative payment state. Out-of-order events cannot extend access twice or resurrect a refunded purchase; lost local responses recover on refresh. No card data in Signhere. Central account authentication must not grant document access on the self-hosted instance.

Before sale, define “lifetime” plainly: proposed meaning is use of this hosted service for its operating lifetime, for one installation, with no renewal fee. No perpetual infrastructure promise. Choose sustainable quotas, price, replacement/transfer, refund and service-exit terms. Receipt payloads have no subscription-expiry field.

Anonymous trials cannot be made one-per-human with this setup. Rate-limit enrollment/issuance, publish per-instance quotas, and accept bounded repeat-trial abuse initially. No hidden device fingerprinting or mandatory email to pretend Sybil abuse is solved. Costed launch limits and paid limits are implementation gates; capacity does not change assurance.

## Deployment and delivery

Prefer a separate TypeScript/Express service plus PostgreSQL, one supervised PostgreSQL worker loop and a static verifier. Reuse maintained validation/crypto libraries, not the document database or private handlers. No Redis, object storage, blockchain, transparency log, remote PDF parser or PDF-key upload is required. Separate billing/admin privileges and trust-origin frontend code. Receipt keys live outside the database; use secure key backup, an offline release trust root, rotation and incident procedures. Choose the custody/hosting product before production.

Implement seven reviewable changes in [CEN-016–022](backlog/signhere-central/README.md): protocol/vectors; service/enrollment; local outbox; verifier/exports; onboarding; billing; operational/adversarial release evidence. These are planned changes, not features delivered by this PR. Zero central credentials must remain a supported self-hosted setup.

Release evidence must cover all privacy boundaries, arbitrary hostile-instance registration with honest labels, receipt substitution/tampering, lost responses/replay/concurrency, trial/payment races, restore/rotation, verification after expiry/local shutdown, outages and central database/key recovery. No implementation tests are claimed by this documentation PR.

## Decisions before launch

- Domain/TLD, dedicated origin, EU hosting provider/region, key custody, service owner and recovery targets. Availability has not been checked; no domain is purchased here.
- Actual yearly/lifetime prices, sustainable quotas and precise lifetime/transfer/refund/retention terms.
- Strict wire formats, algorithm interoperability, idempotency/replay retention, public lookup bounds and incident behavior (CEN-016).
- Receipt delivery/download UX and working browser/network privacy evidence (CEN-019/020).

Browser CMS validation, RFC 3161 timestamps, independent participant approval and organisation recognition each need a separate proposal. They do not block this narrower registration feature and cannot silently add document metadata to its API.

## References and review

The [architecture](architecture.md), [local seal design](sealing-plan.md), [timestamp feasibility](rfc3161-feasibility.md) and [extended research](central-service-extended-design.md) explain existing boundaries. Standard-envelope references: [JWS, RFC 7515](https://www.rfc-editor.org/rfc/rfc7515) and [Ed25519 in JOSE, RFC 8037](https://www.rfc-editor.org/rfc/rfc8037), and [HTTP Message Signatures, RFC 9421](https://www.rfc-editor.org/rfc/rfc9421). [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161) describes the separate timestamp protocol, not this receipt service.

The requested [Fable 5.1 and OpenAI Astra consultations and assessed corrections](reviews/2026-10-17-central-trust-dispositions.md) informed this plan. Both read source and the earlier PR snapshot; they did not approve this final synthesized revision or certify an implementation.
