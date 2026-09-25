# CEN-014: Add portable domain and organisation attestations

- ID: CEN-014
- Status: Backlog
- Priority: P2
- Milestone: Later identity and authentication capabilities
- Owner: Trust operations and security engineering (unassigned)
- Depends on: CEN-001, CEN-002, CEN-006, CEN-008, CEN-010, CEN-011

## Goal

Recognise an installation's issuing key using independently issued portable evidence. API admission, key possession, domain control, legal organisation identity and participant identity are different claims.

## Scope and deliverables

- Define opt-in purpose-bound challenges proving enrollment-key possession and current domain control. Resolve normalisation, subdomains, expiry and reassignment before choosing DNS or bounded HTTPS verification.
- Issue versioned signed attestations with approved public claims, key/domain binding, issuance/validity policy and verification method. Preserve historical offline verification.
- Specify renewal, key rotation, domain sale/expiry, lost keys, compromise/revocation, corrections, disputes and shutdown. New domain control does not retrospectively own old artifacts.
- Keep API-client admission from CEN-002 separate. Private/local installations still sign and receive honest unknown-issuer results.
- Any verified-company label requires a separate organisation-proofing process, authority checks, reviewers, appeals and retention policy. DNS, HTTPS, logos and branding do not establish legal entity identity.
- Display exact issuer claims and temporal limits. Retain signed attestations in exports; live lookup is not the only proof source.
- Obtain explicit publication choices for domain/company/key relationships; no default directory of private customers or documents.

## Acceptance criteria

- [ ] A replayed proof or uncompleted independent challenge cannot establish another instance's key/domain claim.
- [ ] HTTPS challenges cannot become arbitrary fetchers; private/link-local addresses, redirects, rebinding and unbounded responses are covered.
- [ ] An API credential alone never produces a verified-domain/company badge.
- [ ] Artifacts before/after domain transfer, rotation or compromise remain distinguishable; uncertain historical status is explicit.
- [ ] Saved attestations/artifacts and independently trusted service keys support offline binding checks without inventing current domain ownership.
- [ ] Domain and organisation proof have separate statuses/evidence/expiry policies; neither establishes participant identity.
- [ ] Non-enrolled instances retain local signing and verification; absence of enrollment does not mean tampering.
- [ ] Public attestations contain no document IDs, participant information or private onboarding evidence.
- [ ] Any company-proofing process passes recorded operational/legal/privacy review before stronger labels are released.

## Verification evidence

Challenge spoof/replay/SSRF tests; domain-transfer/key-recovery scenarios; offline attestation fixtures; precise UI claim snapshots; privacy review of discovery/onboarding records.

## Open decisions

DNS/HTTPS verification, key-role separation, domain normalisation, organisation assurance/reviewers, renewal/disputes, publication defaults and historical-status distribution. Trust operations owns these with security/privacy input.

## Exclusions

No mandatory enrollment for integrity checks, universal certificate trust, automatic company verification, central document registry or signer-identity claim.
