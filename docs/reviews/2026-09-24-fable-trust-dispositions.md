# Assessment of Fable's non-BankID trust review

Date: 2026-09-24. Status: reviewed design recommendation; no application features implemented by this consultation.

The [actual Fable 5.1 critique](2026-09-24-fable-non-bankid-trust.md) reviewed the [architecture brief](2026-09-24-non-bankid-trust-review-brief.md), not source code. Its central finding is accepted: portable seal verification and independent timestamps strengthen the record, while evidence of participant approval needs a separate design against a dishonest hosting operator.

This does not imply that existing simple electronic signatures have no evidential value. It distinguishes ordinary operational trust from evidence independent of the organisation operating the signing installation.

## Accepted direction

- Build local cryptographic verification for supported artifacts, with an independently obtainable offline version. The current public hash lookup is not that verifier.
- Add optional RFC 3161 timestamps with a transaction policy fixed before signing, verified responses, and explicit handling of required-service failures.
- Preserve separate results for file integrity, issuer recognition, independent time, participant authentication/approval evidence, and evidence availability.
- Provide participant-appropriate portable evidence and retain the exact prepared PDF. Verification services do not provide document retention or recover lost files.
- For stronger trust without BankID, design an optional approval step outside the self-hosted operator's control. Independently confirmed email access is a practical candidate; passkeys can add credential continuity when enrollment and recovery are trustworthy.

## Corrections and qualifications

| Fable recommendation or claim | Disposition |
| --- | --- |
| Self-hosted passkeys are sufficient independent participant evidence. | Not accepted as stated. A malicious operator can substitute its own enrolled credential/public key under another person's claimed name. An independently established credential-to-account association, preserved enrollment evidence, and controlled recovery are necessary for the stronger claim. |
| Recomputing a deterministic challenge mitigates a malicious viewer. | Incomplete. It validates payload binding, but a hostile page can display PDF A while correctly constructing a challenge for PDF B. The independent approval interface must render and hash the same participant-reviewed bytes and bind explicit consent to them. |
| An email message and viewer showing matching fingerprints suffice. | Incomplete. The hostile viewer can lie about the fingerprint as well as the document. Independently delivered code must calculate the digest from the actual displayed bytes. Mailbox takeover, forwarded links, and witness compromise remain risks; collusion is not the only failure mode. |
| A stateless receipt provides registry conflict detection and recovery. | Not accepted. A signed receipt can be portable without permanent document storage, but detecting conflicting versions, recovering missing receipts, or maintaining a complete history requires additional retained state or independent monitoring. |
| Key compromise means PDF integrity is simply broken. | Too broad. Compromise permits newly sealed alternatives. It does not silently alter a retained artifact already anchored outside the operator's control. A trusted timestamp establishes existence by its time, not who personally produced a seal or the truth of recorded events. |
| TSA certificate expiry automatically makes existing timestamps unverifiable. | Incorrect as an absolute. Cryptographic checks and historical trust validation are different. Preserve relevant certificate/status evidence, define validation policy, and plan renewal as cryptography ages. PDF DSS/VRI structures alone do not establish long-term assurance. |
| SRI or a hash published on the same website protects against its compromise. | Insufficient for the top-level verifier. Independently authenticated releases improve this boundary; a compromised page can change both its code and its claimed hashes. Reproducible builds aid inspection but are not a trust anchor by themselves. |
| A gateway only hides the client's address if it batches requests. | Too strong. A gateway can avoid forwarding the original address without batching. Timing correlation and gateway logs remain concerns, and the gateway introduces another observer. A digest alone does not inherently identify the installation. |
| Identity labels can mix "key-bound" and BankID. | Keep authentication method separate from identity assurance. A passkey or email-confirmation result must not imply that civil identity was verified. |

These are engineering assessments, not an eIDAS classification. WebAuthn explicitly distinguishes authenticator user verification from concrete identification of a natural person, and depends on the relying-party/client security boundary. [W3C WebAuthn](https://www.w3.org/TR/webauthn-3/#user-verification), [security considerations](https://www.w3.org/TR/webauthn-3/#sctn-security-considerations).

NIST describes confirmation codes as evidence of access to an address and treats identity proofing separately. This supports a precise "email access confirmed" claim, not a civil-identity claim. [NIST SP 800-63A-4, section 3.8](https://pages.nist.gov/800-63-4/sp800-63a.html).

Timestamp evidence establishes existence by a time. Historical validation and renewal need appropriate trust and status material; neither a current expiry date nor the presence of a timestamp alone decides all historical validity questions. [RFC 3161, security considerations and Appendix B](https://www.rfc-editor.org/rfc/rfc3161.html).

## Recommended non-BankID flow to specify next

1. The self-hosted instance prepares and freezes the document and participant intent. Optional independent approval is selected before invitations.
2. The participant uses a separate signhere.se approval page. That page obtains the exact prepared PDF directly into browser memory, renders it, and computes its digest from the same bytes. The central server does not receive the PDF. Secure file transfer, origin separation, and resistance to misleading document rendering are explicit design requirements.
3. Signhere independently confirms access to the participant's email address and records explicit approval bound to those bytes. The assertion binds the verified address, document hash, transaction and participant context, exact consent/version, independent challenge nonce, validity window, and confirmation method. Sender-supplied names remain claims. Challenge creation, verification, one-time use, and receipt signing cannot be delegated back to the self-hosted operator.
4. Signhere returns a signed approval receipt directly to the participant and to the installation. The installation includes the receipt in its evidence before final sealing. Participants receive enough evidence to verify their own approval and the document binding independently; other participants' private request data is excluded.
5. The final artifact retains the installation seal and optional independently trusted timestamp. Offline verification checks the independent receipt and its trust anchor as well as the document/evidence bindings. Neither original service needs to be running to check preserved artifacts, provided the necessary verifier and trust material are retained.

Proposed option: **"Bekräfta signering via signhere.se"**. Explain that the independent service processes the email address, document commitment, consent context, and connection metadata, while the PDF content stays in the browser. Keep this distinct from the less-disclosing timestamp-only option.

This design shifts approval trust to the independent confirmation service and its client code. It does not eliminate trust, prove civil identity, prove every page was read, or withstand a compromised participant device/mailbox. Service key protection, receipt format, replay prevention, enrollment/recovery, privacy/retention, abuse limits, finalization retries, and trusted historical verification still need specification and adversarial testing.

A service can avoid permanent document storage and a public document index while retaining short-lived challenge/replay state. Do not advertise it as literally stateless without designing those requirements.

## Scope and sequencing

Local verification and standard timestamping remain useful standalone improvements. If the release is intended to improve participant trust against a dishonest self-hosted operator, independent approval and participant evidence export must be part of that claim's release criteria, rather than deferred behind a passkey badge.

Passkeys and domain/organisation attestations can follow as separate capabilities after enrollment and identity claims are specified. Archival validation material and renewal need a separate preservation milestone; do not promise indefinite validity from a first timestamp integration.

No production code or signing behaviour changed during this review. No tests were run for these documentation-only additions. The next implementation step is a concrete protocol and threat model for the independent approval flow, followed by implementation review.
