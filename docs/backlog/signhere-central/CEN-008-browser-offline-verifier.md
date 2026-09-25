# CEN-008 — Browser and offline cryptographic verifier

- ID: CEN-008
- Status: Backlog
- Priority: P1
- Milestone: Portable verification beta
- Owner: Browser/cryptography engineering (unassigned)
- Depends on: CEN-001, CEN-006

## Goal

Let a recipient inspect a supported PDF and their portable evidence locally, without
sending the document or its digest to signhere.se. Verification must keep file integrity,
issuer recognition, trusted time, independent approval, and evidence availability separate.

## Scope and deliverables

- Build a maintained-library PDF/CMS validation engine usable in a browser and a packaged
  offline verifier. Check signed bytes and signature semantics; the existing database hash
  lookup is not cryptographic verification and is not the implementation of this feature.
- Serve the hosted verifier from the dedicated trust origin proposed in the service design
  (for example verify.signhere.se), reached through signhere.se. Keep its dependencies,
  authentication state, CSP, update path, and storage isolated from the self-hosted viewer.
- Freeze and publish the supported PDF/signature profile with CEN-001: byte-range coverage,
  one signature/Contents slot, allowed CMS attributes, canonical manifest and receipt
  bindings, permitted PDF structures, and treatment of unsigned content and trailing bytes.
- Validate whole-file coverage and reject unsupported/incrementally revised/shadowed or
  ambiguous files. Define parser/rendering limits, active-content restrictions, and what
  consistency can be established between rendered content and signed byte semantics.
  A mathematical CMS signature alone must not produce a document-level success badge.
- Validate central receipts against separately trusted receipt keys, exact prepared bytes,
  transaction/instance/participant context, consent, nonce, and policy. Distinguish a valid
  standalone receipt from proof that the final installation seal includes that receipt.
  Require CEN-001/CEN-009's explicit inclusion proof before claiming final-artifact inclusion;
  a redacted evidence file cannot be checked against the hash of its unredacted original.
- Preserve and verify the exact approved prepared original. A final seal's protected hash
  or receipt inclusion proves a commitment, not that the final visible content matches it.
  Independently validate the approved-to-final content relationship within the strict supported
  profile, or report "approved original verified; completed content relationship unverified".
  Do not infer general rendering equivalence or approval of final content from embedded claims.
- Report missing prepared PDFs, missing own-receipt evidence, or unavailable bindings as
  unavailable evidence. Filenames, visual similarity, claimed times and annotations are no proof.
- Add timestamp token cryptography and TSA trust checks using CEN-007 fixtures when available;
  keep the base seal verifier independently deliverable. Embedded TSA/issuer certificates
  provide candidate material, not a new trust anchor.
- Define stable per-claim machine and UI results: valid, invalid, unsupported, missing,
  untrusted, and stale/indeterminate as applicable, with a reason and verification policy
  version. Approval results name the confirmation method and verified email-access claim;
  sender-supplied names remain claims, and email confirmation never becomes civil identity.
- Default to no network requests after application loading: no document or digest upload,
  certificate/OCSP/CRL/AIA fetch, hash lookup, telemetry, remote fonts, or crash payloads.
  Explain optional trust updates before fetching and keep document-derived data out of them.
- Publish authenticated offline releases and trust snapshots with CEN-006 bootstrap guidance,
  reproducible build evidence, version/rollback policy, dependency inventory, and update
  documentation. A checksum or SRI hosted on the same compromised page is insufficient.

## Acceptance criteria

- [ ] A supported sealed PDF verifies in each supported browser and offline package with
  installation and central services unavailable; byte edits and altered CMS fail correctly.
- [ ] Wrong byte ranges, uncovered/trailing content, multiple signatures, later revisions,
  duplicate attributes, malformed/oversized objects, ambiguous PDF structures, and archive
  bombs stop safely with specific invalid/unsupported results rather than a green badge.
- [ ] Resource limits prevent unbounded CPU, memory, nesting, rendering, and archive expansion;
  active PDF content cannot execute or cause network traffic in the preview or verifier.
- [ ] Valid/invalid/unknown keys and TSA fixtures generate independent integrity and trust
  results, including stale trust snapshots and unavailable historical status evidence.
- [ ] Receipt substitution, another recipient/transaction/instance, wrong consent, and a
  missing or mismatched prepared PDF cannot satisfy the independent-approval binding check.
- [ ] A valid own receipt without final inclusion proof is labelled accordingly; a forged
  inclusion path or edited private-evidence subset cannot establish final inclusion.
- [ ] Approved original A plus validly sealed final B whose protected hash, receipt and inclusion
  proof all refer to A cannot produce an "approved final content" result. The strict-profile
  relationship check rejects substitution or reports the completed-content relation unverified.
- [ ] Packet capture and browser instrumentation show no artifact, hash, certificate URL,
  participant data, or artifact-triggered request leaves the default verification session.
- [ ] A signed offline release rejects a substituted trust root and documents how its initial
  release/anchor authenticity was checked outside the current signhere.se website.
- [ ] Result wording is understandable in Swedish and English and never collapses unknown
  issuer, email access, seal integrity, and legal identity into a single trusted/valid label.

## Verification evidence

- Public synthetic fixture corpus, expected per-claim results, and browser/offline parity tests.
- Differential PDF/CMS checks against an independent maintained implementation, parser limits
  and adversarial rendering results, plus a reviewed documented unsupported-profile policy.
- Network trace, offline reproducibility/release verification transcript, accessibility checks,
  and result-screen examples for missing evidence, unknown issuers, and timestamp-only files.

## Open decisions and exclusions

- Select supported browsers, maintained crypto/PDF libraries, deployment origin, resource
  budgets, and accepted legacy profiles. Legacy hash-only records cannot gain a seal by lookup.
- A hosted verifier still trusts the code delivered by its origin; independent offline
  distribution improves this boundary without guaranteeing safety on a compromised device.
- CEN-009 owns participant evidence packaging; CEN-007 owns timestamp production. Their
  integration gates apply before advertising those specific verification capabilities.
- Legal enforceability, document recovery/retention, civil identity, and archival LT/LTA
  conclusions are excluded; later preservation validation belongs to CEN-015.

## Design references

- [Fable review dispositions](../../reviews/2026-09-24-fable-trust-dispositions.md)
- [RFC 3161 feasibility checkpoint](../../rfc3161-feasibility.md)
