# Claude Fable 5.1 review: privacy-first verification and trust without BankID

Date: 2026-09-24. Actual Claude CLI 2.1.281 consultation. Returned model metadata confirms `claude-fable-5-1`; the substantive review completed in 60,268 ms, one turn, with medium effort.

Scope: the prepared architecture brief only, prefaced with instructions to provide a written critique without tools. Claude did not inspect source, browse, run tests, or receive the additional project security/timestamp documents. The consultation used a dedicated reviewer system prompt, safe mode, disabled tools/customisations, strict MCP configuration, and no session persistence.

The first high-effort invocation confirmed the same model but returned a file-search invocation instead of a substantive review; it is not counted as a completed critique. The response below came from the explicit written-critique retry. Raw input and response files remain in ignored local test artifacts.

This response is preserved verbatim as review input. Some recommendations and factual claims require correction; see [assessment and dispositions](2026-09-24-fable-trust-dispositions.md). It is not a source audit, security certification, legal determination, or proof of implementation.

Submitted input SHA-256: d31c08308ab7bedca072103b6f25f89027312d1a4261914c863f0520ad979fbb

---

# Architecture critique: trust without BankID (brief-only review)

**Scope note:** This is a design critique of the supplied brief only, not a source audit. Statements about `verification-package.ts`, `verify-sealed-evidence.mjs` and related files are inferences from the brief and are unverified.

## Verdict: **Revise**

The proposal is honest about its limits, and the local-browser verifier plus opt-in RFC 3161 timestamp are sound, low-risk improvements. But it does not meet the stated user need. Everything it adds strengthens *the operator's seal*; nothing strengthens *the participant's approval*. After timestamping, "person X approved document D" remains a bare operator assertion that a dishonest operator or compromised installation can fabricate with zero cost.

**Most important change:** add a participant-side commitment to the exact prepared-document hash that the operator cannot forge — at minimum, a participant-held or independently-witnessed approval token bound to `(document hash, transaction id, nonce, consent text)` — and report it as a distinct claim in the verifier. Without this, the first release should be labelled as "operator-sealed with independent time" and must not be marketed as improved participant trust.

## 1. What trust the proposal actually provides

