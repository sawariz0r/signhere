# CEN-022: Prove privacy, recovery and release readiness

- ID: CEN-022
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Operations/security with product owner (unassigned)
- Depends on: CEN-016 to start; CEN-017–021 evidence before paid release

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Choose domain/origins, region/provider, key custody, supported capacity, quotas, support owner, budget and recovery targets. No domain purchase/deploy is authorized by this planning task.
- Complete privacy/logging/provider/backup/deletion policy, receipt retention and lifetime/service-exit terms; keep marketing code off trust origin.
- Paired central database/key backup and restore, rotation/compromise drill, authenticated trust distribution and offline shutdown package.
- Collect adversarial, concurrency, expiry, browser/network and failure evidence at exact candidate revision. Record unresolved limitations and staged rollout/rollback.

## Acceptance criteria

- [ ] Real deployment captures prove no PDF/context ingestion at proxy, app, monitoring, mail, billing and backup boundaries.
- [ ] Restore recovers immutable receipts/entitlements and key history; key-loss/compromise/shutdown checks never backdate time or invent trust.
- [ ] Published limits are supported by measured issuance, lookup, database-growth and support costs for yearly/lifetime plans.
- [ ] All enabled feature checks from CEN-016–021 pass; zero-credential local-only regression passes; release states no identity, consent, RFC3161 or browser-CMS claim.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
