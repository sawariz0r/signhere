# CEN-019: Ship hash verification and portable receipts

- ID: CEN-019
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Verification and recipient-flow engineering (unassigned)
- Depends on: CEN-016; CEN-017/018 for integrated paths

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Dedicated clean origin: hash selected PDF locally, explicitly submit digest-only public lookup, validate central receipt and display narrow registration/time claim.
- CLI receipt checking without full private evidence, authenticated historical keys and offline instructions; combine separate local PDF/evidence results when requested.
- Add trust-receipt.jws to team verification package and narrowly authorized recipient proof download without private evidence. Choose later proof download as MVP default when email beats receipt issuance.
- Keep existing final PDF identical; completion email can link to existing receipt access, with clear pending/ready proof status. No new central content transfer.

## Acceptance criteria

- [ ] Browser/network/proxy capture proves selected filename, bytes and evidence never leave browser; no analytics/error file capture or arbitrary certificate fetch.
- [ ] PDF mutation, receipt substitution, unknown service/key, tampered signature and central compromise status produce distinct honest results.
- [ ] Expired payer and deleted/offline original instance do not prevent public lookup or offline checking of retained PDF/receipt with trusted keys.
- [ ] Recipient scopes deny other documents/private evidence; package receipt matches the exact previously downloaded/emailed PDF, including pending-to-ready race.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
