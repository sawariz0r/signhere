# signhere.se central service: proposed architecture and delivery plan

Status: planning only. Updated: 2026-09-25. No service, deployment, signing method or retention promise is introduced by this document.

Start with the [delivery backlog](backlog/signhere-central/README.md). The [Fable review](reviews/2026-09-24-fable-non-bankid-trust.md) and [assessment](reviews/2026-09-24-fable-trust-dispositions.md) explain the decisions; the assessment qualifies its claims about passkeys, deceptive viewers, certificate expiry and stateless receipts.

## Outcome and scope

People holding a Signhere document should be able to check its supported cryptographic evidence without the original installation. Operators can optionally add independent time evidence. People without BankID can optionally approve the exact document through a service independent of the hosting operator, while keeping PDF content out of the central server.

| Capability | Central role and supported claim | Boundary |
| --- | --- | --- |
| Local verification | Distribute a browser/offline verifier and authenticated trust material; check supported artifact integrity/evidence | No enrollment required for integrity; unknown issuer stays unknown |
| Independent timestamp | Forward a bounded signature imprint to an approved RFC 3161 authority; establish existence by a trusted time | Does not establish who consented or the truth of audit events |
| Independent approval | Confirm email access and explicit approval through a separate interface; sign a portable receipt | Email control is not civil identity; trust shifts to the confirmation service, its code and the participant's device/mailbox |

Self-hosted operation stays available without central enrollment. Central protections are opt-in for new transactions and frozen before invitations. Required protections cannot silently downgrade during an outage. Local-only transactions remain supported.

## Optional by design

The central service is an add-on for installations that want it, not a dependency of Signhere. A self-hosted installation must install, sign, seal, deliver and verify documents with no central configuration, account or network access.

- **Off by default.** No central endpoint is configured in a fresh installation. With it unset, the instance makes no outbound requests to signhere.se (no telemetry, key fetches, update checks or "phone home"), shows no central controls, and behaves exactly as today.
- **Explicit administrator opt-in.** An administrator enables central features by setting a central base URL and scoped credentials. Each capability (timestamp, independent approval) is enabled separately; enabling one does not enable the other.
- **Configurable endpoint.** The base URL and trust anchors are configuration, not hard-coded. This allows an interim host (e.g. `signhere.prpl.se` before `signhere.se` exists), a staging server, or an organisation running its own compatible trust service. Receipts record which service and key issued them; changing the URL never re-trusts old receipts.
- **Not needed with a strong signing method.** Independent email approval exists for participants who lack BankID or a comparable method. When a transaction uses BankID, Freja or another provider whose signed response already comes from a party independent of the operator, that response is the independent evidence; the instance neither offers nor requires central approval for that participant. Timestamping remains separately selectable either way.
- **Per-transaction, frozen choice.** Where enabled, protections are chosen before invitations and frozen (see below). Disabling central features later affects only new transactions; it never strands or downgrades pending ones, and never invalidates completed evidence.
- **Verification without the service.** The offline verifier and published trust material work without contacting the central service. Documents that never used it verify exactly as they do today, with no "missing central receipt" warning.

The service does not store customer PDFs, drawings or full private audit bundles. It is not a document archive, public document directory, BankID substitute, qualified-signature service or automatic compliance certification. Passkeys, issuer recognition and archival renewal are separate later tasks.

## Current starting point

Evidence-v2 documents have an installation seal and commitments to the prepared PDF and private evidence core. A Node/Python offline verifier checks these bindings. Public `/verify` only hashes locally and queries the instance database. Full evidence is team-only; recipients receive the completed PDF. Central approval, browser-local cryptographic verification and trusted timestamping are not implemented.

Keep evidence-v1 artifacts explicitly legacy/unsealed. Do not rewrite historical artifacts, imply a later timestamp is the original signing time, or strand pending transactions using old policies. References: [security boundaries](signing-security.md), [timestamp spike](rfc3161-feasibility.md), [integration boundaries](signing-methods.md).

## Components and deployment boundaries

Deploy the central service separately from self-hosted instances. Reusing TypeScript/Node and PostgreSQL is the planning preference, subject to CEN-002. Browser PDF/CMS validation requires an interoperability and hostile-input spike; existing Python code cannot simply be imported into the browser.

Proposed entry points: `signhere.se/verifiera` and `signhere.se/bekrafta`. Prefer a dedicated trust origin, e.g. `verify.signhere.se`, with the entry points redirecting there. Marketing scripts, administration, cookies, service workers and user-generated content must not share its authority. Final DNS/provider choices remain open; this PR deploys nothing.

