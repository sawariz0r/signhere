# Claude Opus 5.5 implementation critique

This is the source review returned by Claude CLI on 2026-09-24. The returned model usage identifies `claude-opus-5-5` (453412 ms). It reviewed a curated implementation snapshot without credentials, local databases, private keys, contract contents or design assets. The reviewer did not execute code. Some findings describe code subsequently changed; see [implementation dispositions](../sealing-implementation.md).

# Signhere sealing implementation: source review

I found no break in the DB fencing, the trigger state machine or the seccomp program. The material problems are:

- Documents can strand permanently after every signature is accepted.
- Output from the sandboxed parser stages is trusted by the key process and by Node.
- A change to the consent text breaks v2 verification.
- Evidence disclosure and stored verdict semantics are wrong.

Everything below comes from reading source. Nothing was executed.

---

## A. Actual code bugs

### A1. High: accepted signatures can strand permanently in `finalizing`

**Where:** POST `/api/documents` in `app.ts`, `prepare`/`verify` in `engine.py`, and `guard_document` (which only allows `finalizing` → `completed`).

**Failure:**
- pyHanko (`strict=True`) first sees the document only after the last signer has signed.
- `prepare` rejects any input that:
  - has a signature field (signed or unsigned),
  - is encrypted, including owner-password-only files,
  - or trips a strict-parse quirk such as hybrid xref or bad offsets.
- `verify` then requires exactly one field.
- When `preparation` is null the uploaded bytes are not flattened, so their quirks can survive `finalizePdf` into pyHanko.

The result is a deterministic `artifact_build_failed` ×5, then `action_required`. Retry repeats the same failure forever, and the trigger forbids cancelling a `finalizing` document. A sender can trigger this on purpose with a crafted PDF. A strict-mode reject is enough; no parser exploit is needed.

**Fix:** Before inviting recipients, run a sandboxed dry run at creation:
1. `finalizePdf(bytes, …, sealExpected=true)` with placeholder signers.
2. `prepare` with the public certificate only. It needs no key.

Reject the upload if either step fails. Back this with a corpus test covering an unsigned AcroForm sig field, owner-password encryption, hybrid xref and broken xref.

### A2. High: transient key-store errors become terminal `action_required`

**Where:** `refresh()` and `signingIdentity()` in `key-store.ts`; `errorCode`/`failFinalization` in `finalization.ts`.

**Failure:**
- `refresh()` catches every error and maps it to `reason='key_unavailable'`. That includes a Python spawn failure, the 45 s timeout under load, EMFILE, or a keys volume that is late to mount.
- `signingIdentity()` then throws `FinalizationActionRequiredError`.
- So the first attempt goes straight to `action_required`, with no backoff. Every job queued during a short outage now needs a human click, which breaks the "no extra approval steps" requirement.

**Fix:**
- Keep these codes as action-required: `key_mismatch`, `signing_identity_changed`, `unsafe_key_*`, `key_expired_or_not_yet_valid`, `identity_recovery_required`.
- For `key_unavailable` and unknown errors, throw a plain `Error` so normal retry and backoff apply.
- Optionally, auto-requeue `action_required` jobs with a key-related `last_error_code` once `refresh()` is ready and the pinned fingerprint matches.

### A3. Medium: rotation or renewal strands every job that has already pinned an identity

**Where:** `pinIdentity`, `retryFinalization`, the `/retry-finalization` route, `rotate()`.

**Failure:**
- After the first attempt pins `{installationId, fingerprint, keyId}`, any rotation makes every later attempt throw `signing_identity_changed`.
- BYO certificate renewal counts as rotation, because it changes the SHA-256 fingerprint even when the key is the same.
- The only reset path is `retryFinalization(..., {resetSigningIdentity:true})`, and no route calls it. `rotate()` has no route either.
- Those documents are therefore unrecoverable from the product.

**Fix:**
- Add an owner-only "retry with current seal identity" action. It should pass `resetSigningIdentity:true` only when a `sealing_key_events` row links the old and new fingerprints.
- Record that reset in `finalization_attempts`.
- Expose `rotate` through a CLI or route.

### A4. Medium: consent drift breaks v2 verification

**Where:**
- `signingIntent` in `evidence.ts` freezes `CONSENT` at creation.
- `/api/sign/complete` records the *current* `CONSENT`.
- `verifyV2Consistency` checks `canonical(intent.consent) === canonical(signed.data.consent)`.

**Failure:** Any release that changes the consent text or version causes two problems for documents created before it and signed after it:
- Portable verification fails with "Intent consent/method/nonce mismatch".
- The signer sees and accepts text that differs from what the frozen intent commits to.

Method drift is already rejected (`method.version !== recipient.method_version`); consent drift is not.

**Fix:** In `session` and `complete`, parse `recipient.signing_intent` and use `intent.consent` throughout:
- Return it to the UI.
- Require `input.consentVersion === intent.consent.version`, replacing the `z.literal(CONSENT.version)` check.
- Store `evidence.consent = intent.consent`.

