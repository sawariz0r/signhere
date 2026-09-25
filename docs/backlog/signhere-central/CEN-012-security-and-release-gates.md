# CEN-012: Adversarial review and phased release gates

- ID: CEN-012
- Status: Backlog
- Priority: P0
- Milestone: Production release
- Owner: Security reviewer and release owner (unassigned)
- Depends on: CEN-001 (to start; release dependencies are scoped below)

## Goal

Demonstrate each advertised claim against a malicious installation, hostile files,
central compromise, and service loss. Permit a useful local-verification beta
before independent approval is ready, while reserving the stronger participant
approval claim for a release that actually captures independent approval.

## Scope and deliverables

- Maintain a threat-to-test register from CEN-001 with fixture, expected claim,
  owner, evidence, and disposition. Start protocol/architecture review early;
  this task is not a prerequisite cycle that delays all security work until launch.
- Obtain review independent of the implementation author for protocol bindings,
  browser trust boundary, public key distribution, and dangerous parsing paths.
  Record reviewer scope and limitations; a design review is not a source audit.
- Exercise the matrix below using synthetic participant data and reproducible
  fixtures. Verify user-visible results as well as cryptographic return values.
- Fuzz/sanitize PDF and evidence inputs, set resource limits, review dependencies,
  and define a supported PDF profile. Unsupported constructs fail explicitly;
  a valid seal must not obscure unsigned changes or misleading rendered content.
- Record phase-specific acceptance and release notes that identify what is
  implemented, what is merely claimed by an instance, and what remains unknown.
- Produce authenticated verifier builds and preserve fixtures, dependency versions,
  review records, and redacted test evidence with the candidate release.

## Adversarial verification matrix

| Scenario | Required outcome |
| --- | --- |
| Operator fabricates events, then obtains a valid seal/timestamp | Integrity/time may pass; independent approval stays absent; no civil-identity claim. |
| Operator displays A but requests approval for B | Independent page renders and hashes the same frozen bytes; mismatched receipt/document bindings fail. |
| PDF changes while loading or after review | Approval binds the immutable reviewed prepared bytes; prepared-byte substitutions fail. |
| A was approved, but validly sealed B claims A's prepared hash and includes A's receipt | Independently validate the supported content relationship or show approval of original A only and final-content relationship unverified; never infer B was approved. |
| Malicious operator reseals output after stripping required policy/receipt | Check independently held expected policy/receipt context, or report independent evidence absent/unknown; rewritten metadata cannot prove its own prior requirement. |
| Instance claims mailbox confirmed or supplies its own challenge/result | Central verification remains authoritative; instance cannot issue independent approval. |
| Leaked, expired, guessed, forwarded, replayed, or concurrently consumed challenge | Expiry, attempt bounds, context binding, and one-time use hold; forwarding/mailbox compromise is disclosed as a residual risk. |
| Cross-tenant IDs, capabilities, idempotency collisions, enumeration | Access denied without participant disclosure; no cross-tenant state effects. |
| Consent/version/participant/instance/transaction/algorithm/nonce substitution | Canonical binding validation rejects altered context or unsupported versions. |
| Malicious PDF byte ranges, incremental revisions, shadow content, multiple signatures | Report actual covered bytes and modifications; reject unsupported or ambiguous cases rather than showing blanket success. |
| PDF scripts, external resources, oversized content, malformed evidence archives | No active-content execution, network exfiltration, path traversal, or unbounded parsing. |
| Unknown, expired, revoked, compromised, wrong-purpose, or replaced witness key | Separate signature validity from issuer/historical trust; unknown status never silently becomes trusted. |
| Wrong TSA imprint, policy, nonce, signature value, chain, or trust status | Reject invalid tokens; report unsupported/historically indeterminate results precisely. |
| Required TSA/mail/witness outage, crash, retry, or restore | No silent downgrade, duplicate approval, fabricated success, or revival of consumed state. |
| Email spray, resend loops, large tenants, queue saturation | Abuse limits and tenant isolation hold without revealing mailbox existence. |
| Compromised verifier delivery or same-origin replacement checksums | Independently authenticated offline release provides a recovery route; online delivery compromise remains an explicit boundary. |
| Logs/CDN/mail/errors, expiry jobs, backup restore | No PDF or secret leakage; minimisation/deletion matches CEN-010, including restored records. |
| Missing evidence, unavailable trust status, both services shut down | Preserved components verify offline with precise missing/unknown results and no invented recovery. |

