# CEN-013: Add passkeys with trustworthy enrollment and recovery

- ID: CEN-013
- Status: Backlog
- Priority: P2
- Milestone: Later identity and authentication capabilities
- Owner: Authentication and security engineering (unassigned)
- Depends on: CEN-001, CEN-003, CEN-004, CEN-006, CEN-008, CEN-009, CEN-010

## Goal

Offer repeat participants a phishing-resistant credential flow on the independent service while preserving accurate identity claims and portable evidence. A passkey registered only by the hosting operator is not sufficient independent evidence of the named participant.

## Scope and deliverables

- Choose the independent relying-party origin/enrollment model. Bind registration to an independently confirmed account/contact or separately documented identity evidence, with the distinction recorded.
- Specify enrollment, multiple devices/synchronised passkeys, credential addition/removal, lost access, recovery, changed email and compromise. An operator cannot silently replace the trusted credential association.
- Bind assertions to approved document/intent/consent commitments and a fresh service challenge. Reuse the trusted display/hash boundary from CEN-003.
- Validate WebAuthn RP ID/origin, operation type, challenge, algorithms, presence/verification flags and applicable counter/backup semantics with maintained libraries/current specifications.
- Export exact assertions, public keys, relevant enrollment/account-binding evidence and policy versions. Specify offline checks and historical recovery/key status.
- Treat recovery as a potential assurance change. Replacement credentials never retroactively relabel old approvals.
- Provide accessible independent email fallback without claiming equivalent assurance or silently changing a transaction's required method.
- Separate authentication-method and civil-identity UI fields. No biometric templates go to Signhere.

## Acceptance criteria

- [ ] A malicious instance cannot enroll its credential as an existing participant or replace exported keys without failing independently anchored association checks.
- [ ] Displayed/hashed document bytes match the assertion. Deterministic challenge construction alone is not treated as protection against a deceptive viewer.
- [ ] Wrong RP ID/origin, challenge, account, document, consent, replay, algorithms or required verification flags fail precisely.
- [ ] Recovery/removal/email changes/multiple devices have tested effects on future approvals without rewriting historical evidence.
- [ ] Exports permit offline credential-control/transaction-binding checks; missing enrollment proof is explicit.
- [ ] Synced credentials and counters follow the selected specification; not every passkey is assumed to be an unexportable hardware key.
- [ ] UI reports the credential/account method separately from civil identity; passkeys alone never imply BankID or advanced/qualified-signature status.
- [ ] Accessibility and fallback preserve explicit transaction policy and consent.
- [ ] Privacy review covers stable identifiers, correlation, recovery records, retention and exported personal data.

## Verification evidence

Cross-browser/device results; negative WebAuthn/recovery vectors; malicious enrollment tests; offline proof checks; independent security review of registration and recovery authority.

## Open decisions

RP/domain lifetime, central account requirement, enrollment evidence, recovery authority, synced-device policy, identifier privacy and assertion-envelope representation. Authentication/security engineering owns these before making stronger assurance claims.

## Exclusions

Not required for the first independent email release. No civil identity proofing, biometric database, automatic eIDAS classification or operator-controlled enrollment disguised as independent trust.
