# CEN-020: Add one-click owner onboarding and clear status

- ID: CEN-020
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Product/frontend engineering (unassigned)
- Depends on: CEN-017, CEN-018; CEN-019 for verifier links

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Owner-only Instans toggle and optional setup choice, default off, with short Swedish explanation, exact data disclosure and trial-start action.
- Enable automatically without account/card/API key; show connection, central trial deadline, document registration state and retry/recovery actions.
- Owner upgrade prompt near/after expiry with yearly/lifetime choices; signers see verification status, never a paywall.
- Provide clear disabled, unreachable, clock-error, payment-required and ready states; accessible mobile flow and pending proof download.

## Acceptance criteria

- [ ] Fresh private/NAT installation enables with one action and no public callback; repeated clicks do not create trials/duplicate keys.
- [ ] Members cannot enable/manage billing; service outage does not show connected/registered success.
- [ ] Day 14 is clear, local signing remains usable after expiry and historical verification stays accessible.
- [ ] Copy describes fingerprint registration and metadata honestly, without identity/legal/timestamp assertions or hidden uploads.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
