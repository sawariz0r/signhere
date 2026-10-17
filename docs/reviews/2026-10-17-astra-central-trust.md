# Astra implementation-design consultation: central trust platform

Date: 2026-10-17. Requested by the user for the digest-only central-service plan.

- Configured provider/model: `codex-reviewer/gpt-6-astra` (confirmed by Paseo agent inspection).
- Paseo agent: `fc3dcf22-1155-429f-8611-7e214a207838`.
- Reviewed source HEAD: `bade218bf2b183d7561a777564c88b5f68a3aa8a`.
- Reviewed draft PR #12 snapshot: `0aea9b73d90cf1dd915a72eb2624d71afecef20f`.
- Scope: read source and existing draft; recommend implementation details. No application implementation or tests. Fable produced a provider plan artifact outside the repository; no repository edits were delegated.

This is advisor input, not an approved specification, security audit, pricing recommendation or certification. Read the [assessment and corrections](2026-10-17-central-trust-dispositions.md) and [current plan](../central-service-plan.md). These consultations preceded the final synthesized plan and are not reviews approving its exact final revision. Source links in Astra's response have been normalized to the reviewed GitHub revision; otherwise the response is preserved.

## Response

---

**Revise PR #12 around an optional digest-only receipt service.** Keep local signing and sealing free, enroll an installation automatically when its owner enables the service, and issue portable receipts for hashes of completed PDFs. Defer independent email approval, central PDF sealing, transparency logs and archival preservation.

I reviewed checked-out HEAD **`bade218bf2b183d7561a777564c88b5f68a3aa8a`**, plus the existing planning files and all 15 backlog tasks at **`0aea9b73d90cf1dd915a72eb2624d71afecef20f`**, using `git show`. No files were changed and no tests were run.

