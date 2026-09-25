# signhere central protocol v1 (`signhere-central-v1`)

Status: implemented for independent email approval (beta). Timestamping is not part of v1. Implementation: `server/central/protocol.ts` (shared by service, installation and browser), `server/central/app.ts` (service), `server/independent-approval.ts` (installation), `scripts/verify-approval.mjs` (independent offline verifier).

The service is **optional**. An installation with no `SIGNHERE_CENTRAL_URL` never contacts it, and documents created without the opt-in are unchanged. Participants who sign with an identity-verifying method (BankID, Freja, …) are never asked for central approval.

## What a receipt proves

| Claim | Established by | Not established |
| --- | --- | --- |
| Access to an email address | The service emailed an 8-digit code and the participant entered it | Civil identity, mailbox ownership, that no one else reads the mailbox |
| Approval of exact prepared bytes | The participant's browser hashed the bytes it rendered; the service accepted only that digest after an explicit consent step | That the participant understood the content; renderer/device honesty |
| Binding to one assignment | Receipt fields: service, instance, document, revision, recipient, prepared hash/size, intent hash, policy hash | That installation-assigned identifiers mean anything outside that installation |
| Time | Service clock (`approvedAt`, `issuedAt`) | Trusted third-party time (`assurance.trustedTimestamp` is always `false`) |
| Claimed name | Copied from the installation, marked `nameVerified: false` | Anything |
| Inclusion in the sealed record | The installation seal manifest lists `{recipientId, receiptSha256}` | That the completed PDF's visible pages equal the approved original |

A verifier must report these separately. In particular it never reports "document B approved" because a seal over B commits to a receipt for A: the completed-content relationship is always reported `unverified` in this version (see *Approved original versus completed PDF*).

## Threat model (summary)

| Actor | Can | Cannot (by design) |
| --- | --- | --- |
| Dishonest installation operator | Choose recipient addresses (including its own), lie in titles/names, refuse to finalize, reseal different content, strip the policy from its own records | Mint or alter a receipt; confirm a mailbox it does not control; reuse a receipt for another recipient/document/revision/installation; make a verifier with an independently obtained root accept a forged receipt |
| Stolen participant capability (URL fragment) | View the approval context, request codes | Confirm email or approve without the code from the participant's mailbox |
| Compromised mailbox | Confirm and approve as that address | — (inherent limit; documented in the receipt semantics) |
| Hostile PDF | Attack the browser's PDF renderer | Reach the service backend (it never receives PDFs) |
| Compromised central frontend | Mislead users during approval | Change issued receipts; forge receipts without the receipt key |
| Compromised receipt key | Forge receipts | Survive revocation for verifiers using a newer bundle (receipts from a revoked key are `revoked`, conservatively, because `issuedAt` is self-claimed) |
| Service shutdown | Stop new approvals | Invalidate issued receipts (offline verification needs only the receipt, bundle and root) |

## Envelope

Compact JWS (RFC 7515) with `alg: EdDSA` (Ed25519, RFC 8037).

- Protected header: exactly `{"alg":"EdDSA","kid":…,"typ":…}` in canonical form. Any other member (`jwk`, `jku`, `x5u`, `crit`, …) is rejected. The algorithm is never taken from the artifact.
- `typ` gives domain separation: `signhere-approval-receipt+jws` or `signhere-trust-bundle+jws`. Each payload also carries its own `schema`.
- Payload: canonical JSON (UTF-8, object keys sorted recursively, no whitespace, only safe integers). Parsers re-serialize and reject any difference, so duplicate members, whitespace and alternate encodings fail.
- base64url without padding; non-canonical encodings are rejected. `kid` = base64url(SHA-256(raw 32-byte public key)).
- Ed25519 is deterministic: retries return byte-identical receipts; the service also stores the exact bytes.

## Trust bundle and root

Payload `signhere-trust-bundle-v1`: `service` (origin), `sequence`, `issuedAt`, `keys[]` with `kid`, `alg: Ed25519`, `publicKey`, `purposes: ["approval-receipt"]`, `validFrom`, `validUntil|null`, `status: active|retired|revoked`, and `revokedAt` for revoked keys.

- Signed by the **trust root**, an Ed25519 key whose public half is distributed independently (repository README, releases, installation configuration). The root never appears as a service key and is kept offline; the running service loads only the receipt key.
- Verifiers take the root as an input (`SIGNHERE_CENTRAL_TRUST_ROOT`, `--trust-root`). The bundle and the service website do not establish their own trust.
- Rotation retires the active key (`validUntil` set) and adds a new one; retired keys stay listed so old receipts keep verifying. Revocation marks a key `revoked`; its receipts are no longer trusted by verifiers using the newer bundle.
- Installations accept a newer bundle only with a sequence number at least as high as the cached one, and store the exact bundle JWS with each accepted receipt.

## Receipt (`signhere-approval-receipt-v1`)

