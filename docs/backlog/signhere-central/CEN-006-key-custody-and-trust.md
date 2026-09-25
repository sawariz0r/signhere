# CEN-006 — Receipt key custody and independent trust distribution

- ID: CEN-006
- Status: Backlog
- Priority: P0
- Milestone: Foundation
- Owner: Security/cryptography engineering (unassigned)
- Depends on: CEN-001

## Goal

Make central approval receipts independently verifiable after either service closes, with
explicit boundaries for key compromise, key rotation, and historical evidence. A public
key carried by an artifact must never make its own issuer trusted.

## Scope and deliverables

- Define separate key roles for approval receipts, trust/status statements, release
  signing, installation PDF sealing, and TSA signing; document authority and blast radius.
  TSA and installation private keys are outside central receipt-signing authority.
- Specify a versioned, authenticated trust bundle containing key identifiers, public
  material, allowed purposes, validity intervals, algorithm policy, issuer assertions,
  and signed key lifecycle/status records. Resolve the bootstrap anchor independently
  of the receipt, embedded certificates, and the current signhere.se page.
- Choose a receipt signing format and maintained library with CEN-001; require exact
  serialization, algorithm restrictions, domain separation, and rejection of duplicate
  or ambiguous fields. Never accept an artifact-selected algorithm or trust URL.
- Implement a custody design using managed HSM/KMS or a documented equivalent:
  non-exportable production keys, narrowly scoped signing authorization, separate
  environments, dual control for sensitive lifecycle operations, and audit evidence.
- Bind signing permission to successful central challenge and approval validation;
  possession of a signing API credential alone must not authorize arbitrary receipts.
- Specify creation, staged activation, overlapping verification, rotation, retirement,
  emergency suspension, compromise notification, and disaster recovery procedures.
  Keep retired public verification material available; never require retired secrets.
- Publish portable signed trust/status snapshots through independently authenticated
  releases and a second distribution route. Define how users obtain and verify the
  initial anchor and update authority; SRI on the same website is insufficient.
- Separate current trust, cryptographic integrity, historical trust, and status freshness.
  A receipt's claimed issue time alone cannot prove it predates a key compromise.
- Define compromise cutoffs, independent time/evidence requirements, and conservative
  outcomes when historical status is unavailable or a snapshot is too old.
- Coordinate redacted signing audit records with CEN-010 and emergency response with
  CEN-011; do not create a public receipt or document-hash index as part of key custody.

## Acceptance criteria

- [ ] An offline verifier authenticates a fixture using a separately provisioned anchor;
  substituting both the receipt key and its embedded trust bundle does not confer trust.
- [ ] An unknown issuer, wrong key purpose, unapproved algorithm, malformed signature,
  duplicate key identifier, or ambiguous payload returns a specific non-success result.
- [ ] Production signing authorization cannot sign an arbitrary attacker-provided payload,
  and development credentials cannot invoke production signing or lifecycle operations.
- [ ] A normal rotation preserves verification of old fixtures and accepts new fixtures
  only within the documented key-purpose and activation policy.
- [ ] Key compromise exercises distinguish unchanged anchored historical evidence from
  newly forged/backdated receipts; receipt timestamps alone cannot pass the cutoff test.
- [ ] Missing, stale, conflicting, or rollback trust/status snapshots produce explicit
  uncertainty or rejection according to policy, including on a newly installed verifier.
- [ ] Revocation and compromise statements are independently authenticatable; replacing
  the live website and its published checksum cannot establish a new trusted root.
- [ ] An offline verification drill succeeds after central APIs and installation services
  are unavailable, without accessing any production private key.
- [ ] The recovery and rotation drill records responsible roles, independent approvals,
  monitoring events, distribution steps, and the evidence retained for later review.

## Verification evidence

- Reviewed key hierarchy, trust bootstrap/update specification, and lifecycle runbooks.
- Synthetic signed fixtures covering rotation, compromise, stale status, key substitution,
  unauthorized purpose, malformed serialization, and historical verification outcomes.
- KMS/HSM policy review and access tests; no private keys or real recipient data in reports.
- Offline verification transcript with documented anchor provenance and network disabled.

## Open decisions and exclusions

- Select KMS/HSM provider, separation of administrative roles, algorithms, signing format,
  and the independent initial-anchor distribution mechanism before implementation.
- Choose status freshness windows and recovery guarantees; an offline verifier cannot
  know about a compromise announced after its latest authenticated snapshot.
- Domain control and organisation identification are CEN-014; email receipt keys do not
  verify a participant's civil identity. BankID and qualified-signature claims are excluded.
- Archival status preservation and renewal belong to CEN-015. Key retention alone does
  not establish indefinite validation or guarantee that missing artifacts can be recovered.

## Design references

- [Fable review dispositions](../../reviews/2026-09-24-fable-trust-dispositions.md)
- [RFC 3161 feasibility checkpoint](../../rfc3161-feasibility.md)