| Component | Responsibility and constraint |
| --- | --- |
| Trust web application | Local PDF display/hashing, explicit consent and verification; the same byte buffer feeds display and digest; no PDF upload or automatic artifact lookup |
| API and state store | Scoped instance admission, challenges, replay/idempotency and bounded receipt retrieval; an operator cannot assert its own independent confirmation succeeded |
| Email worker | Central challenges and bounded delivery retries; mail provider sees necessary addresses/message data, never PDFs or private audit evidence |
| Receipt signing service | Sign versioned approval assertions after verified approval; keys isolated from parsing, ordinary request handlers and customer instances |
| Timestamp gateway | Bounded allowlisted TSA requests; imprint/protocol data only; no arbitrary URLs or certificate-directed fetches |
| Trust distribution | Authenticated current/historical public keys and incident status; a supplied certificate is not its own trust anchor |
| Offline verifier distribution | Authenticated releases, documented dependencies and retained trust material for shutdown resilience |
| Operations/admin plane | Quotas, providers, incidents and retention; separate access boundary; no signing keys in repository, logs, images or database dumps |

## Independent approval flow

1. The instance freezes the prepared PDF, participant intent, exact consent and protection policy. It requests a session with scoped credentials and minimal metadata. API admission does not establish company identity.
2. The participant enters the independent trust application in a top-level browsing context. It obtains the exact prepared PDF directly into browser memory from the instance or a locally selected file. The central backend never fetches/proxies it. CEN-003/CEN-005 specify CORS, private-network installations, capability transfer and local-file fallback.
3. Independent code renders and hashes the same bytes, checks the frozen context, and displays the exact consent. A fingerprint merely printed by the self-hosted page is not evidence of matching viewed bytes.
4. The service independently confirms access to the intended email address. Email scanners, forwarded links, compromised/shared mailboxes and address changes are explicit risks. Opening a link is not approval; contact verification and document consent are separate state transitions.
5. The service atomically consumes an approval challenge and issues a receipt binding the verified address, instance/document/revision/participant, prepared hash, intent/consent, nonce, method/policy versions and observed time. Operator-supplied callback flags cannot replace these checks.
6. The participant receives the signed receipt directly. The instance retrieves that same receipt through scoped authenticated delivery, checks the frozen transaction, and retains exact bytes before sealing. Legitimate retries return the same result.
7. Final publication binds the receipt through the agreed evidence/PDF profile. Required receipts/timestamps must validate before completion. Participants obtain completed PDFs and appropriate proof packages without a team account.
8. Later verification checks receipt signature/trust, prepared-byte binding, final seal and required inclusion proof. Missing evidence and unchecked historical status remain explicit.

[CEN-001](backlog/signhere-central/CEN-001-protocol-and-threat-model.md) owns normative formats and vectors. Use standard envelopes and maintained implementations with exact signed-byte rules and domain separation. Do not concatenate ambiguous strings or invent cryptographic primitives.

Receipts bind prepared bytes, not a final file hash that does not exist until receipts/appendices are assembled. Define how a receipt links to the final artifact. Redacting private evidence JSON cannot preserve its original full-evidence digest.

## Approved original versus completed PDF

A final seal containing hash(A) and a valid receipt for A does not prove its visible pages are A. A dishonest operator could seal document B while including correct commitments and receipts for A. Receipt inclusion proves inclusion, not content equivalence.

CEN-001 must specify an independently checkable relationship between approved prepared bytes and completed content within a supported profile. Do not assume that preserving a prefix, embedding an original, or comparing a server-supplied hash establishes identical display. Preserve the exact approved original in participant exports. If the verifier cannot establish the completed-content relationship safely, it must report approval of the preserved original separately and mark completed content as unverified for that approval. It must never report that B was approved merely because its manifest claims hash(A).

CEN-005/CEN-008/CEN-009/CEN-012 must include an adversarial fixture with approved A, completed visible B, valid seal, valid receipt(A), and otherwise matching metadata. General renderer equivalence is not presumed solved by this plan.

Likewise, a malicious operator can reseal a different claim about which protections were requested. Detecting a downgrade requires independently retained expected policy/context or a signed central receipt. Without that anchor, report missing independent evidence rather than inventing the original requested policy.

## Proposed API responsibilities

These are operations for CEN-001 to specify, not implemented endpoints or a frozen wire contract.

| Operation | Caller and required behaviour |
| --- | --- |
| Create approval session | Scoped instance; freeze minimal context, cap inputs, return opaque capability idempotently, reject cross-instance reuse |
| Start/complete email confirmation | Participant on independent origin; bounded attempts/validity, origin/session binding, no approval on GET or email prefetch |
| Approve document | Independent participant session; check document commitment/consent, atomic one-time transition |
| Retrieve receipt / notification | Scoped instance or participant capability; immutable exact response, bounded retrieval, authenticated/idempotent delivery |
| Request timestamp | Scoped instance; enforce allowed provider/policy, budgets and bounds, verify response |
| Obtain public trust material | Public verifier/offline package; versioned historical keys/status with independently authenticated bootstrap |

