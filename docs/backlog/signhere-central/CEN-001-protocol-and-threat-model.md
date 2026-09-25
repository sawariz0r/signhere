# CEN-001: Define the central protocol and threat model

- ID: CEN-001
- Status: Backlog
- Priority: P0
- Milestone: Foundation
- Owner: Security and protocol engineering (unassigned)
- Depends on: None
- Unblocks: CEN-002, CEN-003, CEN-004, CEN-005, CEN-006, CEN-007, CEN-008, CEN-009, CEN-010

## Goal

Specify what signhere.se can attest, who it must withstand, and how independent approval binds prepared bytes to the completed artifact. Produce implementable contracts before API or cryptographic work relies on assumptions.

Read the [service plan](../../central-service-plan.md) and [review dispositions](../../reviews/2026-09-24-fable-trust-dispositions.md). The latter qualify the raw critique's overbroad recommendations.

## Scope and deliverables

- Claim/evidence/trust-boundary table for integrity, independent time, issuer recognition, email control, consent, receipt inclusion and completeness. Email/passkeys alone do not verify civil identity.
- Threat model for dishonest sender/operator, compromised instance, stolen capabilities, mailbox/device compromise, hostile PDFs, central frontend/API/key compromise, provider failure and shutdown/deletion.
- Versioned schemas for instance admission, frozen requests, challenge state, receipt, errors/results, timestamp policy and trust metadata. API-client admission is distinct from domain/company assurance.
- Standard signed-envelope/library selection with browser/server interoperability evidence. Exact byte encoding, algorithms, signature scope, strict parsing, domain separation and version handling; no custom primitive or ambiguous concatenation.
- Minimal receipt fields binding service/key, audience/instance, document/revision/recipient assignment, prepared-PDF hash, intent hash, exact consent/version, independently confirmed email subject, service nonce, method/policy versions, frozen protection-policy commitment and observed times. Document each field's purpose.
- State machine for creation, email confirmation, explicit approval, receipt issuance/retrieval, expiry/cancellation. Distinguish challenge/access expiry from validity of preserved historical evidence.
- Authentication/origin/session checks, replay rules, duplicate/concurrent request behaviour, immutable idempotent retries, errors, bounded sizes and receipt acknowledgement semantics.
- Final-artifact binding/inclusion proof for a receipt over prepared bytes. Evaluate minimal commitments or selective proofs; redaction of full hashed JSON cannot preserve its digest.
- Separately define an independently checkable prepared-to-completed content relationship within the supported profile. Valid hash claims/inclusion proofs cannot establish visible equivalence. When that relationship is unavailable, verify approval of the retained exact prepared original and label completed content relationship unverified.
- Define independently retained expected protection-policy/context anchors. A resealed operator claim alone cannot reveal a previously required protection that the operator stripped.
- Compatibility for legacy v1/v2, active transactions, client/service version skew, key recovery and frozen policy. Later timestamping does not backdate original signing.
- Non-sensitive positive/negative conformance vectors and cross-component test plan. Map each invariant to its implementing task and CEN-012 gate.

## Acceptance criteria

- [ ] One transaction can be traced from prepared bytes through independent confirmation, receipt and offline verification without operator-provided success flags.
- [ ] The trusted interface displays/hashes the same bytes; displaying A while requesting approval of B has an explicit defence and residual rendering/device limits.
- [ ] Contact verification and consent are separate. GET links and email scanners cannot approve documents.
- [ ] Receipt replay across instance, recipient, document, revision, intent, consent, method or policy is rejected; legitimate retries have deterministic outcomes.
- [ ] An embedded key or same-host discovery does not establish its own trust; bootstrap and historical status are independent inputs.
- [ ] Expiry, cancellation after email verification, concurrent approval, lost responses, outage and key rotation have documented states without losing/fabricating accepted approval.
- [ ] Prepared hash and final-file hash are distinct; no circular final hash or uncontrolled post-signature mutation is required.
- [ ] Approved-A/completed-B fixtures with valid seal, receipt(A), and matching claimed hash(A) never report B as approved; actual relationship validation or an explicit unverified-content result is required.
- [ ] Missing independent evidence is distinguished from a proven downgrade; original policy is checked against independently preserved context where available.
- [ ] Participant-only proofs work without other participants' IP/device details or false redacted-evidence claims.
- [ ] API data inventory matches CEN-010; no PDF body/URL fetch, drawing or full audit upload is required.
- [ ] Formats/limits/policy decisions are resolved with normative vectors, or remain explicit implementation blockers owned by a named role.

## Verification evidence

Reviewed state/dataflow diagrams; normative schema/claim table; request/response fixtures; positive/negative signed-message vectors; attack-to-release-test traceability. Schema validity alone does not establish security.

## Open decisions

Envelope/algorithms, inclusion commitments or selective proofs, instance identity versus sealing-key recovery, polling versus justified webhooks, profile migration, email canonicalisation/reassignment and concrete bounds/time windows. Protocol/security engineering owns these with privacy and UX input.

## Exclusions

No deployment/implementation, legal classification, universal verified badge, public document registry or custom timestamp authority.