Rejecting with a 409 on drift would strand pending documents instead, which is worse.

### A5. Medium: parser-stage outputs are trusted by the key process and by Node

**Where:** `signPdf` in `seal.ts`, `cms_sign` in `engine.py`.

Your isolation model assumes a malicious PDF can compromise the sandboxed `prepare`/`verify` (and `finalize`) processes. On that premise:

- **Signing oracle.** `prepare` alone chooses `digest`, `start` and `end` and writes `prepared.pdf`. `cms` signs any file whose placeholder and digest match those values.
  - The key stays confidential, but the parser can append an incremental update that replaces page objects after the candidate prefix.
  - The result passes `verify` and the portable verifier. That verifier checks `preparedHash` against `original.pdf`, never that the visible content derives from it (`skip_diff=True`).
- **Artifact swap.** `prepare`, `cms` and `verify` share one job directory with MAKE_REG/REMOVE_FILE/MAKE_SYM rights.
  - The sandboxed `verify` can replace `signed.pdf` with any file that starts with the candidate, then report a matching `pdfHash`.
  - Node's check (prefix plus hash equal to `metadata.pdfHash`) compares its read against the sandbox's own claim. So an unsealed file can be published as completed together with forged `seal_metadata`.
- **Unchecked metadata.** Node stores `metadata` (manifest, fingerprint, verdicts) from `verify` without comparing it to what it requested.

**Fix (minimal):**
1. After `prepare`:
   - Node opens `prepared.pdf` with `O_NOFOLLOW`.
   - It checks `prefix === candidate` and a tail of at most roughly 96 KiB.
   - It copies the bytes into a fresh 0700 directory the sandbox never had.
   - `cms` reads only that copy, re-checks the prefix against a Node-supplied `candidateSha256` and `candidateLength`, and returns `sha256(output)`.
2. Run `verify` on a copy in a separate fresh directory. Publish Node's own read of `cms`'s output, and require its hash to equal the value `cms` returned.
3. Assert `canonical(metadata.manifest) === canonical(manifest)` and `metadata.certificateFingerprint === expectedFingerprint`.

This bounds the oracle to a small tail but does not remove it. Document that residual: key isolation protects confidentiality, not signing integrity. Don't describe the CMS process as independent of parser integrity.

### A6. Medium: size budgets don't compose, and oversize fails only after acceptance

**Where:** The limits that interact are:

| Limit | Value |
|---|---|
| `signingJson` per signature | 1 MB, up to 25 recipients |
| `pdf-worker.ts` stdin | 40 MB |
| `MAX_PDF` in `engine.py` | 32 MB |
| Evidence core | 32 MB |
| Per-file limit in `verify-sealed-evidence.mjs` | 64 MB |
| `/tmp` tmpfs | 64 MB |

**Failure:** Strokes are carried in the `recipient.signed` events and again in the `finalize` IPC, next to a base64 original of about 13.3 MB. Unless the draw plugin caps strokes far below 1 MB:

- `freezeEvidenceCore` can throw inside the last signer's transaction. The signer gets a 500, can never complete, and the document stays pending forever.
- Or `finalize` exceeds the 40 MB stdin limit, which ends in permanent `action_required`.
- The evidence JSON carries strokes twice (in `events` and in `evidenceCoreBase64`), so an export can exceed the verifier's 64 MB limit.

**Fix:**
- Cap each signature's canonical stroke bytes in the method, for example at 64 KiB.
- Before accepting any signature, compute the projected worst case (existing events plus remaining recipients × cap). Check it against the smallest downstream limit.

### A7. Medium: every signer receives every participant's email, IP and User-Agent

**Where:** `/api/sign/verification-package` and `/api/copy/download` both call `packageResponse` → `evidenceExport`. That uses the non-public `documentDto` and includes the full `evidence_core`, which contains all events with `requestEvidence` and `actorId`.

**Failure:**
- The signing UI deliberately hides emails (`publicView`).
- But a recipient bearer token is valid for 30 days after signing and can be forwarded.
- Anyone holding it can download a ZIP with all emails, IPs and UAs, plus the sender's user ID.
- Copy-link tokens have no revocation route.

**Fix:** This needs an explicit product decision. Minimal options:
- Serve signers the sealed PDF plus the redacted public evidence, and keep the full package owner-only.
- Or, in the next core schema, commit to request metadata as `sha256(nonce‖ip‖ua)` and keep the plaintext only in the team export.

Either way, add copy-link revocation.

### A8. Low-Medium: stored and exported verdicts overstate trust

**Where:** `publishFinalization` stores `seal_metadata = result.metadata` and also embeds it in the hash-chained `document.completed` event. `evidenceExport` exports it as `seal`.

