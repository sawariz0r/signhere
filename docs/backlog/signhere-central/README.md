# Central trust platform implementation backlog

Status: planning only, updated 2026-10-17. All active tasks are unassigned and not started. The [current plan](../../central-service-plan.md) is authoritative for the digest-only launch: one-click enrollment, 14-day free trial, yearly/lifetime upgrade and free historical verification.

## Active delivery track

Each task is one reviewable implementation PR; split further only when necessary to keep review understandable. Dependencies permit starting contract-ready work, not claiming a feature is released. Do not implement document-metadata approval services under these tasks.

| ID | Proposed PR | Prerequisites |
| --- | --- | --- |
| CEN-016 | [Freeze digest-only protocol and claims](CEN-016-protocol-and-vectors.md) | None |
| CEN-017 | [Build central service and automatic enrollment](CEN-017-service-and-enrollment.md) | CEN-016 |
| CEN-018 | [Connect instances through a durable outbox](CEN-018-instance-outbox.md) | CEN-016, CEN-017 |
| CEN-019 | [Ship hash verification and portable receipts](CEN-019-verification-and-exports.md) | CEN-016; CEN-017/018 for integrated paths |
| CEN-020 | [Add one-click owner onboarding and clear status](CEN-020-onboarding-and-status.md) | CEN-017, CEN-018; CEN-019 for verifier links |
| CEN-021 | [Add yearly and lifetime checkout](CEN-021-billing-and-entitlements.md) | CEN-017; CEN-020 for user journey |
| CEN-022 | [Prove privacy, recovery and release readiness](CEN-022-operations-and-release.md) | CEN-016 to start; CEN-017–021 evidence before paid release |

Implement protocol first, then service and instance integration, then verification/exports and owner UX. Billing follows enrollment identity and completes before paid launch. Start operational/privacy review early; collect evidence for every enabled surface before exposing it. A public free trial also needs the applicable privacy, key custody and abuse controls.

Actual prices, lifetime/transfer terms, region/provider, key custody and costed quotas are product/operations decisions before launch. Detailed protocol choices belong to CEN-016. They are not reasons to add setup steps for self-hosters.

## Historical extended track

CEN-001–015 below are superseded/deferred research, not pending prerequisites for CEN-016–022. Their old priorities, dependency lists, email/context fields and required-completion policy describe the [earlier extended design](../../central-service-extended-design.md). Independent email approval directly exceeds the current digest-only privacy promise. Reopening any capability requires a separate product/privacy proposal.

- [CEN-001: Define the central protocol and threat model](CEN-001-protocol-and-threat-model.md)
- [CEN-002: Central service foundation and isolation](CEN-002-service-foundation.md)
- [CEN-003: Independent approval interface on signhere.se](CEN-003-independent-approval-ui.md)
- [CEN-004: Independent email confirmation and signed approval receipts](CEN-004-email-approval-receipts.md)
- [CEN-005: Self-hosted integration and frozen protection policy](CEN-005-self-hosted-integration.md)
- [CEN-006 — Receipt key custody and independent trust distribution](CEN-006-key-custody-and-trust.md)
- [CEN-007 — Hash-only RFC 3161 timestamp gateway](CEN-007-timestamp-gateway.md)
- [CEN-008 — Browser and offline cryptographic verifier](CEN-008-browser-offline-verifier.md)
- [CEN-009: Participant evidence that survives either service shutting down](CEN-009-participant-evidence.md)
- [CEN-010: Privacy inventory, retention, and deletion](CEN-010-privacy-and-retention.md)
- [CEN-011: Deployment, recovery, and service exit](CEN-011-deployment-and-recovery.md)
- [CEN-012: Adversarial review and phased release gates](CEN-012-security-and-release-gates.md)
- [CEN-013: Add passkeys with trustworthy enrollment and recovery](CEN-013-passkey-enrollment.md)
- [CEN-014: Add portable domain and organisation attestations](CEN-014-issuer-attestations.md)
- [CEN-015 — Historical validation material and archival renewal](CEN-015-archival-validation.md)
