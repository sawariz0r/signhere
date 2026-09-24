# CEN-004: Independent email confirmation and signed approval receipts

- ID: CEN-004
- Status: Backlog
- Priority: P0
- Milestone: Independent approval beta
- Owner: Backend/security engineering (unassigned)
- Depends on: CEN-001, CEN-002, CEN-006
- Related: CEN-003, CEN-009, CEN-010

## Goal

Produce portable evidence that signhere.se confirmed access to a specified email address
and witnessed explicit approval of a bound document/intent. A self-hosted operator must
not be able to mint, replay or alter that evidence. The assertion is mailbox access and
approval at the service, not verified civil identity or independent proof of a person's name.

## Scope and deliverables

- Own challenge generation, outbound email, confirmation validation, consumption and receipt
  signing within the independent service. The installation cannot provide a trusted
  "email verified" flag, read confirmation secrets or complete this step through its API key.
- Define minimal persisted transaction state and strict transitions: pending, confirmed,
  approved/receipt issued, expired and cancelled, with bounded retention under CEN-010.
- Bind an unpredictable challenge to the frozen issuer/installation, transaction/revision,
  participant, prepared document digest, complete canonical intent/consent version and
  exact normalized address. Record both submitted and normalized forms when necessary.
- Keep email confirmation distinct from affirmative approval. Link previews, scanners and
  GET requests must not consume an approval or issue a receipt.
- Apply bounded expiry, attempt limits, rate limits and resend rules; a resend invalidates
  prior challenges without allowing an attacker to exhaust a legitimate user's approvals.
- Protect browser sessions, CSRF boundaries and challenge transfer. Specify how a forwarded
  link/code, shared mailbox, alias or compromised mailbox limits the resulting assertion.
- Freeze the canonical receipt format from CEN-001: schema/domain, receipt ID, service/key ID,
  issuer/transaction/participant context, prepared digest, intent and consent commitment,
  verified email claim, method, challenge binding and service-observed time.
- Include enough exact consent/intent material or separately signed disclosure material
  for participant verification; a bare hash is insufficient when the source is unavailable.
- Sign via the protected key interface in CEN-006. Explicitly distinguish service-observed
  time from a trusted third-party timestamp; no signing secret is exposed to the frontend.
- Commit challenge consumption and a durable receipt issuance operation atomically.
  Define recovery across database commit, key-service timeout and response loss.
- Provide the identical signed receipt directly to the participant and through a scoped
  authenticated installation retrieval API. Use bounded recovery capabilities and expiry.
- Treat callbacks as notification only unless their authenticated, replay-safe payload is
  the full verifiable assertion; the installation must verify the receipt either way.
- Document which receipt claims are private and how a participant can share a verifiable
  subset. Do not promise anonymity merely because document bytes remain local.
- Record abuse, issuance and recovery events without logging codes, credentials or PDFs;
  document the minimum correlation state and why the service is not literally stateless.

## Acceptance criteria

- [ ] The installation cannot receive a valid approval receipt using a forged email-verification
  flag, direct API call, substituted address, altered consent or unconfirmed challenge.
- [ ] The same mailbox confirmation cannot authorize a different document, participant,
  installation or revision. All tampering is rejected before receipt issuance.
- [ ] A malicious operator labels its own confirmed address with another person's name:
  the receipt and verifier expose the confirmed address and keep the name unverified.
- [ ] Guessing, resends, expired codes, replayed codes and concurrent requests respect limits;
  exactly one approval result is committed and retries return its identical receipt.
- [ ] Automatic email scanning, previewing, prefetching and GET requests cause no approval.
  User interaction still requires the independent document/consent approval step.
- [ ] Failure immediately before or after key signing, persistence and delivery cannot create
  conflicting receipts or silently consume a challenge without a recoverable outcome.
- [ ] Missing signing authority fails closed; no unsigned success or installation-created
  fallback receipt is returned. Error details do not reveal private transaction state.
- [ ] Lost responses and duplicate callbacks recover the same receipt; callback spoofing,
  replay and authorization across installations fail under the documented protocol.
- [ ] A saved receipt verifies against independently distributed public trust material with
  both servers offline; changed claims, malformed encoding and unknown versions fail clearly.
- [ ] Address changes and transaction revisions require new independent confirmation;
  recipient API access cannot disclose another participant's address or evidence.
- [ ] Clock skew and expiry boundaries follow a documented policy. The result never implies
  a trusted historical timestamp unless separately verified timestamp evidence exists.

## Verification evidence

- Published protocol vectors and independently implemented verification of signed receipts.
- State-machine/concurrency and failure-injection results at every issuance boundary.
- Mail delivery/scanner fixtures, challenge-abuse tests and a data inventory of database,
  provider, operational log and participant-visible fields for CEN-010/CEN-012 review.

## Open decisions

- Select code versus link confirmation and same-device versus cross-device session binding.
- Define address normalization, delivery-provider data handling, receipt availability window
  and authorized recovery, including what is impossible after challenge-state deletion.
- Choose the canonical signed format and participant disclosure mechanism in CEN-001;
  settle deterministic receipt recovery if the signing algorithm yields variable signatures.

## Exclusions

- Civil-identity proofing, mailbox ownership claims beyond observed access, and BankID.
- Storage or delivery of PDF content by signhere.se; perpetual receipt recovery.
- Backdating old approvals or interpreting central service time as an independent TSA time.
