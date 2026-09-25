# Review brief: privacy-first verification and trust without BankID

Status: proposal for review, not an implemented feature or completed external review.

## Objective

Assess how Signhere can provide meaningful, accurately described trust for people who do not use BankID, while preserving self-hosting, minimising disclosure to signhere.se, and allowing verification after the original installation shuts down.

Please challenge the proposal and identify missing protections. Do not treat the proposed architecture or its terminology as already approved. Review only; no implementation or deployment is requested.

## Current implementation

- Participants approve a frozen prepared PDF through a personal bearer link, explicit consent, a claimed name, and a drawn signature. The method records that identity is not independently verified.
- The installation seals the completed PDF with its own cryptographic key. Fresh installations use a self-signed certificate. Privileged operators control this sealing authority.
- The PDF commits to the exact prepared PDF and a separate frozen private evidence core. Full evidence includes participant/request details and is currently exported only to authenticated team members. Recipients receive the completed PDF.
- A Node/Python offline verifier checks the PDF seal and evidence bindings. Issuer trust requires an independently trusted certificate fingerprint. Current verification has no trusted timestamp or revocation check.
- The public website verifier currently hashes a PDF in the browser and queries the installation's database. It is not browser-local cryptographic verification.
- Documents and evidence persist in PostgreSQL. There is no complete retention/erasure policy workflow. Recipients must preserve their own copies to avoid relying entirely on the operator.

Relevant local references: `../signing-security.md`, `../architecture.md`, `../rfc3161-feasibility.md`, `../../server/verification-package.ts`, and `../../scripts/verify-sealed-evidence.mjs`.

## Proposed architecture

1. A public verifier at signhere.se checks supported PDF seals locally in the browser. Documents, private evidence, and file fingerprints are not uploaded for this default verification. Any supported self-hosted artifact can be checked without enrollment. An unknown issuer remains explicitly unknown. A downloadable verifier supports use without signhere.se.
2. An opt-in setting adds an independently trusted RFC 3161 timestamp to the installation's CMS signature. Only the signature-value digest and protocol fields go to the timestamp service, potentially through a signhere.se gateway. The token is verified and embedded before the completed PDF is delivered. There is no central document registry in this proposed first release.
3. The timestamp policy is fixed for a transaction before signing. Required timestamp failures preserve accepted approvals and keep finalisation pending or explicitly failed; no silent downgrade is allowed. Timestamping historical records later does not certify their claimed historical signing time.
4. Optional later enrollment binds an installation key to a verified domain through a portable signed attestation. Domain control, legal organisation identity, installation key possession, and signer identity remain distinct claims. Historical keys and attestations must remain verifiable.
5. The verifier reports document integrity, issuer recognition, trusted timestamp, signer authentication/identity assurance, and evidence availability separately.

Suggested setting wording: "Lägg till oberoende tidsstämpel via signhere.se". Document contents, participant names, email addresses, drawings, and private audit records are not sent for timestamping. Connection IPs, authentication, timing, and operational metadata can still be observed; do not describe the service as anonymous.

## Questions requiring a critical review

### 1. What trust does this provide without BankID?

Identify which claims are supported against (a) an ordinary later file editor, (b) a compromised self-hosted installation, (c) a dishonest operator with the installation key, and (d) a compromised central service. Explain what remains only an operator assertion even after timestamping.

The essential user need is stronger evidence that an actual participant approved the specific document, not only that the operator sealed a file. Does the proposed first release meet a useful, honest minimum? What additional mechanism would have the greatest value?

### 2. Compare practical non-BankID participant methods

Consider personal links, a fresh email challenge at approval, independently operated email confirmation, an optional separate-channel challenge, passkeys, and participant-held signing keys. Distinguish control of a contact channel/account/key from verified civil identity.

For each recommended mechanism, state who verifies it, who can fabricate its evidence, how it binds the participant, exact prepared document hash, transaction, consent, nonce, and approval time, and what portable proof the participant receives. A self-hosted operator's claim that an OTP succeeded is not automatically independent evidence. A second message to the same mailbox is not an independent factor by itself.

If an independent approval service is recommended, identify the minimum data it must receive, user interaction and privacy costs, and whether it can substantiate consent to the exact document without seeing the document. Assess the remaining trust in the document viewer and signing interface.

### 3. Standard timestamp versus independent witness registry

Compare the proposed RFC 3161 signature timestamp with an alternative service that retains an immutable document commitment and returns a portable signed witness receipt. Which user problems does either solve that the other does not? Is a document registry justified for the first release?

Do not equate a timestamp with a qualified signature, verified participant identity, exact human signing time, or verified truth of audit events. Do not treat domain enrollment as verified company identity.

### 4. Privacy and central service trust

Assess digest linkability, endpoint/access logs, account metadata, traffic correlation, abuse prevention, and whether an external TSA gateway improves the tradeoff. Identify practical limits on the claim that documents stay on the device, including trust in browser-delivered verifier code. Propose appropriately scoped user-facing statements.

### 5. Portability and preservation

Specify what must be preserved to verify after the self-hosted installation or signhere.se shuts down. Distinguish the PDF's seal/time proof from the separate prepared original and private audit evidence. Assess timestamp trust roots, certificate history, compromise/revocation, historical validation material, and later archival renewal without promising perpetual validity.

Recommend a privacy-appropriate participant evidence export and clarify that central verification does not provide document retention or recover missing files.

### 6. Implementation and product gates

Identify the smallest defensible release, required protocol/profile changes, browser PDF/CMS validation risks, necessary adversarial tests, and outage/retry behaviour. Suggest Swedish labels that communicate the actual assurance without a single misleading "verified" badge.

## Requested output

- Verdict: proceed, revise, or reject, with reasons.
- Highest-priority gaps and attack scenarios.
- Recommended minimum trust flow for a participant without BankID.
- Clear claim/evidence/limitation mapping.
- First-release scope versus later milestones.
- Any unresolved factual or legal questions requiring authoritative verification.

This review is architecture input. It must not be represented as an executed security audit, production certification, or legal determination.
