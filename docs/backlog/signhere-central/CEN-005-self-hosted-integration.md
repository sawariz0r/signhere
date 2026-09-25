# CEN-005: Self-hosted integration and frozen protection policy

- ID: CEN-005
- Status: Backlog
- Priority: P0
- Milestone: Portable verification beta (timestamp slice); Independent approval beta
- Owner: Self-hosted application/backend engineering (unassigned)
- Depends on: CEN-001 to start; phase prerequisites below
- Related: CEN-003, CEN-004, CEN-007, CEN-009, CEN-012

## Goal

Integrate optional central protection into self-hosted signing without weakening a
transaction's selected policy during failures. Keep approval of exact prepared bytes,
receipt inclusion, final seal integrity, and the relationship to visible final content
separate; operator-authored commitments alone do not prove that relationship.

## Phase prerequisites

- Timestamp slice: CEN-001 protocol, CEN-002 gateway admission/runtime, CEN-006 trust
  material and CEN-007 timestamp contract. CEN-004 approval is not a prerequisite.
- Approval slice: CEN-003 independent interface and CEN-004 confirmation/receipt flow,
  with CEN-009 participant exports and CEN-008 verification required before release.
- Both slices use CEN-010/CEN-011/CEN-012 privacy, operations and release gates for
  the enabled scope; timestamp-only transactions do not require approval enrollment.

## Scope and deliverables

- Add separate pre-invitation controls for independent approval and timestamping.
  Explain processed metadata, actual protections and identity limits in Swedish.
- Freeze selected protection policy, service/provider trust, participant context,
  prepared PDF digest and consent/intent version before invitations. Binding changes
  create a new transaction; changing deployment settings cannot downgrade old ones.
- Timestamp slice: integrate CEN-007 with the sealing worker, exact signature-value
  imprint and frozen request policy. Keep network transport and token validation
  outside private-key worker authority; insert a validated token into the reserved
  CMS slot, then validate the exact final PDF before publication.
- Timestamp slice: persist pending finalization, verified token/request correspondence
  and retry state. Test timestamp-required and timestamp-disabled ordinary signing
  without CEN-004; required provider failures must not publish a weaker artifact.
- Approval slice: add "Bekräfta signering via signhere.se" and register scoped frozen
  transactions. Hand participants to CEN-003 using an expiring capability and
  browser-only prepared-PDF transfer; prohibit a central backend proxy fallback.
- Verify receipts against configured independent trust, signature/schema, exact
  participant/address claim, prepared digest, intent and transaction. Receipt-supplied
  keys or URLs must not replace configured trust anchors.
- Preserve raw signed receipt bytes and immutable validation results before the
  evidence checkpoint. Bind the protocol-defined receipt commitment in the final
  sealed record, with enough portable information for independent inclusion checks.
- Define supported final-document composition and verification. A protected prepared
  hash plus receipt inclusion proves those commitments were sealed, not that visible
  final pages match the approved original. Either independently validate the content
  relationship in the supported profile or label approval as applying to the exact
  original only, with the final-content relationship explicitly unverified.
- Distinguish awaiting approval, pending finalization, failed required protection and
  completion. Authenticated polling/callbacks need replay protection/idempotency;
  receipt validation, rather than a notification flag, authorises acceptance.
- Coordinate cancellation, revisions, concurrent participants and retries; one receipt
  cannot satisfy another participant. Retain accepted evidence through outages.
- Preserve independent expected policy/receipt context for participant verification.
  A malicious operator can reseal stripped or rewritten policy metadata; without an
  independent expectation, report absent/unknown evidence instead of detecting a
  downgrade that cannot be established from the supplied final PDF alone.
- Deliver CEN-009 evidence and document network/data flows. Keep local-only signing
  available and avoid upgrading historical evidence-v1/v2 claims through migration.

## Acceptance criteria

- [ ] Timestamp-only integration completes and verifies without any CEN-004 email or
  receipt infrastructure. Disabled timestamp mode retains ordinary signing behavior.
- [ ] Wrong imprint/policy/provider, invalid token, overflow, timeout or restart leaves
  required finalization pending/failed; successful retry revalidates the final artifact.
- [ ] Post-invitation settings, worker/admin retries and UI fallbacks cannot silently
  remove required protection from an honest installation's transaction.
- [ ] Receipts for another installation, participant, document, revision or intent fail,
  even when names match or the prepared PDF is reused in another transaction.
- [ ] Concurrent polls, callbacks and restarts accept one immutable matching receipt;
  unauthorised callers cannot retrieve another installation's private context.
- [ ] Cancellation and revision races have deterministic outcomes; late receipts cannot
  resurrect a cancelled transaction or force unnecessary approval after a safe retry.
- [ ] Fabricated instance approval JSON or a self-issued central key cannot produce
  an independently trusted approval result in the external verifier.
- [ ] A fixture approves original A, then seals visible document B with a manifest
  claiming A's hash and including A's receipt. The verifier rejects a claimed match
  or reports approval of A only and final-content relationship unverified; it never
  states that B was independently approved on the strength of those commitments.
- [ ] Receipt omission/policy rewriting fails an independently held expected-policy
  check, or reports independent evidence absent/unknown when no such anchor exists.
- [ ] Receipt inclusion, exact approved bytes and any supported content relationship
  can be checked without the full private evidence core; unchecked relations stay explicit.
- [ ] Legacy signing/export labels remain accurate; network traces confirm only declared
  metadata reaches central APIs and PDF bytes transfer directly to the browser.

## Verification evidence

Save timestamp-only, local-only, independent-approval and outage/retry artifacts;
A-approved/B-final and stripped-policy fixtures; substitution/race test results;
and compatibility review of schema, finalization state and participant bindings.

## Open decisions and exclusions

- Choose polling/callback strategy with CEN-001/CEN-002, approval after drawing versus
  a separate method, and supported final-composition relationship checks.
- Define recovery after key compromise; never silently repin an untrusted key.
- Exclude central document/team-account hosting, civil-identity claims, retroactive
  approval and claims that integration code constrains a malicious operator's server.