For review provenance: the draft includes an [actual, recorded Claude Fable 5.1 consultation](https://github.com/sawariz0r/signhere/blob/0aea9b73d90cf1dd915a72eb2624d71afecef20f/docs/reviews/2026-09-24-fable-non-bankid-trust.md#L1) and its qualified dispositions. That consultation reviewed an earlier brief, not this revised proposal. I did not initiate new Claude or Astra consultations, consistent with this assignment’s prohibition on additional orchestration. Do not describe the historical review as approval of the new design.

**The first release should promise independent recording of an exact file fingerprint.**

Recommended product explanation:

> Keep documents on your own server. The optional trust service records a cryptographic fingerprint of each completed PDF and returns a signed receipt. Anyone holding the PDF can check that receipt, including after your installation closes. Document contents, filenames and signer details are never sent to the service.

Immediately explain the limit:

> This confirms the recorded fingerprint. It does not verify the organisation, identify the signers or independently witness their consent.

That is a useful improvement: verification no longer depends solely on the originating installation’s database or its continued availability. It must not become a generic “trusted document” badge.

| Check | MVP assertion | Remaining trust |
|---|---|---|
| File/receipt match | The selected file’s SHA-256 equals the digest in an authentic central receipt | Hash assumptions and independently trusted receipt key |
| Central observation | The service states it recorded this digest at the displayed time | Central clock, operation and signing authority |
| Installation seal | Existing supported PDF/CMS checks establish signature integrity and coverage | Installation identity remains separately established |
| Participant consent | Existing local evidence records claimed approvals | A hostile installation can fabricate those records |
| Organisation identity | Not established by enrollment or payment | Requires a separate future identity process |
| Completeness/history | Not established | Receipts do not identify a unique legitimate version or expose all alternatives |

An attacker controlling an installation can submit arbitrary digests and obtain receipts within its entitlement. The service cannot determine from a digest whether a PDF exists, whether it is properly sealed, or whether its claimed events occurred. This limitation belongs in the protocol and verifier results, not only in documentation.

The existing architecture already makes the relevant distinctions: [seal/evidence/trust boundaries](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/docs/architecture.md#L54) and [hostile-operator limits](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/docs/architecture.md#L77). The historical Fable review’s central concern remains valid: stronger file evidence is not stronger independent participant approval.

**Use detached receipts first; retain RFC 3161 as a separate next capability.**

| Approach | Recommendation | Reason |
|---|---|---|
| Signed receipt over final PDF hash | MVP | Small API, small retained proof, simple browser checking, no PDF mutation |
| Another central PDF seal | Defer | Requires a more involved remote-signing protocol and profile work; still does not establish consent |
| RFC 3161 timestamp | Next optional capability | Adds a standard time assertion under an independently selected TSA trust policy |
| Public transparency log | Defer | Requires monitoring, consistency proofs and privacy decisions; a log alone does not establish consent or legitimate document identity |

Call the MVP’s time **“recorded by the service”**, not “trusted RFC 3161 timestamp.” RFC 3161 timestamps a message imprint and requires response and trust validation; its assertion concerns existence by a time, not the truth of the document’s contents. [RFC 3161](https://www.rfc-editor.org/rfc/rfc3161.html)

For a later TSA milestone, choose explicitly between:

- A detached token over the final PDF hash, retaining the same immutable-PDF delivery model.
- The already planned in-CMS signature timestamp, inserted before publication into reserved signature space.

The latter already has a useful [feasibility design](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/docs/rfc3161-feasibility.md#L7), but it is disabled today. [Application finalization](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/app.ts#L119) rejects policies other than timestamp-off. Neither choice implies LT/LTA preservation or Adobe-wide issuer recognition.

**Hash the finished PDF, then issue a separate proof.**

The sequence should be:

1. Freeze approvals and evidence using the existing flow.
2. Build, seal and validate the completed PDF locally.
3. Publish the exact completed bytes and their SHA-256.
4. Atomically queue registration of that hash.
5. Receive, validate and retain the central receipt separately.

Never append the resulting receipt, final hash, QR code or status page to that already signed PDF. That would change its hash and violate the existing strict profile. A generic verification URL can be placed in the PDF before sealing, without document-specific query parameters.

The current publication transaction already calculates and persists the completed hash alongside completion state and the event: [server/finalization.ts:114](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/finalization.ts#L114). The architecture explicitly describes [whole-file hash circularity](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/docs/architecture.md#L73).

Recommended receipt format:

- Standard compact JWS using an initially fixed `ES256` algorithm.
- Protected header allowlist: `alg`, `kid`, `typ`.
- Payload allowlist: `schema`, `serviceId`, `receiptId`, `digestAlgorithm`, `digest`, `recordedAt`.
- Fixed schema/type identifiers; `digestAlgorithm` must be `sha-256`.
- No document ID, title, filename, source/prepared hash, participant count, signer identity, instance URL or organisation claim.
- Preserve the exact issued JWS bytes. Verify those bytes before interpreting claims.
- Reject duplicate fields, unknown versions, unsupported algorithms and artifact-supplied key URLs.

JWS supplies the signature envelope; the application still needs its own strict claim and trust rules. [RFC 7515](https://datatracker.ietf.org/doc/html/rfc7515)

A receipt over the **final file hash** binds every byte of that particular artifact, including its seal. It does not certify the seal’s correctness. It also does not prove that the final visible pages match the prepared PDF approved by signers.

That distinction matters here because adding appendices reserializes the prepared PDF: [docs/architecture.md:60](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/docs/architecture.md#L60). Preserve PR #12’s approved-A/completed-B attack fixture. A central receipt for B must never turn the operator’s embedded claims about A into independent approval of B.

**Make enrollment one owner action, with machine credentials managed automatically.**

Add **“Use central trust platform — try free for 14 days”** to the existing owner-only instance settings. The current integration points are [InstanceSettings](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/web/settings.tsx#L113) and [GET /api/instance](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/app.ts#L659).

The normal flow should require no central account, card, email, DNS change, callback configuration or pasted API key:

1. The authenticated local owner enables the option.
2. The instance generates a dedicated service-authentication key in its private key volume.
3. It requests a short-lived central challenge and proves possession of that key.
4. Central creates a pseudonymous installation enrollment and returns the trial dates and limits.
5. The instance displays the active connection and expiry date.

Use a separate authentication key from the PDF-sealing key. This keeps certificate rotation independent of entitlement and avoids expanding the PDF key’s purpose.

Recommended authentication details:

- HTTPS plus a maintained implementation of HTTP Message Signatures.
- Bind method, authority, path, content digest and content type.
- Require key ID, creation/expiry times and a random nonce.
- Maximum request validity: five minutes; retain nonce replay records for ten minutes.
- Application retries use fresh authentication nonces.
- Business idempotency is separate from authentication replay protection. [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html)

Restore and rotation rules:

- Re-enrolling the same public key returns the existing enrollment and original trial dates.
- Back up enrollment state with the dedicated private key; a database-only restore cannot silently mint a replacement identity.
- Rotation requires the current key’s authorization and proof of possession of the new key, with an expected key-generation number.
- Retain the pending new key until the rotation outcome is reconciled after a crash.
- A stale restored credential receives an actionable recovery error.
- Losing all credentials cannot be repaired by presenting the same installation URL or organisation name.
- For paid recovery, provide a separately saved purchase-recovery capability; using it transfers the entitlement and disables the old authentication credential. It does not rewrite historical receipts.
- Never require recovery setup to finish the free trial enrollment.

The existing key store provides useful provisioning and mismatch precedents, but should not be reused wholesale for service authentication: [initialization](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/key-store.ts#L107), [rotation](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/key-store.ts#L212).

**Freeze a small API and schema, rather than accepting “metadata.”**

These are recommended contracts for the planning PR, not implemented endpoints. All JSON objects should reject unknown fields, duplicate keys, invalid encodings and excess nesting.

| Endpoint | Authentication | Exact application input |
|---|---|---|
| `POST /v1/enrollment-challenges` | Public, rate limited | `publicKey` |
| `POST /v1/enrollments` | Challenge proof | `challengeId`, `proof` |
| `POST /v1/enrollment-status` | Installation signature | Empty object |
| `POST /v1/key-rotations` | Current installation signature | `operationId`, `expectedKeyVersion`, `newPublicKey`, `newKeyProof` |
| `POST /v1/receipts` | Installation signature | `digest` |
| `POST /v1/receipt-lookup` | Public, rate limited | `digest` |
| `GET /v1/trust-bundle` | Public | No input |
| `POST /v1/checkouts` | Installation signature | `operationId`, `product` |
| `POST /v1/entitlement-recoveries` | Purchase-recovery capability and new-key proof | `recoveryToken`, `challengeId`, `proof` |

Concrete bounds:

- `digest`: exactly 64 lowercase hexadecimal characters.
- `publicKey`: public P-256 JWK containing only `kty`, `crv`, `x`, `y`; reject private components.
- `product`: only `yearly` or `lifetime`.
- Challenges expire after five minutes and are single-use, with deterministic retry handling.
- Receipt/lookup request bodies: at most 256 bytes.
- Enrollment, rotation and checkout requests: at most 8 KiB; headers separately bounded.
- Receipt responses: at most 4 KiB.
- No multipart, arbitrary attachments, compressed request bodies, free-text fields or caller-selected fetch URLs.
- Every signed proof binds its operation, service identity and applicable challenge/key material.

The checkout return page belongs to the central billing origin. The installation polls status; it need not expose an inbound callback or send its private hostname centrally.

Recommended central data model:

| Store | Allowlisted fields/purpose |
|---|---|
| Enrollments | Random enrollment ID, current key version, public keys/fingerprints, key status, creation time, original trial start/end, suspension state |
| Enrollment challenges | Random challenge ID/value, proposed public key, expiry and consumption state |
| Entitlements | Enrollment ID, product, paid-through time or lifetime flag, status, opaque purchase reference, update version |
| Receipt records | Digest, random receipt ID, recorded time, signing key ID, issuance state, exact signed receipt |
| Submission operations | Enrollment ID, digest, admission state/time and fixed error code; bounded retention |
| Rotation/checkout operations | Enrollment ID, random operation ID, request fingerprint and immutable result |
| Replay/rate-limit state | Key/nonce or short-lived network bucket, expiry, counters |
| Billing projection | Provider event/payment IDs, product, amount/currency and entitlement transition; recovery-token hash |
| Trust history | Public service keys, purposes, activation/retirement and authenticated incident/status records |

There should be **no generic JSON metadata columns** in document-related central tables.

Deduplicate receipt issuance by digest. Once a receipt exists, return the exact same bytes, including after expiry. Do not issue a fresh time merely because a client retried. Keep the submitter association out of the public receipt; the receipt’s claim does not require identifying who submitted it.

Public exact-hash lookup deliberately permits someone who knows the hash to discover registration and its recorded time. It must expose no installation identity, billing state, document list or surrounding records. This changes the existing backlog’s blanket prohibition on public hash lookup and needs an explicit disposition.

**The privacy promise must cover the entire operational path.**

Never send the existing evidence core centrally. It includes titles, filenames, names, email addresses and audit events: [server/evidence.ts:21](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/evidence.ts#L21). Even the existing public seal manifest carries information unnecessary for the receipt service.

Recommended operational defaults, subject to confirmation before launch:

| Data | Proposed retention |
|---|---|
| Exact signed receipts and historical public keys | Throughout service operation; downloadable for independent retention |
| Enrollment challenge state | Five-minute validity; purge within one hour |
| Replay nonces | Ten minutes |
| Raw IP/UA access logs | Disabled by default |
| Abuse network buckets | Daily keyed hashes, maximum 48 hours |
| Submission-to-enrollment association and completed operation records | 30 days |
| Sanitized operational errors | 14 days |
| Aggregate counters without identifiers | 90 days |
| Encrypted rolling backups | 30 days |
| Paid entitlement/payment references | Defined separately with the billing owner; no invented universal retention period |

Disable request/response-body capture, tracing payloads, session replay, automatic file attachments to errors and PDF crash dumps. Use fixed error codes. Do not place hashes, filenames, tokens or participant identifiers in URLs, metric labels, alerts or exception messages. Include proxy, CDN/WAF, hosting, database logs and payment-provider configuration in the inventory.

Billing is a separate data flow. Hosted checkout may process purchaser information; Signhere should retain only the necessary payment references and entitlement projection. Never send document digests to the payment provider. Do not describe all service processing as “anonymous” or “zero data.”

Strict schemas cannot prevent a malicious caller from encoding arbitrary bits in a purported digest. The enforceable commitment is that supported clients transmit only the defined material, and the service neither accepts document-upload functionality nor persists rejected payloads.

**Ship browser receipt checking before taking on browser PDF/CMS validation.**

There is no `web/verify.tsx` at this HEAD. Public verification is in [web/settings.tsx:8](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/web/settings.tsx#L8). It already hashes locally, but [POST /api/verify](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/app.ts#L696) merely checks the installation database.

Use two clear paths:

- **PDF plus saved receipt:** hash and verify entirely locally after application assets load.
- **PDF only:** explain that only its fingerprint will be sent, then retrieve the receipt through the bounded lookup endpoint and verify its signature locally.

For the second path, dropping the file can constitute the requested lookup if the preceding control explicitly says what leaves the device. Avoid an extra confirmation dialog.

The receipt verifier needs no PDF renderer or full PDF parser: it hashes bytes and validates a small signed object. This reduces implementation effort and attack surface. It must say **“File matches the central receipt”**, while reporting PDF seal validation as **“not checked here”** until the separate browser CMS work ships.

Additional requirements:

- No filename, file size, PDF metadata or parser diagnostics in requests.
- No analytics, remote fonts, third-party scripts or error collectors.
- No automatic certificate/AIA/OCSP/CRL fetches.
- No default storage of selected files in IndexedDB, caches or service workers.
- Strict origin isolation from marketing and billing.
- Allow only fixed API/trust destinations; never follow artifact-provided URLs.
- A portable authenticated verifier release and independently provisioned trust anchor.
- Distinguish missing receipt, unavailable lookup, invalid signature, unknown key and stale status.

A compromised hosted verifier can lie or exfiltrate data. Offline releases reduce dependence on the live origin; a checksum hosted beside compromised code is not an independent anchor.

**Make the proof available to recipients without exposing private evidence.**

The existing full package contains private audit evidence and requires team access: [server/verification-package.ts:5](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/verification-package.ts#L5) and [server/app.ts:579](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/app.ts#L579).

Add a small recipient-safe download containing:

- Exact completed PDF.
- Exact central receipt.
- Public trust material and provenance instructions.
- Minimal package manifest and verification instructions.

Keep it separate from the existing private evidence ZIP. Do not derive it by deleting fields from the committed evidence core: that would change the committed hash.

Add the receipt to owner exports and recipient copy pages. Completed-copy emails remain the responsibility of the self-hosted instance; the central service receives no recipient addresses. When anchoring is pending, the PDF remains downloadable and the page states that the receipt is not yet available.

Offline verification can survive both servers shutting down only if the holder retained the PDF, receipt, verifier and suitable trust material. Hashes cannot recover missing PDFs. Subscription expiry must never invalidate a preserved receipt.

For central key compromise, distinguish mathematical signature validity from historical trust. A receipt’s own asserted time cannot prove it predates compromise. Retain old public keys and authenticated incident records; report uncertainty when independent historical evidence is missing.

**Keep document completion and central receipt status separate by default.**

Recommended state model:

| Local document state | Central status | Meaning |
|---|---|---|
| `finalizing` | Not queued | Local sealing is unfinished |
| `completed` | `queued` / `retrying` | Sealed PDF exists; central receipt is pending |
| `completed` | `recorded` | Receipt validated and saved locally |
| `completed` | `needs_payment` | New central issuance requires entitlement |
| `completed` | `action_required` | Credential, protocol or persistent operational failure |
| `completed` | `off` | Local-only transaction |

This is an explicitly asynchronous supplementary service. Do not market a completed local PDF as already centrally recorded while the receipt is pending.

Enqueue the outbox record in the publication transaction. The existing transaction callback at [server/finalization.ts:129](https://github.com/sawariz0r/signhere/blob/bade218bf2b183d7561a777564c88b5f68a3aa8a/server/finalization.ts#L129) is appropriate; the after-commit notification callback alone is not durable.

Implementation details:

- One outbox row per local completed artifact and selected service.
- Retain the exact final digest; never rebuild the PDF to retry registration.
- PostgreSQL leases, fencing, bounded concurrency and exponential backoff with jitter.
- No network calls while holding document locks.
- Validate the returned signature, service identity, schema and digest before storing success.
- Crash after central issuance but before local persistence recovers the same receipt.
- Rate limits/outages retry; entitlement denial becomes `needs_payment`; invalid signatures or mismatched digests require action.
- Pause automatic outage retries after seven days with a visible retry action; retain the job and immutable input.
- Re-enabling payment resumes pending eligible work without asking signers to sign again.
- Disabling the setting affects new documents; existing queued work remains visible and manageable.

Freeze the selected service and requested supplementary behavior locally when creating a new transaction. Do not silently substitute another authority for an outstanding request.

Keep any future **required** timestamp/receipt policy separate. If expressly required before invitations, failure must keep the transaction pending. The current required-TSA rules must not be weakened to implement the simpler asynchronous receipt default.

**Define the commercial lifecycle precisely.**

Recommended defaults:

- Trial starts when central enrollment succeeds after the owner explicitly enables it—not at installation, first boot or a failed connection attempt.
- Expiry is exactly `trialStartedAt + 336 hours`, using central time.
- Restarts, restores, disable/re-enable and key rotation do not restart it.
- Show the expiry date immediately.
- No card, email, account registration or manual API key.
- Trial allowance: provisionally 100 new receipts total, with a modest burst limit. Display this before activation.
- At expiry, stop admitting new receipt issuance. Keep public lookup, trust material, receipt downloads and offline verification free.
- Work durably admitted centrally before expiry finishes without purchase, even if receipt signing/delivery completes later.
- A locally queued request first reaching central after expiry needs payment. Do not trust a caller’s claimed creation time to bypass expiry.
- No automatic historical backfill; a later registration is visibly recorded at the later time.

Anonymous trials cannot reliably enforce “one trial per organisation.” Fresh keys and changing network addresses can bypass limits. Accept some abuse; use quotas, short-lived network throttles and global budgets. Do not add a card, phone number or organisation verification merely to eliminate this unavoidable tradeoff.

For purchases:

| Product | Recommended lifecycle |
|---|---|
| Yearly | Prepaid year, manual renewal by default; no automatic charge |
| Lifetime | One installation entitlement with credential rotation and recovery; no recurring charge |

For yearly payment, use a precisely documented anniversary rule, extending from the later of payment time or current paid-through time. Define leap-day handling. Buying during the trial should preserve remaining trial time.

Use hosted checkout, signed webhook verification and idempotent processing of provider event/payment IDs. A browser success redirect is never sufficient to grant entitlement. Reconcile interrupted or out-of-order payment events. Refunds or chargebacks affect future issuance, not previously issued proofs.

“Lifetime” needs explicit commercial wording: one enrolled installation, transferable through recovery, while the service operates, with disclosed capacity limits. It cannot imply guaranteed perpetual hosting or indefinite cryptographic assurance. Both products should carry the same trust claim.

**Revise the existing planning PR rather than creating a competing plan.**

Suggested revised title:

> Plan optional digest-only trust receipts, one-click trial and portable verification

The [existing plan](https://github.com/sawariz0r/signhere/blob/0aea9b73d90cf1dd915a72eb2624d71afecef20f/docs/central-service-plan.md#L44) explicitly processes central email approval, and its [data inventory](https://github.com/sawariz0r/signhere/blob/0aea9b73d90cf1dd915a72eb2624d71afecef20f/docs/central-service-plan.md#L84) retains addresses/context. A new introduction alone would leave contradictory requirements.

Recommended dispositions:

| Existing task | Revision |
|---|---|
| CEN-001 | Make digest-receipt claim, formats, limits and hostile-instance behavior the initial protocol |
| CEN-002 | Add automatic enrollment, signed authentication, quotas and receipt issuance; remove approval-session dependencies from MVP |
| CEN-003 / CEN-004 | Mark deferred, separately opt-in independent-approval proposal requiring a future privacy-scope decision |
| CEN-005 | Add final-hash outbox slice; separate supplementary receipt behavior from required TSA/approval policy |
| CEN-006 | Retain authenticated trust distribution and incident handling; scope keys to digest receipts |
| CEN-007 | Keep as optional subsequent timestamp milestone |
| CEN-008 | Split small receipt verifier from full PDF/CMS verifier; explicitly document optional digest lookup |
| CEN-009 | Deliver recipient-safe PDF/receipt packages without CEN-004 dependency |
| CEN-010 | Replace initial address/context inventory with exact digest-only allowlists and concrete retention proposals |
| CEN-011 / CEN-012 | Retain recovery, privacy, hostile-input and shutdown gates for the enabled scope |
| CEN-013–015 | Keep deferred |

Add two distinct tasks: installation enrollment/recovery UX, and trial/payment entitlement lifecycle. [CEN-002 currently excludes billing](https://github.com/sawariz0r/signhere/blob/0aea9b73d90cf1dd915a72eb2624d71afecef20f/docs/backlog/signhere-central/CEN-002-service-foundation.md#L91), so that work must not disappear into implementation assumptions.

Preserve the historical Fable review unchanged. Add a disposition explaining that its stronger independent-approval recommendation is deferred because the user now requires a narrower central data boundary.

**Implement through small PRs with claim-specific acceptance checks.**

| PR | Deliverable | Meaningful acceptance checks |
|---|---|---|
| 1 | Revised plan, protocol and fixtures | Every central field justified; hostile-instance claims explicit; approved-A/completed-B never implies approval of B |
| 2 | Receipt signing, trust bundle and independent verification library | Changed digest/payload/signature, wrong key, unknown schema and algorithm substitution fail; independent implementation verifies fixtures |
| 3 | Enrollment, authentication and key lifecycle | One-click enrollment; no card/account/API-key entry; replay, cross-enrollment access, duplicate enrollment, rotation crashes and mismatched restore handled |
| 4 | Central admission and receipt persistence | Concurrent same-digest requests return one retained receipt; crash boundaries recover; expiry admission is atomic; payload limits and privacy logging hold |
| 5 | Local outbox and settings | Publication/outbox atomicity; local completion survives central outage; stale workers cannot publish success; retry never mutates PDF bytes |
| 6 | Browser verification and recipient exports | No PDF/name leakage in successful or failing flows; offline receipt checking works; private audit ZIP remains restricted; expiry does not gate verification |
| 7 | Yearly/lifetime purchase and recovery | Webhook replay/order failures, cancelled checkout, renewal boundaries, restore, recovery and refunds behave correctly; no implicit recurring charge |
| 8 | Operational release evidence | Key incident, backup/deletion reconciliation, outage and both-services-offline drills; bounded load; independent review of shipped claims |

Use synthetic canaries for titles, filenames, addresses and PDF text. Inspect browser network traffic, API/proxy logs, error collection and backups, including rejection paths. Check resulting user wording as well as cryptographic return values.

**Keep deployment simple and independent of the eventual domain.**

Use a separately deployed Node/TypeScript service and PostgreSQL, with a bounded worker and protected receipt-signing authority. Avoid Redis, a document object store, central email infrastructure and microservice proliferation for this MVP. A managed signing key is preferable if operational cost is acceptable; a fallback custody design needs an explicit review rather than assuming equivalent isolation.

Treat `signhere.se` as branding/configuration. Receipts bind a stable service identity and trusted signing authority, not a hostname chosen by a PDF. Alternate operators use separate anchors. Domain migration changes endpoints without invalidating historical receipts or silently changing the trusted authority.

The remaining product decisions are the exact yearly/lifetime prices and quotas; lifetime terms and transfer limits; acceptance of public exact-hash lookup; retention and shutdown commitments; signing-key custody and independent trust distribution; and whether RFC 3161 is needed before paid launch. My default is the narrow receipt service above, with asynchronous anchoring and prepaid yearly renewal. If marketing requires independently trusted time, move the TSA milestone before that claim is offered.
