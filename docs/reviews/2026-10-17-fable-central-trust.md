# Fable implementation-design consultation: central trust platform

Date: 2026-10-17. Requested by the user for the digest-only central-service plan.

- Configured provider/model: `claude-reviewer/claude-fable-5-1` (confirmed by Paseo agent inspection).
- Paseo agent: `93e7d4f8-f259-4954-86ec-61b6b5a2c006`.
- Reviewed source HEAD: `bade218bf2b183d7561a777564c88b5f68a3aa8a`.
- Reviewed draft PR #12 snapshot: `0aea9b73d90cf1dd915a72eb2624d71afecef20f`.
- Scope: read source and existing draft; recommend implementation details. No application implementation or tests. Fable produced a provider plan artifact outside the repository; no repository edits were delegated.

This is advisor input, not an approved specification, security audit, pricing recommendation or certification. Read the [assessment and corrections](2026-10-17-central-trust-dispositions.md) and [current plan](../central-service-plan.md). These consultations preceded the final synthesized plan and are not reviews approving its exact final revision. Source links in Astra's response have been normalized to the reviewed GitHub revision; otherwise the response is preserved.

## Response

Full recommendation follows. Drafted plan file for provenance: `/home/prpl/.claude/plans/you-are-an-implementation-design-sparkling-nest.md`. Analysis is against HEAD `bade218bf2b183d7561a777564c88b5f68a3aa8a` and PR #12 branch `origin/codex/signhere-central-backlog` at `0aea9b73d90cf1dd915a72eb2624d71afecef20f`. No files in the repository were touched.

## Headline

Build a **digest-only registry with signed receipts** first. After a document completes locally, the instance sends the completed-file SHA-256, a canonical digest of the protected seal manifest, and the sealing certificate fingerprint. Central returns an Ed25519 JWS receipt carrying its own observed time. The signed PDF is never altered, completion is never blocked, and central never sees content, titles, names, counts, sizes, document IDs or IP addresses. Revise PR #12 on its own branch to put this in front of its larger scope, and mark the email-approval tasks as deferred optional scope.

## Context from the code

- Every completed v2 document already gets one whole-file CMS seal with a protected manifest (`server/app.ts:131-137` builds `SealManifest`, `server/seal.ts:14-24` defines it, `scripts/pdf-seal/engine.py:180-230` embeds it as an uncompressed `/SignhereSeal` stream).
- The completed-file hash deliberately lives outside the PDF (`server/finalization.ts:116-128`).
- Issuer trust is "unknown" unless the verifier obtains the fingerprint independently (`scripts/verify-sealed-evidence.mjs:64-74`; `/.well-known/signhere-sealing.json` at `server/app.ts:360-363` says `trustAnchor: false`).
- Public `/verify` is a local hash lookup with browser-side hashing (`web/settings.tsx:8-27`, `server/app.ts:696-700`).
- Durable outbox patterns exist twice: `finalization_jobs` and `email_deliveries` (`server/delivery.ts:86-135`, hooked in via `onPublished` at `server/finalization.ts:26,129`).
- The frozen protection policy is `{timestamp:'off'}` and anything else is rejected at `engine.py:191` and `server/app.ts:123`.

## 1. MVP trust claim and threat model

The receipt claim is exactly: *"signhere.se received digest D of a completed PDF and digest M of its protected manifest from enrollment E, which had registered sealing certificate fingerprint F, at central time T."*

| Threat | MVP outcome |
| --- | --- |
| Operator later re-seals a different document and calls it the original | Detected: the original's receipt predates any replacement. Participants see and can save the receipt at completion. |
| Operator claims a document was registered when it was not | Prevented: receipt is a JWS by the central key. |
| Operator registers a fabricated document | Not prevented. The receipt proves existence-by-time and registering enrollment only. Copy must say so. |
| Instance shut down | Central `/verify` answers by hash; the PDF still carries seal and certificate for the offline verifier. |
| Central outage | Outbox retries; completion never waits. Local verify unaffected. |
| Central key compromise | Receipts are hash-chained in the central DB; optional daily external RFC 3161 anchoring of the chain head bounds backdating. Historical keys stay in the JWKS. |
| Enrollment A registers under B's certificate | Rejected: the fingerprint must already be bound to that enrollment. |

Not claimed: identity, consent, organisation identity, RFC 3161 trusted time, legal qualification, or content equivalence between prepared and completed PDF. The approved-A/sealed-B problem in PR #12 is unchanged by this service and remains an offline-verifier concern.

