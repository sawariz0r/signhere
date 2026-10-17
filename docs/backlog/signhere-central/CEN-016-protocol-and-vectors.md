# CEN-016: Freeze digest-only protocol and claims

- ID: CEN-016
- Status: Backlog (not started)
- Priority: P0 for digest-only launch
- Owner: Security/protocol engineering (unassigned)
- Depends on: None

Read the [current architecture and product contract](../../central-service-plan.md). This task does not enable the historical independent-approval scope.

## Deliverables

- Publish exact allowlisted enrollment, record, lookup, entitlement and control schemas; reject unknown/duplicate keys, unsupported versions and oversized input.
- Choose maintained JWS receipt and HTTP Message Signatures libraries with cross-runtime algorithm proof, strict trust rules and exact bytes. Specify HTTP covered components, nonces/time and separate business idempotency; no receipt-controlled key fetches.
- Specify immutable receipt and minimum database columns, no public submitter attribution, global hash deduplication, atomic pre-expiry admission, idempotency after expiry, replay TTL and bounded one-receipt lookup.
- Freeze claims, time meaning, trial boundary, account/record deletion and compromise semantics; arbitrary digests from authenticated hostile instances remain unvalidated records.

## Acceptance criteria

- [ ] Cross-runtime receipt/auth vectors pass and mutated hash, audience, path, algorithm, key ID, request body and duplicate JSON fail.
- [ ] Approved-A/completed-B and arbitrary non-PDF digest fixtures never produce consent, completion, verified issuer or valid-PDF claims.
- [ ] Full API/data inventory has no PDF, filename, title, document ID, party/consent fields, callback URL or PDF certificate.
- [ ] Repeated same-body requests return the same signed receipt, changed-body reuse is rejected, and retained-receipt retrieval works after payment expiry.

## Verification evidence

Record exact candidate commit, focused automated/integration results, relevant redacted network/browser or recovery evidence, remaining limitations and review disposition. These are future required checks, not checks passed by the planning PR.
