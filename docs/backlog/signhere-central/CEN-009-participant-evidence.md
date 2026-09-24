# CEN-009: Participant evidence that survives either service shutting down

- ID: CEN-009
- Status: Backlog
- Priority: P0
- Milestone: Independent approval beta
- Owner: Evidence/export engineering (unassigned)
- Depends on: CEN-001, CEN-004
- Related: CEN-005, CEN-008, CEN-010, CEN-011

## Goal

Give each participant enough portable evidence to check their own independent approval
and its relationship to the completed document after the installation and signhere.se
are unavailable, without exposing other participants' private audit data.
A final PDF alone must not be described as the complete evidence record.

## Scope and deliverables

- Specify a participant package with exact approved prepared PDF bytes, exact signed receipt,
  canonical consent/intent or verifiable participant disclosure, completed PDF when available,
  necessary public validation material and a versioned manifest/readme.
- Distinguish the prepared PDF from a pre-conversion upload and from the final reserialized
  PDF. Do not reconstruct the approved byte stream from final document pages.
- Create a participant-visible evidence structure defined in CEN-001 that binds the receipt
  to installation/transaction/participant identity, prepared digest and frozen intent.
- Verify the receipt against the final PDF's protected prepared digest and document/instance
  bindings. Define a protected receipt inclusion commitment if claiming it was included in
  the installation's sealed record; mere file adjacency proves no such inclusion.
- Distinguish those protected claims from a verified relationship between approved original
  and completed visible content. Preserve the exact approved original and independently
  check the approved-to-final relationship within CEN-001's strict supported profile. Otherwise
  report "approved original verified; completed content relationship unverified". A matching
  embedded hash/inclusion proof is insufficient; general rendering equivalence is not assumed.
- Separate independently signed participant claims or use a specified disclosure proof
  for any committed private structure. Redacting an existing committed evidence-core JSON
  changes its hash and cannot be presented as proof of that original commitment.
- State exactly what a participant package can verify without the private evidence core.
  Missing full-audit evidence is an explicit limitation, not a successful full-audit check.
- Exclude other participants' IPs, user agents, email confirmation secrets and private audit
  events. Account for names/addresses already visible in the completed PDF; do not promise
  that packaging removes disclosures already made by the underlying document.
- Deliver the central receipt directly from the independent service after approval and offer
  an immediate browser-side save of that receipt plus approved prepared PDF.
- Deliver/update the completed package from the self-hosted installation after finalization.
  Explain that signhere.se cannot recreate a missing PDF from its document commitment.
- Define participant-scoped authenticated downloads, expiration and recovery consistent with
  CEN-010; avoid shared predictable URLs and prevent a team export from leaking through them.
- Include independently distributed verifier/release identity and trust-root acquisition
  instructions from CEN-008. Bundled code or a bundled key must not authenticate itself.
- Preserve raw signed bytes, schema versions, public key history and validation material;
  packaging/renaming must not reserialize signatures or alter evidence commitments.
- Provide Swedish participant copy explaining what is saved, what each check means,
  what remains unavailable before completion and the participant/operator retention roles.
- Document shutdown/export handling and how each participant receives pending/final evidence.
  Availability promises must match actual central retention and operator delivery policy.

## Acceptance criteria

- [ ] A participant can save the prepared PDF and central receipt immediately after approval,
  even if the installation becomes unavailable before document completion.
- [ ] A completed package verifies the participant's approval and exact prepared bytes with
  both services offline; receipt inclusion and completed-content relationship are separate
  results, and each passes only when its protocol-defined evidence actually establishes it.
- [ ] Receipt substitution across documents, installations or participants fails, including
  when the final PDF is validly sealed but contains a different prepared-document binding.
- [ ] An operator supplies approved original A and validly sealed final B with all protected
  hashes, receipt claims and inclusion proofs pointing to A. This cannot establish approval of
  B: the strict-profile relationship check rejects it or explicitly reports that relation unverified.
- [ ] Altering one byte of the prepared PDF, signed receipt, consent disclosure or commitment
  proof fails the appropriate check. Unverifiable private audit content is never marked valid.
- [ ] Removing a receipt or inclusion proof produces an explicit missing-evidence result;
  a PDF-only selection explains which checks remain possible without inventing full evidence.
- [ ] A privacy review confirms participant downloads cannot expose another participant's
  private audit payload, credentials or central email secrets, including archive manifests.
- [ ] Malformed archives, path traversal, decompression bombs, duplicate filenames and oversized
  manifests are rejected by package consumers under documented limits.
- [ ] Expired/revoked or cross-participant download capabilities cannot retrieve evidence;
  a downloaded valid package remains verifiable after the link expires.
- [ ] Download, email attachment or retry failures remain visible and recoverable while policy
  permits. A logged delivery attempt is not represented as confirmed participant receipt.
- [ ] A package remains valid after public key rotation under the recorded verification policy;
  offline results clearly distinguish cryptography from unavailable current revocation status.
- [ ] Historical documents lacking independent receipts keep explicit legacy limitations;
  exporting them cannot create a claim of independently witnessed approval.

## Verification evidence

- Privacy-reviewed example archives for pending, completed, multi-participant and legacy flows.
- Cross-check fixtures with CEN-008's browser/offline verifier, including independently sourced
  trust material, both servers blocked, missing files and tampered bindings.
- Authorization and archive-parser adversarial results plus a documented shutdown rehearsal
  proving what is preserved, what is recoverable and what requires an operator-held copy.

## Open decisions

- Choose ZIP versus an embedded standardized container, or both. If embedding prepared bytes
  and receipts inside a final PDF, define profile changes and final-seal coverage explicitly.
- Choose separate signed claims versus selective-disclosure proofs in CEN-001; document
  correlation/privacy tradeoffs rather than assuming a redacted JSON export still verifies.
- Determine maximum package/email size, retention window, and participant recovery channels;
  independently retained receipts cannot substitute for absent source document bytes.

## Exclusions

- Indefinite central storage, recovery of documents from hashes, and complete audit disclosure.
- Automatic legal-retention compliance or indefinite cryptographic validity.
- Claims that a participant's package proves all other participants' identities or approvals.
