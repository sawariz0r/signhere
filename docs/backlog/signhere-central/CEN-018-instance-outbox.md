# CEN-018: Connect instances through a durable outbox

- ID: CEN-018
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Self-hosted backend engineering (unassigned)
- Depends on: CEN-016, CEN-017

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Dedicated connection key in existing key volume, enrollment state in PostgreSQL, safe owner endpoints and bounded outbound HTTPS to configured trusted service.
- Apply only to new evidence-v2 documents, each bilaga independently, with no automatic legacy/backfill registration. Freeze opt-in per new transaction. Compose atomic trust enqueue with existing completion/email hook in server/finalization.ts; never do network work under document locks.
- PostgreSQL leases/generation fencing, stable request IDs, backoff/jitter, receipt verification and local exact-proof persistence; distinguish PDF completion from registration state.
- Handle disabled, retrying, action_required and payment_required, resume after payment, and coherent DB/key backup/restore. No rewrite of signed artifacts.

## Acceptance criteria

- [ ] Completion rollback leaves no orphan queue row; a committed completion survives process death before send and before local receipt persistence.
- [ ] Lost response/restart/concurrent workers produce the same globally deduplicated immutable receipt for the exact completed hash, with stale workers fenced.
- [ ] Wrong service, hash, signature or key cannot enable registered; outage does not block local completion or falsely claim central success.
- [ ] Opt-out performs no central calls. PDF key rotation, same-key restore and explicit connection-key recovery preserve correct trial/plan and proof history.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