| Field | Purpose |
| --- | --- |
| `receiptId`, `nonce` | Unique receipt; unpredictable service randomness |
| `service`, `keyId` | Issuer origin and signing key (must match the bundle) |
| `instance.id` | Central account of the installation (API admission, not organisation identity) |
| `transaction.documentId/revisionId/recipientId` | Installation's assignment identifiers |
| `document.preparedSha256/preparedSize` | Exact prepared PDF bytes approved |
| `intentSha256` | SHA-256 of the installation's frozen `signhere-intent-v2` bytes for this recipient |
| `policySha256` | SHA-256 of the canonical frozen protection policy (detects policy substitution) |
| `consent.version/text` | Exact service-owned consent shown (`signhere-central-consent-v1`) |
| `email.address/confirmation/confirmedAt` | Normalized address (trimmed, lower-cased; no provider aliasing), `email-code-v1` |
| `claims.name`, `claims.nameVerified: false` | Installation-supplied name, explicitly unverified |
| `approval.method/approvedAt/documentSource` | `signhere-central-email-v1`; `installation-transfer` or `local-file` |
| `assurance` | `civilIdentityVerified: false`, `trustedTimestamp: false` |
| `issuedAt` | Service time; checked against key validity |

## State machine

`pending` → (code sent; resend invalidates the previous code) → `email_confirmed` → `approved` (receipt issued). Terminal: `approved`, `cancelled`. `expired` is derived from `expires_at` for open approvals.

- GET requests and link opening never change state. Email confirmation and approval are separate POSTs; approval requires an explicit `accepted: true` with the current consent version and the browser-computed digest.
- Codes: 8 digits, 15 minutes, 5 wrong attempts per code, 5 sends per approval, 30 s between sends. Attempt counters commit even when the response is an error.
- Approval runs in one transaction that locks the row, checks `email_confirmed`, signs, and stores the receipt. Concurrent approvals yield one receipt; retries return the stored bytes. A database trigger makes approved/cancelled rows immutable.
- Approval validity is at most 30 days (installation default: 30 days from first use). Expiry of the workflow never affects an issued receipt.

## API

Installation API (bearer API key `shc_…`, scope `approval`, tenant derived from the key):

- `POST /v1/approvals` — strict body: identifiers, email, name, title, prepared hash/size, intent/policy hashes, `participantCapabilitySha256`, `documentUrl` (must be on the installation's registered origin; never fetched by the service), `expiresAt`. Idempotent on (instance, document, revision, recipient) with a request fingerprint: identical retries return the same approval, any change returns 409.
- `GET /v1/approvals/:id` — status and, once approved, the receipt. `POST /v1/approvals/:id/cancel`.
- Polling is the delivery mechanism; there are no webhooks and no server-side URL fetching.

Participant API (`Authorization: Capability <approvalId>.<capability>`, from the URL fragment; POSTs must carry the service's own `Origin`): `GET /v1/participant/session`, `POST /v1/participant/code`, `POST /v1/participant/confirm`, `POST /v1/participant/approve`.

Public: `GET /.well-known/signhere-trust.json` (bundle + root key for convenience; pin the root independently), `GET /v1/health`.

The installation generates the participant capability and sends only its hash; it keeps the raw value to build the participant link `https://<service>/bekrafta#<approvalId>.<capability>.<transferToken>`. The capability alone cannot confirm email or approve.

## Prepared-PDF transfer

The participant's browser fetches `documentUrl` with a short-lived (2 h) read-only transfer token, rotated on each signing-page load and retired when the receipt is verified. The installation allows CORS only from the frozen service origin. If the fetch fails (private network, CORS), the participant can choose the PDF downloaded from the signing page; the digest check is identical. The same byte buffer is hashed and rendered with pdf.js.

## Installation integration

- The sender opts in per document; the frozen policy is `{"profile":"signhere-seal-v1","timestamp":"off","independentApproval":{"mode":"email","service":…,"trustRoot":…}}`. Without the opt-in the policy is unchanged.
- A participant with a self-asserted method cannot complete signing until a receipt is stored. Receipts are accepted only if signed by a currently trusted key in a bundle authenticated with the frozen root, and every field matches the frozen assignment.
- If configuration later changes (service removed, other URL or root), the frozen requirement stays and signing is blocked with a visible reason: no silent downgrade or redirect.
- The receipt and bundle are frozen in the evidence core; the seal manifest carries `policy.independentApproval: "email"` and `approvalReceipts: [{recipientId, receiptSha256}]`, validated strictly by the PDF engine.

## Approved original versus completed PDF

A receipt approves the prepared bytes. The completed PDF is a different file (signature page, seal). A seal over any document can list any receipt digest, so inclusion proves a commitment by the installation, not content equivalence. Verifiers in this version therefore always report `completedContentRelationship: "unverified"` and identify the approved original by digest. The participant package keeps the exact approved `original.pdf`. A supported, independently checkable relationship (e.g. page-level equivalence in a strict profile) is future work.

## Offline verification

```
node verify-approval.mjs receipt.jws trust-bundle.jws --trust-root KEY --prepared original.pdf
node verify-sealed-evidence.mjs evidence.json original.pdf completed.pdf --central-trust-root KEY
```

`verify-approval.mjs` is a separate implementation (`node:crypto`) from the shared TypeScript module, and both are exercised against the same receipts in tests.

## Decisions taken in v1 and open items

Taken: Ed25519 compact JWS; code (not link) confirmation; polling (no webhooks); installation-generated capability; service-owned consent text; lower-case/trim address normalization; 30-day workflow and default retention windows (configurable); receipts from revoked keys are not trusted regardless of claimed time.

Open (owned by backlog tasks): KMS/HSM custody for the receipt key (CEN-006); legal/provider review of retention (CEN-010); independent publication channel and signed releases for the root and verifier (CEN-006/CEN-008); timestamp gateway (CEN-007); browser PDF seal verification (CEN-008); completed-content relationship profile (CEN-001 follow-up); external security review (CEN-012).
