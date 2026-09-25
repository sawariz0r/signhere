# signhere.se central-service backlog

Status: independent email approval is implemented as a beta (see each task's Progress section and [central-protocol.md](../../central-protocol.md)); timestamping, KMS custody, external review and later capabilities remain open. Updated: 2026-09-25. The service is optional: installations without `SIGNHERE_CENTRAL_URL` never contact it.

Read the [architecture and delivery plan](../../central-service-plan.md) first. The [review assessment](../../reviews/2026-09-24-fable-trust-dispositions.md) supplies the accepted trust boundaries; the [raw Fable review](../../reviews/2026-09-24-fable-non-bankid-trust.md) is retained with its limitations and corrections.

## Work items

Each file specifies a role owner (currently unassigned), prerequisites, deliverables, acceptance checkboxes, verification evidence and open decisions. File metadata is authoritative; this index is the navigation/sequence overview. P0 is required foundation or independent-approval safety work; P1 is useful portable-verification functionality; P2 is deferred capability, not an excuse to omit required safeguards from an earlier release.

| ID | Priority | Task | Delivery group |
| --- | --- | --- | --- |
| CEN-001 | P0 | [Protocol and threat model](CEN-001-protocol-and-threat-model.md) | Foundation |
| CEN-002 | P0 | [Service runtime, API and state isolation](CEN-002-service-foundation.md) | Foundation |
| CEN-003 | P0 | [Independent approval interface](CEN-003-independent-approval-ui.md) | Independent approval beta |
| CEN-004 | P0 | [Email confirmation and signed receipts](CEN-004-email-approval-receipts.md) | Independent approval beta |
| CEN-005 | P0 | [Self-hosted integration and frozen policy](CEN-005-self-hosted-integration.md) | Timestamp and approval integration slices |
| CEN-006 | P0 | [Key custody and trust distribution](CEN-006-key-custody-and-trust.md) | Foundation |
| CEN-007 | P1 | [RFC 3161 timestamp gateway](CEN-007-timestamp-gateway.md) | Portable verification beta |
| CEN-008 | P1 | [Browser and offline cryptographic verifier](CEN-008-browser-offline-verifier.md) | Portable verification beta |
| CEN-009 | P0 | [Participant evidence and delivery](CEN-009-participant-evidence.md) | Independent approval beta |
| CEN-010 | P0 | [Privacy, retention and deletion](CEN-010-privacy-and-retention.md) | Foundation |
| CEN-011 | P0 | [Deployment, recovery and service exit](CEN-011-deployment-and-recovery.md) | Production operations |
| CEN-012 | P0 | [Adversarial tests and phased release gates](CEN-012-security-and-release-gates.md) | Every enabled capability / production release |
| CEN-013 | P2 | [Passkey enrollment and recovery](CEN-013-passkey-enrollment.md) | Later authentication |
| CEN-014 | P2 | [Domain and organisation attestations](CEN-014-issuer-attestations.md) | Later issuer recognition |
| CEN-015 | P2 | [Historical validation and archival renewal](CEN-015-archival-validation.md) | Later preservation |

## Recommended sequence

1. Resolve CEN-001 contracts and threat model. Start privacy (010), key/trust (006) and service foundation (002) from those contracts. Start independent security review (012) early.
2. Build local/offline verification (008), timestamp forwarding (007), and the timestamp-only integration slice (005). Static verification can ship before an approval API, subject to its own privacy, publication, parsing and operational gates.
3. Implement independent UI (003) and email/receipt state machine (004) in parallel where contract-ready. Complete approval integration (005) and participant export (009). An independent-approval claim requires this whole flow.
4. Complete applicable operations/recovery (011) and the phase-specific release matrix (012) before exposing each capability. A public beta still needs the relevant controls.
5. Evaluate passkeys (013), issuer recognition (014) and archival renewal (015) as separate claims with separate evidence and release review.

CEN-005's timestamp slice does not wait for CEN-004. Its independent-approval slice does. CEN-012 depends on CEN-001 to begin review; its release matrix checks completed relevant work without introducing a dependency cycle. CEN-008/CEN-009 can develop shared fixtures before both are complete, but their combined offline proof checks must pass before approval beta.

## Release checklist

- [ ] Foundation decisions: protocol/schema/vectors, key custody/bootstrap, scoped API/state, actual data lifecycle and owners agreed.
- [ ] Local verification beta: real supported PDF/CMS checks, independent offline distribution, explicit unknown/unsupported/missing states, no document/digest upload in default mode.
- [ ] Timestamp beta: bounded approved TSA transport, validated portable token, frozen policy, no silent downgrade, precise time-only claims and applicable operational gates.
- [ ] Approval beta: independent same-byte review, central email confirmation plus explicit consent, immutable signed receipt, verified integration and direct participant evidence delivery.
- [ ] Final-content boundary: a sealed B containing valid claims/receipts for approved A cannot be labelled approved. Establish the supported relationship or identify the preserved original as approved and completed-content relationship as unverified.
- [ ] Production readiness: abuse/tenant isolation, deletion and backup aging, restore/key-incident/shutdown drills, independent security review and exact user-facing claims signed off for enabled scope.
- [ ] Later capabilities receive their own enrollment/identity/preservation review; they are not inferred from a passkey, domain or timestamp badge.

## Tracking and decisions

Use `Backlog`, `In progress`, `Blocked`, `In review`, and `Done` in task metadata. When work starts, assign a person to the role, link its implementation PR, and record any scope changes. A blocked task names the unresolved decision and owner. Mark Done only when its acceptance criteria and verification evidence are satisfied, including documentation and deployment obligations in scope.

Do not replace explicit open decisions with guessed production values. Provider/region, volume/budgets, retention windows, receipt format, supported parser, trust anchors, recovery objectives and final hostnames have owning tasks. No new infrastructure subscriptions, GitHub issues, production credentials or deployments are created by this backlog.

## Scope boundaries to preserve

- Central features are off by default and opt-in per installation and per capability. Without configuration, an installation makes no central requests and works as today. The endpoint is configurable (interim host, staging or self-run) rather than hard-coded.
- Independent email approval targets participants without BankID or a comparable independent provider; installations using such providers do not need it.
- Local verification is available without central enrollment. Independent email approval and timestamping are separately selectable protections.
- API admission, issuer recognition, email access, credential control and civil identity are distinct claims.
- Central servers never need PDF bodies, drawings or full private audit exports for this scope; email confirmation does require address/context processing.
- Document availability/retention is still an operator/participant responsibility. A verification service cannot recover missing originals or receipts.
- Retained receipt inclusion/hash claims do not prove visible final-content equivalence; arbitrary redacted evidence does not retain the full evidence hash.
- Required protection never silently downgrades; maliciously removed policies can only be identified against independently retained expectations.
