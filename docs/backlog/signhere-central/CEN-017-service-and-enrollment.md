# CEN-017: Build central service and automatic enrollment

- ID: CEN-017
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Central backend engineering (unassigned)
- Depends on: CEN-016

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Separate TypeScript/Express + PostgreSQL runtime and migrations with restricted database role. Implement challenge enrollment, authenticated issuance, public POST lookup and entitlement.
- Single-use challenges, idempotent same-key enrollment, original 14-day trial dates, body/replay limits, quota enforcement and bounded abuse buckets.
- Keep central receipt keys outside database; sign immutable receipts with trusted-key history and exact signed bytes. Implement connection-key rotation and scoped recovery interfaces.
- Disable sensitive request/log/error capture and arbitrary file/URL handling. Keep billing relations out of public results.

## Acceptance criteria

- [ ] Concurrent/replayed enrollment cannot restart a trial; trial boundaries use server time and clones share entitlement/quota.
- [ ] Instance A cannot rotate/manage B or retrieve B billing state; public record lookup exposes only allowed receipt fields.
- [ ] Record retry after expiry returns an already-issued receipt; an unadmitted new hash is denied with payment_required and previously admitted work can finish.
- [ ] Captured API/proxy/DB/error/backup samples contain only allowlisted fields; private URLs/files and extra metadata are rejected.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
