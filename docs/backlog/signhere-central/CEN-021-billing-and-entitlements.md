# CEN-021: Add yearly and lifetime checkout

- ID: CEN-021
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Billing/backend engineering with product owner (unassigned)
- Depends on: CEN-017; CEN-020 for user journey

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Central account/signup and hosted checkout linked by signed owner-created one-time installation session; no pasted credential or self-hosted callback.
- Yearly prepaid explicit renewal and lifetime entitlement; keep actual prices/terms configurable and owner-approved before sale.
- Verified webhook signatures, event deduplication, authoritative-state reconciliation, cancellation/paid-through dates, refund/chargeback, recovery/transfer and separate billing access.
- No document data/counts in processor metadata. Billing login alone grants no document access. Publish lifetime service-exit/fair-use and anonymous trial abuse limits.

## Acceptance criteria

- [ ] Forged redirects, stolen linking state, wrong-instance links and forged webhook signatures cannot grant or transfer entitlement.
- [ ] Duplicate/out-of-order paid, cancelled and refunded events converge correctly and cannot extend access twice; lost response recovers.
- [ ] Trial exact boundary, purchase during paused retry, annual expiry/cancel-at-end, lifetime and key replacement are covered with a controlled clock, preserving remaining trial/paid time and defining the calendar-anniversary rule.
- [ ] Old receipts have no subscription expiry and still verify after every billing transition; no charge or automatic renewal without explicit purchase consent.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