## 2. Receipt versus central seal, TSA or log

| Option | Verdict | Reason |
| --- | --- | --- |
| Central countersignature inside the PDF | Reject | Needs bytes or byte-range digests and a second signature; the profile rejects extra signatures and revisions. |
| RFC 3161 token in the CMS | Later milestone | Blocks completion on the network, needs TSA procurement, changes the frozen policy and the key-worker/transport split. Keep as CEN-007 after the registry. |
| Merkle transparency log | Later, optional | Overengineering now. The receipt reserves a `chain` field so inclusion proofs can be added without a new version. |
| Signed receipt over (completedHash, manifestDigest) with a DB hash chain | Adopt | Detached, asynchronous, no PDF change, trivial browser verification, survives instance shutdown. |

Receipt (compact JWS, EdDSA via `jose`, `kid` header):

```json
{ "iss": "https://signhere.se", "typ": "signhere-receipt/v1", "jti": "<id>",
  "iat": 1760970000, "completedHash": "<hex>", "manifestDigest": "<hex>",
  "certificateFingerprint": "<hex>", "enrollment": "<opaque id>",
  "chain": { "sequence": 12345, "previous": "<hex>" } }
```

`manifestDigest = sha256(canonical(manifest))` using the canonical JSON already in `server/db.ts` and `engine.py`. That hides documentId, preparedHash, evidenceDigest, installationId and checkpoint from central while still binding them, because the offline verifier already extracts the manifest.

## 3. Final-hash circularity and portability

No circularity: the receipt is about the final bytes and sits beside them. Portability changes:

- Verification package (`server/verification-package.ts:5-18`) adds `central-receipt.jws` and `central-keys.json` (the JWKS the instance last cached). README states the JWKS is not its own anchor; fetch it from the well-known URL independently.
- `verify-sealed-evidence.mjs` gains `--central-keys <file>` and reports `centralRegistration: registered | absent | invalid` with the receipt time, separate from integrity and issuer trust.
- Evidence JSON (`server/app.ts:566-576`) gains an optional `central` block and `assurance.centralRegistration`.

## 4. Enrollment, key auth, restore, rotation, replay

One toggle in Settings → Instans (owner-only, `web/settings.tsx:113-128`): "Använd signhere.se som central förtroendetjänst".

- The instance generates an Ed25519 keypair in the keys volume under `keys/central-enrollment/`, reusing the `privatePath` checks from `server/key-store.ts:20-30`. The public key fingerprint is the identity. No account, email, password, card or manual API key.
- `POST /v1/enrollments` with `{ publicKey, certificateFingerprint, clientVersion }`, signed by the new key as proof of possession. Response: `{ enrollmentId, trialEndsAt, serverTime, jwks }`. Idempotent on public key.
- Request auth: a JWS per call with `iss=enrollmentId`, `aud=<central origin>`, `iat`, `jti`, `bodySha256`. Skew over 5 minutes rejected; `jti` kept 10 minutes for replay. Registration idempotency is the completedHash.
- Local singleton table `central_enrollment` holds id, public key, origin, cached status and entitlement. Private key only on disk. DB says enrolled but key missing → `action_required`, never silent re-enrollment, same rule as `identity_recovery_required`.
- Restore after total loss: enter the license key from the purchase email → `POST /v1/entitlements/claim` rebinds the entitlement, bounded to about 3 claims per year. Trial-only installations just re-enroll.
- Enrollment key rotation: new JWK signed by the old key plus proof by the new key, via a subcommand in the `sealing-keys.mjs` style.
- Sealing certificate rotation is lazy: registration with an unknown fingerprint gets 422 `unknown_certificate`, the worker adds the fingerprint and retries. Fingerprint history is kept centrally.
- The existing paired DB and keys backup covers everything.