| Adversary | Integrity of sealed PDF | Time of seal | Participant approved D | Audit events true |
|---|---|---|---|---|
| (a) Later file editor | Protected (seal) | Protected (TSA) | n/a | n/a |
| (b) Compromised installation | Broken (key on host) | Bounded (can't backdate) | **Fabricable** | **Fabricable** |
| (c) Dishonest operator with key | Broken | Bounded | **Fabricable** | **Fabricable** |
| (d) Compromised signhere.se | Unaffected by default (local verify) except code delivery | Depends on TSA, not gateway | n/a | n/a |

Key observations:

- The timestamp only proves *the operator produced this exact seal no later than T*. It does not prove a participant existed, saw the document, or consented. The evidence core is operator-authored and operator-sealed; (b) and (c) can write anything into it.
- A compromised installation is arguably the *worst* case for this design because it can also issue timestamps that look fully legitimate, lending false authority to fabricated evidence. The brief should say explicitly that timestamping raises the value of a forged evidence core.
- Against (d), the browser-delivered verifier code is the weak point: a compromised signhere.se can serve a verifier that reports anything. The downloadable verifier mitigates this only if its hash is published out-of-band and reproducibly built.

**Honest minimum?** As a *seal-integrity and time* feature, yes. As "trust without BankID", no. Highest-value addition: an independent approval witness (see §2).

## 2. Participant methods compared

| Mechanism | Who verifies | Who can fabricate | Binds to doc hash / txn / consent / nonce / time | Portable proof to participant |
|---|---|---|---|---|
| Personal bearer link (current) | Operator | Operator, anyone with link, mail interceptors | Only in operator logs | None |
| Fresh email OTP at approval | Operator | Operator (it generates and checks the OTP) | Only in operator logs | None |
| Independently operated email confirmation | Third party | Operator only if it colludes with third party | Yes, if the confirmation payload includes the doc hash and nonce | Signed receipt |
| Separate-channel challenge (SMS/second address) | Operator | Operator | Operator logs only | None |
| Passkey (WebAuthn) | Operator's RP, but assertion is signed by participant's authenticator | Operator cannot forge the assertion signature; it *can* forge the challenge contents unless challenge = H(doc hash ‖ txn ‖ nonce ‖ consent) | Yes, if challenge is constructed as above | WebAuthn assertion + public key (portable, verifiable offline) |
| Participant-held signing key | Participant | Only the participant | Full, if participant signs the digest | Full CMS/JWS signature |

Points the brief must adopt:

- A self-issued OTP is *not* independent evidence. Neither is a second message to the same mailbox. Both are only operator logs.
- Passkeys are the practical sweet spot: no third-party service, no civil identity, but a participant-controlled signature over a challenge derived from the exact document hash. The evidence core should store the raw assertion, client data, credential public key, and the challenge derivation inputs. Attack: the operator substitutes a different `challenge` that the browser signs blindly — mitigated by deriving the challenge deterministically from data the verifier can recompute.
- Independent email confirmation service: minimum data it needs is `(doc hash, txn id, nonce, consent text hash, participant email)`. It can attest consent to the *exact hash* without seeing content, but only if the user-facing message *displays the hash* (or a short fingerprint) and the participant's viewer shows the same fingerprint. Privacy cost: email + timing + hash linkability at the service. Interaction cost: one extra click.
- All methods remain vulnerable to the operator's viewer/UI: a compromised installation can display document A while computing hashes over document B. This residual is only closable by participant-side rendering (downloadable viewer, or independent "render and hash" step). State this limit plainly.

All of the above verify *control of a channel, account or key* — never civil identity. Labels must reflect that.

**Recommended minimum flow (no BankID):** bearer link → participant downloads or views document → server computes `challenge = H(docHash ‖ txnId ‖ nonce ‖ consentTextHash)` → passkey assertion (or independent email receipt as fallback) → assertion stored in evidence core and, ideally, sealed by TSA → participant receives an evidence card (doc hash, assertion, public key, timestamp token, verifier link).

## 3. RFC 3161 timestamp vs witness registry

- **RFC 3161 on the CMS signature** proves seal time; stays in the PDF; no central state; verifiable offline with the TSA chain. Does not prove the document existed before the *operator* saw it, only before T.
- **Witness registry** (commitment + signed receipt) additionally: (i) lets a participant independently confirm "my approval of hash H was witnessed at T" without trusting the operator's PDF; (ii) provides an audit trail that survives an operator deleting or re-issuing a transaction; (iii) enables detecting two conflicting sealed versions of the same transaction. It costs central state, a retention policy, and a linkability surface.

A registry is *not* justified for the first release *as a document registry*. It *is* justified as an optional **approval-witness endpoint** if the participant-side commitment in §2 is adopted, because the participant otherwise has no portable proof. This can be stateless (return a signed receipt, store nothing) which avoids most registry concerns.

Do not describe either as a qualified signature, identity verification, exact human signing time, or truth of audit events.

## 4. Privacy and central service

- **Digest linkability:** signature-value digests are unique per seal; the TSA can link repeat installations, count transactions, and observe timing. Route through a gateway only if it strips client IP and batches; otherwise it just adds a second observer.
- **Logs/metadata:** the gateway sees installation identity (if authenticated), IP, timing, volume. State that signhere.se can infer business activity levels.
- **"Documents stay on the device"** is only as true as the delivered JavaScript. Mitigations: subresource integrity, published verifier hash, reproducible build, downloadable verifier with a signed manifest, and no network calls in default mode (verifiable by user in devtools — mention this).
- Suggested statement: "Verifieringen sker i din webbläsare. Dokumentet skickas inte till signhere.se. Anslutningsdata (IP-adress, tidpunkt) kan loggas. Tjänsten är inte anonym."
- Suggested setting label: keep the proposed wording but add "(dokumentets innehåll skickas inte; anslutningsdata kan loggas)".

## 5. Portability and preservation

To verify after both services shut down, preserve: the completed PDF; the exact prepared original; the private evidence core (or a participant-appropriate subset); the installation certificate chain with validity history; TSA certificate chain and CRL/OCSP snapshots at signing time; and any participant assertions/receipts. The brief currently has no mechanism for capturing revocation material at signing time — add a LTV-style embedding (DSS/VRI in the PDF) or the timestamp is unverifiable once the TSA CA expires. Plan for archival re-timestamping but do not promise perpetual validity.

**Participant evidence export:** a small package containing document hash, prepared original (optional, participant-chosen), their own assertion/receipt, seal certificate fingerprint, timestamp token, and a plain-language explanation. Exclude other participants' data.

State explicitly: central verification does not retain documents and cannot recover lost files.

## 6. Smallest defensible release and gates

**Release 1:** local-browser verifier (integrity + issuer fingerprint + timestamp presence), opt-in RFC 3161 with LTV embedding, five separate status indicators, downloadable verifier with published hash. **Milestone 2:** passkey approval bound to doc hash + participant evidence export. **Milestone 3:** domain attestation, optional stateless witness receipts.

Required checks before release 1:
- CMS/PDF parsing in the browser: fuzz incremental updates, multiple signatures, byte-range gaps, and shadow-attack variants (content after the signed range).
- Timestamp verification: expired TSA chain, wrong policy OID, hash mismatch, token over wrong signature value.
- Outage/retry: policy fixed pre-signing; failure → pending with visible state; retries must re-verify the token before embedding; never silently seal without timestamp.
- Adversarial: forged evidence core with valid seal and timestamp (should still show "identity: not verified").

**Swedish labels** (no single "verified" badge): "Dokumentet oförändrat sedan försegling", "Utfärdare: känd / okänd", "Oberoende tidsstämpel: ja / nej", "Deltagarens identitet: ej verifierad / nyckelbunden / BankID", "Underlag: tillgängligt / saknas".

## Unresolved questions requiring authoritative verification

- Whether the embedded evidence commitment scheme survives PDF incremental updates without a shadow-attack vector (source audit needed).
- Legal weight of passkey-bound approvals under eIDAS/Swedish law (legal determination needed; do not claim advanced signature status without counsel).
- Whether the chosen TSA offers CRL/OCSP snapshots suitable for LTV, and its retention of logs.
- Whether "domain enrollment" wording can avoid implying organisational identity in Swedish consumer-protection terms.

This document is architecture input only and is not a security audit, certification, or legal determination.
