# Claude Opus 5.5 follow-up on fixes

Actual tools-disabled CLI source review on 2026-09-24. Returned metadata identifies `claude-opus-5-5`, 157162 ms. No tests were executed by the reviewer. See [dispositions](../sealing-implementation.md); findings 3, 5 and 6 below were checked against the full code and were not defects as stated.

# Signhere sealing follow-up review

The boundary code (`boundaries.ts`, the byte checks in `cms_sign`, and the pinned verdict check) looks sound. The fixes do introduce two high-impact integration bugs in `app.ts`, and there is one possible blocker in the Python excerpt. This is a static reading only; nothing was executed.

## High impact

**1. The global single-slot `withExport` blocks signing across all tenants, and any bearer can hold it.**
`exporting` is one process-wide boolean. It now covers these routes:
- `/api/sign/pdf`, which the signer needs in order to read the document before consenting.
- `/api/sign/download` and `/api/copy/download`.
- Team PDF, evidence and ZIP exports.

The slot is held until `finish`/`close`. For a large body, that means until the socket drains. Every other request gets an immediate 429. The consequences:
- **Functional regression.** If 25 recipients open an invitation at about the same time, most of them get "En export pågår" instead of the document. One owner building a verification ZIP blocks every signer on the instance.
- **Abuse.** Anyone holding any valid signing or copy token can loop `/api/sign/pdf` with a slow-reading client. They hold the slot for up to 60 s per request and re-acquire it under the 40/min limit, which blocks viewing, downloads and exports globally.
- **The 60 s absolute deadline truncates legitimate downloads.** A 32 MiB sealed PDF needs a sustained rate of about 4.5 Mbit/s to finish in time. Slow mobile signers will always get a destroyed response.

Suggested fix:
- Use a bounded semaphore (N > 1) with separate budgets for bearer and team/export traffic, plus a per-token or per-user cap.
- Queue briefly instead of failing fast.
- Replace the absolute deadline with an idle/progress timeout, or one that scales with size.
- At minimum, take `/api/sign/pdf` out of the global slot.

**2. Preflight turns every infrastructure failure into a user-facing "re-export your PDF" 400, and readiness does not cover this path.**
`POST /api/documents` wraps `finalizePdf` and `preflightSealPdf` in a bare `catch`. The following all become `400 PDF-filen kunde inte förberedas…`:
- A missing or misconfigured `SIGNHERE_PDF_SANDBOX_LAUNCHER` when `SIGNHERE_REQUIRE_PDF_SANDBOX=true`.
- A missing seal Python runtime.
- A 45 s timeout under load.
- A `taskkill` or launcher failure.
- A programming bug.

`/api/ready` only checks the key-health path (`inspect`, which is not a parser op and never uses the launcher). A deployment can therefore report ready (200) while rejecting every document creation and telling users their PDF is bad.

There is also a small race: `keys.status()` is read after `refresh()` and after a potentially long `prepareUpload`. A concurrent failed refresh can null `fingerprintSha256`/`certificatePem`, and the `!` assertions pass `null` into the preflight manifest. That also surfaces as the same misleading 400.

Suggested fix:
- Classify errors: parser rejection from `prepare` becomes 400; runtime, launcher and timeout errors become 503 and are logged with a code.
- Snapshot the identity once, right after `refresh()`.
- Make readiness exercise the parser/sandbox launch path, for example a cached trivial `prepare` or a launcher probe.

**3. Check this against the real file: `cms_sign` uses `await` inside a plain `def`.**
If the excerpt is literal, `engine.py` fails to compile. Every operation would then fail, including the preflight, and finding 2 would hide that as a 400 on every upload. If the real function is `async def` with an `asyncio.run` dispatcher, ignore this. Any test that runs the real engine end to end would show which case applies.

## Medium / lower

**4. The preflight candidate differs from the real one in deployment-dependent ways.**
- **Certificate chain.** Preflight passes only the leaf (`identity.chainPem ?? identity.certificatePem`, and `status()` carries no chain). The real `signPdf` passes `identity.chainPem`. For an imported P12 with intermediates, anything `prepare` derives from `certificateFile` differs deterministically between the two. That reintroduces A1 (late PDF rejection after all signatures are collected) for exactly those deployments. Expose `chainPem` from the key store and preflight with it.
- **Appendix sizing.** Preflight uses one 2-point stroke per signer, no `signedName`, and short placeholder IDs. The real run can have 25 signers × 64 KiB of strokes and 160-char names. The docstring scopes this honestly as a residual. If the appendix renders strokes as vector paths, preflight with maximum-size strokes and names rather than minimal ones, so the size and time budgets are what gets exercised.

**5. `rotate()` does not pre-create the new key directory as `0700`, unlike `initialize()`.**
`createLocalIdentity(join(keysDir, next.key_id))` runs first, and `keyDirectory(next)` then enforces `mode & 0o077 == 0`. If `engine.py create` uses `os.makedirs` without `mode=0o700` under the default umask, rotation on Linux will:
- create a key,
- fail with `unsafe_key_permissions`,
- leave an orphaned key directory.

The old identity is kept, so this is not unsafe, but rotation would fail on every attempt. Add `mkdir(..., { mode: 0o700 })` before `createLocalIdentity`.

**6. A permanently missing key is classified as retryable.**
`lstat` ENOENT in `privatePath` becomes `key_unavailable`, which `readyIdentity` treats as retryable. A key that is actually lost therefore retries indefinitely instead of surfacing as action required. Consider mapping ENOENT on the registered key path, when a provisioning receipt exists, to an action-required code.

## Consistent with the stated dispositions (static reading)

- `captureRegularFile`: descriptor capture with an `nlink`/`ino`/size/mtime/ctime check and a one-byte over-read. The CMS stage only ever gets Node-written bytes, never a sandbox path.
- `checkPreparedCandidate` and `cms_sign` independently enforce prefix equality, the tail budget, placeholder shape and range, and recompute the digest.
- The CMS output check (`result` hash/length and candidate prefix) and `checkSealVerdict` (pinned fingerprint, certificate bytes against fingerprint, deep manifest equality, no validity verdict stored).
- The `identityGeneration` loop in `refresh()` handles rotation racing an in-flight inspection. `signingIdentity`/`keyFor` always refresh; health endpoints use the 30 s cache.
- Frozen consent flows through `consentFor`, the submission hash and `buildArtifact` (`event.data.consent`). The idempotent resubmission check runs before the `status !== 'pending'` check, so receipts work after completion.
- The residual is documented, not fixed: `checkPreparedCandidate` does not tie the in-PDF `/ByteRange` to `[0,start,end,len]`, and the key signs a candidate prefix plus up to 96 KiB of attacker-controlled tail. That matches your stated boundary.

## Code-level fixes vs deployment gates

| Item | Status |
|---|---|
| Findings 1, 2, 5 | Code bugs, fixable and unit-testable now |
| Finding 3 | Needs one real-engine test run to confirm or dismiss |
| Finding 4 (chain) | Code fix; the appendix-size part is an accepted residual |
| Sandbox launcher isolation, Linux/Docker execution, resource concurrency, independent PDF reader / full profile validation, timestamping (Milestone D), token revocation/exchange | Still release gates; nothing in this diff closes them |

I have not run any tests. The "consistent" items above come from reading the source, not from executing it.