## 5. Exact allowlisted API and central schema

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/enrollments` | PoP by new key | Create or resume enrollment, starts trial |
| `GET /v1/enrollments/self` | enrollment JWS | Status, entitlement, limits, prefilled checkout URL, server time |
| `POST /v1/enrollments/self/certificates` | enrollment JWS | Add sealing certificate fingerprint |
| `POST /v1/enrollments/self/keys` | old and new key | Rotate enrollment key |
| `POST /v1/entitlements/claim` | enrollment JWS | Bind purchased entitlement by license key |
| `POST /v1/receipts` | enrollment JWS | Register `{ completedHash, manifestDigest, certificateFingerprint }`. 402 without entitlement, 409 if another enrollment registered the hash |
| `POST /v1/receipts/lookup` | none, rate-limited | `{ completedHash }` → receipt or 404. POST body so proxies never log the hash |
| `GET /.well-known/signhere-trust.json` | none | JWKS with historical keys, validity, status |
| `POST /v1/billing/webhook` | provider signature | Entitlement creation |

Bodies are at most 4 KiB, HTTPS only, no redirects, with the SSRF-safe transport rules from `docs/rfc3161-feasibility.md`. Strict schemas reject unknown fields. No PDF, URL fetch, title, filename, pages, size, recipient count, name, email, team name, IP persistence or free text anywhere.

Central tables: `enrollments`, `enrollment_keys` (history), `enrollment_certificates`, `entitlements` (kind trial, yearly or lifetime; provider order id; hashed license key), `receipts` (completed_hash primary key, manifest_digest, certificate_fingerprint, received_at, receipt_jws, sequence, previous_hash, chain_hash, append-only trigger like `reject_event_mutation`), `request_nonces`, `central_keys`.

Logs and analytics: no third-party scripts on the trust origin, no IP in any table, proxy access logs kept 7 days, counters-only metrics, error reports without bodies. Instance side reuses the `last_error_code` pattern.

## 6. Browser-local hashing, no upload

Central `/verify` uses the same model as `web/settings.tsx:18`: `crypto.subtle.digest` on the file, only the hex digest leaves the device, then the lookup POST. An optional `#<hash>` fragment prefills from links the instance renders; fragments never reach servers. Result wording states three separated facts: registered at T by an enrolled installation, certificate fingerprint F, and that this proves neither who signed nor which company runs the installation. No browser CMS validation in MVP; link to the offline verifier.

Instance `/verify` shows the stored receipt after a local match with a link to central, or "central registrering pågår" when enrolled but pending.

## 7. Binding to the completed sealed artifact

Verifier chain: file bytes → sha256 = receipt.completedHash; manifest from `/SignhereSeal` → canonical digest = receipt.manifestDigest; manifest.certificateFingerprint = receipt.certificateFingerprint = actual CMS certificate; receipt signature valid against the JWKS by `kid`. Any substitution fails one equality. A valid receipt for a PDF whose seal fails locally is reported as "registered but seal invalid", never green.

## 8. Expiry, outage and shutdown

- Expiry stops new receipts only. Lookups and the JWKS stay free forever; receipts are never deleted since they hold no personal data. State this in the privacy text.
- Central outage: outbox retries with backoff capped at one hour for 30 days; the document stays completed; UI shows pending.
- Instance shutdown: central verify still answers; the offline package still verifies.
- Central shutdown: publish a final JWKS and a signed, hash-chained static export of receipts to a static host. The retention commitment is a product decision.

## 9. Outbox and pending-versus-completed policy

Registration is strictly post-publication and never gates completion. Insert a `central_registrations` row inside the publishing transaction through the existing `onPublished(client, documentId)` hook, exactly like `enqueueCompletedCopies`. Worker: a copy of `createDeliveryWorker` with `FOR UPDATE SKIP LOCKED`, lease and fencing. States: `queued | sending | retry | registered | expired_unregistered | failed`. Only evidence-v2 documents, since legacy v1 has no manifest (`server/app.ts:798-801`). Bilagor register individually. The closed audit chain is untouched; registration lives in its own table.

A "required" mode that blocks completion is deliberately out of scope. It would extend the frozen policy and the Python manifest check and belongs with the TSA milestone.

## 10. Trial, entitlement and payment

- Trial starts at the first successful enrollment response, central clock, persisted on both sides, shown as "Provperiod till YYYY-MM-DD". 14 days. Optional soft cap of about 500 receipts per trial.
- At trial end central returns 402. The instance keeps outbox items pending for a 30-day grace so a late purchase registers them with their actual registration time, never backdated. After grace they become `expired_unregistered`, visible per document.
- Purchase through a merchant of record such as Paddle or Lemon Squeezy. They handle VAT, which is the real operational burden for a small Swedish operator. The checkout URL carries the enrollment id, the webhook creates the entitlement, and the instance picks it up on its next status poll, every 6 hours and on settings open. The provider's purchase email carries the license key used for restore.
- Yearly: non-recurring 12-month pass by default, so nothing can surprise anyone, with in-app reminders at 30, 7 and 1 days and after expiry. Central has no email channel by design. Offer auto-renew only as explicit opt-in later.
- Lifetime: one-time, defined as the service's lifetime plus the published shutdown commitment.
- Anonymous trial abuse: a reinstall yields a new trial. Accept it. Receipts cost near nothing to serve, the abuser loses verification continuity, enrollment is rate-limited per IP per day, and demanding email or card contradicts the no-fuss requirement.
- Entitlement status is never shown publicly.

