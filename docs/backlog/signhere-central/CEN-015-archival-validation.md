# CEN-015 — Historical validation material and archival renewal

- ID: CEN-015
- Status: Backlog
- Priority: P2
- Milestone: Later preservation
- Owner: Preservation/cryptography engineering (unassigned)
- Depends on: CEN-007, CEN-008, CEN-009

## Goal

Define and validate a preservation profile for portable evidence that outlives service,
certificate, and algorithm lifetimes. A first RFC 3161 timestamp and a collection of public
certificates do not establish indefinite validity or a long-term preservation service.

## Scope and deliverables

- Specify historical validation policy for installation seals, independent approval receipts,
  and timestamps as separate claims, including trusted time, chain/path constraints,
  algorithm cutoffs, revocation/status evidence, and uncertain compromise dates.
- Inventory the exact material needed to reproduce each claim: prepared and completed PDF
  bytes, receipt/inclusion evidence, timestamp tokens, certificate chains, authenticated
  trust/status snapshots, applicable policies, and revocation responses when relevant.
  Preserve provenance, applicable times, byte digests, and dependency relationships.
- Define authenticated evidence-package versioning and upgrade rules. Preserve the original
  bytes and first seal; package changes must not silently rewrite a previously approved PDF
  or replace missing evidence with a newly asserted history.
- Decide how the archive profile relates to the current single-signature/no-later-revision
  PDF profile. Evaluate detached archive evidence that covers immutable original artifacts
  before considering PDF DSS/VRI or document-timestamp revisions; any expanded PDF profile
  requires its own parser, semantic, interoperability, and security acceptance criteria.
- Design retrieval of historical certificate/status material with fixed providers, bounded
  transport/parsing, authenticated provenance, and explicit privacy controls. No hidden
  artifact-directed AIA/OCSP/CRL requests in the default local verification path.
- Define who collects, retains, and renews material: participant, operator, or an explicitly
  contracted central preservation service. Publish storage, availability, export, deletion,
  renewal, and shutdown responsibilities without implying central document custody by default.
- Design renewal before relevant evidence/algorithms lose assurance, using a documented
  contemporary cryptographic policy and an archive timestamp that covers the exact prior
  evidence chain. A later timestamp cannot recreate missing earlier evidence or cure forgery.
- Define job scheduling, safety margin, provider failover under fixed policy, failures,
  escalation, export and handover, and recovery after missed renewal. Preserve evidence of
  every renewal and report gaps rather than silently declaring continuous validity.
- Extend CEN-008 with reproducible historical-policy results: mathematical integrity,
  historical trust, current status freshness, preservation continuity, and missing material.
  Explain why today's certificate expiry alone neither proves nor disproves earlier validity.
- Coordinate privacy/retention decisions with CEN-010 and operating procedures with CEN-011;
  archive packages can contain participant data even when timestamp requests contain hashes.

## Acceptance criteria

- [ ] A fixture with expired certificates but sufficient trusted historical evidence receives
  the documented historical result; present-day expiry alone does not reject all prior work.
- [ ] Revoked/compromised keys before, after, and at uncertain signing times yield distinct
  policy-consistent outcomes; self-asserted signing times cannot establish pre-compromise use.
- [ ] Missing/stale/forged OCSP or CRL evidence, wrong certificate paths, untrusted historical
  roots, algorithm cutoff failures, and incomplete renewal chains cannot earn full assurance.
- [ ] A valid renewal binds every required prior artifact and validation input; modifying,
  substituting, omitting, or reordering protected evidence is detected by the archive verifier.
- [ ] Historical verification works with both original services unavailable and networking
  disabled, using the retained evidence and a separately authenticated policy/trust baseline.
- [ ] A renewal drill spanning key rotation and TSA rollover preserves original PDF bytes
  and receipt bindings; trust or provider changes are recorded and obey the chosen policy.
- [ ] Missed renewal, unavailable status services, provider failure, lost local package, and
  central shutdown produce explicit limitations and a documented user/operator action path.
- [ ] Default verification emits no certificate- or document-derived network request; any
  separate evidence collection mode has tested bounds, explicit consent, and redacted logs.
- [ ] Any proposed PDF revision profile passes adversarial and cross-implementation validation
  before release; the existing verifier does not silently relax its whole-file restrictions.
- [ ] Retention/export/restore tests demonstrate which party actually holds complete files;
  a hash registry or timestamp token is never described as recovering the underlying document.

## Verification evidence

- Reviewed preservation profile, claim-to-evidence inventory, and responsibility agreement.
- Public synthetic time/expiry/revocation/compromise/renewal fixtures with explicit policy
  dates and expected results, including deliberately incomplete evidence chains.
- Independent implementation interoperability report and offline historical-validation drill.
- Renewal/failure/shutdown runbook exercise, immutable-original-byte checks, and documented
  privacy assessment of optional retrieval and contracted preservation storage.

## Open decisions and exclusions

- Choose supported preservation standards/profile, archive container, trust baseline,
  renewal cadence, cryptographic transition criteria, and accountable service owner.
- Decide whether central preservation is offered at all and what storage/service guarantees
  it entails; local-only verification does not require central retention of documents.
- Evaluate LT/LTA and qualified-preservation terminology only after the chosen standards,
  actual behavior, operational obligations, and independent assessment justify those claims.
- This is a later milestone, not a dependency for the limited first timestamp release.
  Earlier releases must clearly state their preservation limits and required user exports.
- No promise of indefinite assurance, retroactive repair of evidence gaps, verification of
  civil identity, or universal statutory retention duration is part of this task.

## Design references

- [Fable review dispositions](../../reviews/2026-09-24-fable-trust-dispositions.md)
- [RFC 3161 feasibility checkpoint](../../rfc3161-feasibility.md)