## Release matrix and dependencies

Dependencies below apply only to the named phase and relevant sections of each
task. An early static verifier release does not require the approval API or email
flow. Operations/privacy controls still apply to whatever is actually deployed.

| Phase | Required work and permitted claims |
| --- | --- |
| Local verification beta | CEN-001, CEN-008, non-approval fixture/export interoperability from CEN-009 (without requiring CEN-004), applicable key/publication work in CEN-006, local-verifier privacy/hosting parts of CEN-010/CEN-011, and this matrix's parsing/offline/delivery checks. Claim supported artifact integrity and clearly separate issuer/time/evidence results; no new independent approval claim. |
| Timestamp-enabled beta | CEN-001, CEN-002, the timestamp slice of CEN-005, and CEN-006 through CEN-011 as applicable to timestamps (without CEN-004 approval), plus timestamp/outage/portability checks here. Claim independently anchored existence time only when validated; no participant approval inference. |
| Independent approval beta | CEN-001 through CEN-006, CEN-008 through CEN-011, and all relevant approval/privacy/abuse/portability tests here. Include CEN-007 when timestamp protection is offered or required. Claim independently confirmed email access and explicit approval bound to reviewed bytes, with mailbox/device/service compromise limits. |
| General availability of a capability | Its beta prerequisites, resolved critical/high findings, operational ownership, external security review of shipped scope, a restore/shutdown drill, and approved exact product/privacy wording. |

CEN-013 through CEN-015 are later capabilities and do not block these phases.
Their eventual release requires additional enrollment, issuer-recognition, or
archival-preservation review; absence must remain visible in verification results.

## Acceptance criteria

- [ ] Every shipped trust claim maps to protocol fields, implementation, negative
  tests, user-facing status, and a documented residual risk.
- [ ] No single success badge converts a valid operator seal/timestamp into proof
  of human identity, truthful audit events, or independently witnessed consent.
- [ ] Approval results distinguish approved original bytes, receipt inclusion and final
  content. The A-approved/B-final fixture either fails an independently checked
  relationship or explicitly leaves that relationship unverified; B is never approved
  merely because its sealed manifest contains A's hash and receipt.
- [ ] Approval beta includes participant delivery and independently usable evidence;
  a central-only receipt that disappears at shutdown does not satisfy the gate.
- [ ] Supported/unsupported formats, legacy artifacts, partial evidence, key status,
  and historical validation uncertainty are represented accurately in the UI.
- [ ] Required-protection failures remain pending/failed and cannot silently pass
  through retries, upgrades, operator settings changes, or disaster recovery.
- [ ] Review findings are fixed and retested or accepted with named owner, rationale,
  scope, and expiry; unresolved critical/high findings block the relevant release.
- [ ] Each phase has an explicit signed-off release record, tested rollback/stop
  decision, and documentation matching exactly the functionality being enabled.

## Verification evidence

Attach the threat/test register, fixture corpus, fuzz and negative-test reports,
independent review and dispositions, browser network captures, recovery evidence,
and the phase release record. Redact secrets and personal data from all artifacts.

## Open decisions and exclusions

- Select reviewers, tooling, fuzz budgets, supported PDF profile, and the owner
  authorised to accept lower-severity residual risks before implementation ends.
- This gate does not certify legal compliance or advanced/qualified signature
  status; any such future claim needs separately established requirements.