## 11. Operations and domain independence

A separate deployable `central/` package in this repository shares TypeScript, `canonical`, Express and pg patterns, and Docker/Coolify tooling. One PostgreSQL, one Ed25519 signing key in a 0700 volume handled like the sealing key store, daily encrypted backups, no admin UI. HSM or KMS is a documented upgrade, not an MVP requirement. The instance config is `SIGNHERE_CENTRAL_URL`, default `https://signhere.se`, empty disables the feature. Receipts carry `iss`, and the trust anchor is the JWKS rather than the hostname, so the service can move domains with overlapping keys.

## 12. Revising PR #12

Commit onto the draft branch rather than opening a parallel PR:

1. In `docs/central-service-plan.md`, add a "Phase 0: digest registry" section ahead of the capability table and reframe the three existing capabilities as later phases. Replace the "Email and confirmation state" row with a statement that Phase 0 stores digests, fingerprints, enrollment keys and entitlement records only.
2. Add tasks CEN-016 to CEN-021 with milestone "Digest registry MVP": protocol and receipt format; central service and schema; instance enrollment, outbox and package integration; central verify page and trust publication; billing, entitlement and restore; operations, backup and shutdown export. Put them first in the README sequence.
3. Mark CEN-003, CEN-004, CEN-009 and CEN-013 as deferred optional independent-approval scope that processes email addresses and consent context centrally and therefore needs its own privacy decision and user consent. Keep the files.
4. Make CEN-007 and CEN-008 depend on the MVP's enrollment and trust publication. Note that daily chain-head anchoring is not a per-document timestamp.
5. Add an "MVP subset" paragraph to CEN-001, 002, 006, 010, 011 and 012 covering what applies to a digest registry with file-based keys and no personal data.
6. Update the PR description.

## 13. Implementation PRs and acceptance checks

| PR | Scope | Acceptance |
| --- | --- | --- |
| 1 | `central/`: enrollments, JWKS, receipts register and lookup, trial entitlement, hash chain, Docker | PoP and JWS auth, replay rejection, cross-enrollment 409, unknown certificate 422, 402 after trial, chain integrity, strict schemas reject extra fields, no IP columns, canary strings in extra fields rejected and absent from logs |
| 2 | Instance: enrollment key store, `central_enrollment`, settings card, outbox and worker, evidence, package and verifier integration, local verify and signer receipt display | Real-PostgreSQL tests: enqueue inside the publish transaction, worker fencing and restart, 402 keeps items pending, grace expiry, v1 not enqueued, package contains receipt and JWKS, verifier reports registered, absent or invalid, missing key file gives action_required, browser smoke covers toggle and receipt, network capture shows only allowlisted calls |
| 3 | Central verify page and trust docs | Hash computed locally, only digest POSTed, fragment prefill, three separated facts in wording, CSP without third-party origins |
| 4 | Billing: checkout, webhook, entitlements, license-key claim, reminders | Webhook signature verification, idempotent orders, claim limits, expiry transitions, non-recurring default |
| 5, optional | Backfill of earlier completed documents, daily RFC 3161 anchoring of the chain head, static shutdown export | Backfilled receipts carry registration time with a UI note, anchoring failure is non-blocking, export verifies offline |

## 14. Unresolved product decisions

- Prices, with suggested anchors only of roughly 490 SEK per year and 1 990 SEK lifetime, and whether yearly auto-renews.
- Merchant of record and hosting region or provider.
- Origin: `signhere.se` directly or a dedicated trust subdomain as PR #12 prefers.
- Shutdown commitment length for lifetime buyers and the static export host.
- Whether to offer enrollment during first-owner setup. I recommend yes, unchecked by default, with the exact data disclosure.
- Whether backfill of pre-enrollment documents is offered by default.
- Trial receipt cap and enrollment rate limits.
- Swedish name and wording of the feature.