Prefer authenticated polling for initial receipt delivery unless CEN-001 justifies webhooks. Any webhook design must constrain destinations, address resolution, credentials, replay, redirects, retries and signatures. Do not create a general central URL fetcher.

## Data and retention boundaries

| Data | Location and rule |
| --- | --- |
| PDF bytes/drawings | Instance and participant browser/copies; never central requests, logs, backups, crash reports or email delivery |
| Full audit/IP/user-agent history | Instance/private authorised exports; not sent for central verification, timestamping or approval |
| Email and confirmation state | Central API/mail provider; necessary for confirmation, scoped access and explicitly chosen deletion policy |
| Intent/document/consent commitments and receipts | Transient workflow and participant/instance copies; linkable metadata, bounded retrieval/state, no public registry |
| Timestamp requests/responses | Instance, gateway, TSA and artifacts; content-free but traffic/usage metadata remains observable |
| Public trust keys/status | Public distribution/offline copies; preserve necessary history separately from participant data |
| Access/security/support/delivery diagnostics | Relevant infrastructure/provider; redaction, TTLs, backup aging and access controls decided before release |

CEN-010 must choose concrete purpose-based retention periods and provider obligations before processing real personal data. Do not invent a universal legal retention period. Challenge/download expiry does not delete the instance's document or invalidate preserved proof. Backups/restoration must respect deletion policy.

Short-lived challenge/replay state is required without a permanent document registry. A stateless receipt does not discover conflicting versions, supply complete history or recover lost evidence. Additional retained records need a separate justified scope/privacy decision.

## Verification results and user copy

Show separate results for cryptographic integrity, issuer recognition, timestamp verification, participant authentication/approval and evidence completeness. Unknown, unsupported, absent, unchecked, expired access and invalid are different. Do not combine them into a green "verified" badge.

Suggested controls, subject to UX/privacy review:

- **Lägg till oberoende tidsstämpel via signhere.se**: sends a signature imprint and connection metadata, not document content.
- **Bekräfta signering via signhere.se**: independently confirms email access and explicit approval; discloses the address and minimal metadata while keeping the PDF in the browser.

Passkey use is not verified civil identity; domain control is not verified company identity. Local drawn signatures retain their honest assurance labels when central features are disabled or absent.

## Failure, compromise and shutdown

Handle duplicate/concurrent requests, delayed email, expired sessions, interrupted receipt delivery, unavailable TSA and key rotation without changing accepted approvals or silently changing policy. Required failures leave visible pending/error states and documented recovery. Local-only transactions stay independent.

Separate installation, receipt and timestamp authorities. Record incident cutoffs and historical uncertainty without declaring all old artifacts invalid merely because a key expired or rotated. A compromised central frontend can mislead users; independently authenticated offline releases reduce dependence but do not eliminate trust.

The exit plan must enable evidence/verifier/trust-material exports, describe which capabilities stop, and preserve public historical verification material as appropriate. This is not contract backup. Offline checks cannot recover missing PDFs/receipts.

## Delivery sequence and release claims

| Milestone | Work | Gate |
| --- | --- | --- |
| Foundation | CEN-001, CEN-002, CEN-006, CEN-010 | Threat model, protocol/vectors, scoped runtime, key/trust and data lifecycle resolved |
| Portable verification beta | CEN-007, CEN-008 and timestamp slice of CEN-005 | CEN-011/CEN-012 gates for enabled components; advertise integrity/time only |
| Independent approval beta | CEN-003, CEN-004, CEN-005, CEN-009 | Trusted interface, confirmation, receipts and participant exports proven end-to-end |
| Production operations/release | CEN-011, CEN-012 | Privacy, recovery/shutdown, key incident, abuse and adversarial gates passed for enabled capabilities |
| Later capabilities | CEN-013, CEN-014, CEN-015 | Separately reviewed enrollment, identity and preservation claims |

Work can run in parallel after task prerequisites. Release gates do not prevent starting the work they assess. Verification-only beta must not imply independent participant approval; approval cannot ship without its receipt/export path.

## Decisions still to make

- Configuration names for the central base URL, credentials and trust anchors, and the interim-to-final host migration (e.g. `signhere.prpl.se` to `signhere.se`) without re-trusting or stranding existing receipts.
- Service origins, hosting region/provider, operational ownership, load assumptions, budgets and recovery objectives.
- Receipt/enrollment format, maintained browser validation engine, proof inclusion and compatibility transitions.
- Admission/quotas, email provider, challenge/retrieval/log/backup retention periods.
- TSA provider, accepted policies/trust roots, outages, cost controls and historical-status availability.
- Key-custody products, public trust distribution, incident handling and deployment-specific legal/provider review.

Every decision has an owning backlog task and must be closed before its release criteria pass. This PR does not buy services, create secrets, deploy infrastructure or claim future checks have passed.