**Failure:**
- That metadata came from verifying against the installation's *own* fingerprint.
- So `evidence.json` and the immutable chain permanently state `issuerTrust:'pinned'`, `integrity:'valid'` and `certificateValidity:'current'`.
- A relying party reads "pinned" even though nothing was independently pinned, and "current" stays true after expiry.

`/.well-known/signhere-sealing.json` is served by the same host, so it is not the "independently trusted channel" the README asks for.

**Fix:**
- Persist facts only: `{profile, certificateFingerprint, certificatePem, manifest, pdfHash}`.
- Compute verdicts only at verification time.
- Say explicitly in the README and UI that the well-known endpoint is not a trust anchor.

### A9. Low

- **Missing owner check.** The `retry-finalization` route lacks `owner(res)`, although `retryFinalization`'s own contract says the caller must authorize the owner.
- **Wasted retries.** `buildArtifact` throws a plain `Error` for an unsupported policy or a frozen-binding mismatch. That spends 5 backoff retries on a deterministic failure. Throw `FinalizationActionRequiredError` with a specific code instead.
- **Ineffective `PR_SET_DUMPABLE`.** In `launcher.c`, `PR_SET_DUMPABLE(0)` before `execv` is reset by exec of a non-setuid image, so the comment's claim is false. It is harmless because seccomp blocks ptrace/process_vm and Landlock hides `/proc`. Remove the claim.
- **Public reason codes.** `/api/health` and `/.well-known` publicly expose `reason` (`unsafe_key_permissions`, `key_mismatch`, …) and `notAfter`. Keep reasons on an authenticated or internal endpoint.
- **Verifier CLI usability.**
  - `--trust-fingerprint` rejects the uppercase, colon-separated form that `openssl x509 -fingerprint -sha256` prints; normalize it.
  - The `verify-evidence.mjs` CLI routes v2 to the sealed verifier but cannot pass a fingerprint, so it always exits 3.
- **Intent binding is server-side only.** The signer echoes `sha256(intent)` without ever seeing the bytes, and the hash is not in `submissionHash` or the method payload. It proves the server issued the intent before the signature, not that the signer committed to it. Add it to `submissionHash`, and describe it as freshness binding rather than signer intent.

---

## B. Not code bugs: unexecuted tests and release gates

1. **Linux launcher never run.**
   - It needs kernel ≥ 6.2 (Landlock ABI 3), plus a Docker/Coolify seccomp profile that allows the `landlock_*` syscalls.
   - If those syscalls are denied, the ABI probe fails closed with the misleading "ABI 3 required" message.
   - Run `test-pdf-sandbox.mjs` in its full mode (real `/keys` and `/data` probes) in CI, on the actual image and the target host's kernel.
   - The `--startup` mode only probes sibling `/tmp` directories.
2. **Memory and tmpfs budget.**
   - The 768 MiB container holds the app, up to 2 Node workers (192 MiB heap plus WASM each), a Python process (768 MiB address-space cap) and tmpfs job files. Tmpfs pages are charged to the same cgroup.
   - `input.pdf`, `prepared.pdf` and `signed.pdf` coexist in `/tmp`, roughly 3× the candidate.
   - Load-test an upload and a finalization running at the same time at maximum sizes. An OOM kill takes down the whole service.
3. **DB role separation.** `10-signhere-roles.sh` wasn't provided. Verify the runtime role owns no tables; an owner can `DISABLE TRIGGER` or `DROP TRIGGER`, which bypasses every immutability guard. Also verify it lacks TRUNCATE and TRIGGER privileges.
4. **v2 export/verify E2E (in progress).** Add fixtures for:
   - a CONSENT change (A4),
   - rotation with a pinned job (A3),
   - key-store failure during finalization (A2),
   - an oversized stroke set (A6),
   - the corpus-rejected PDFs from A1,
   - a legacy v1 pending document completing on the new code.
5. **Second-reader and pyHanko validation.** Gate the release on the same corpus as A1, and on proof that pinned versions reproduce the verify results.
6. **Restore drills.**
   - When the DB and keys volume are out of step, the code fails closed (`key_unavailable`, `unregistered_key_files`, `identity_marker_missing`, `provisional_key_mismatch`).
   - Operational recovery of in-flight documents depends on A3, so drill DB-ahead and keys-ahead restores with jobs in `finalizing`.
7. **Legacy flag.** Confirm `index.ts` gives no environment path to `legacyCreation=true` in production.

**Checked, no issue found:**
- Lease/generation fencing in `publishFinalization`.
- Lock ordering (documents → jobs → attempts): no cycle with claim, heartbeat or fail.
- `guard_event_insert`/`guard_document` transitions: cancel from `finalizing` is blocked, and completion requires a running job.
- Seccomp jump offsets for `clone`, `socketpair` and the x32 guard.
- Landlock REFER/hardlink denial.
- `cms_sign` bounds and placeholder checks.
- CMS trailing-data and ByteRange-gap equality checks.
- The strict canonical re-encoding check on the evidence core and intents.