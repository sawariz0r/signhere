# Claude Opus 5.5 implementation design critique

Actual CLI review on 2026-09-24; returned model usage identifies `claude-opus-5-5` (100993 ms). This reviewed the implementation boundary design before the source review. See [implementation dispositions](../sealing-implementation.md) for current scope and results.

# Signhere sealing: implementation critique

**Verdict:** the direction holds. Five things need fixing before parallel work starts:

- The plan contradicts the new legacy decision.
- Intents are not yet frozen before approval.
- The public checkpoint is an unblinded commitment.
- Key initialization needs a DB-first ordering.
- The CMS `Contents` area lets someone strip a timestamp unless the signed policy catches it.

## 0. Document inconsistency (required)

The plan (§2 and the B10 disposition) still says to stop the upgrade when v1 pending documents exist. Your decision now keeps a documented legacy branch. Update the plan and the dispositions table first. Otherwise the three implementers will build against different gates.

## 1. Non-circular evidence format

The cycle-breaking itself is sound: core → manifest in covered bytes → seal → hash → completion event. Remaining dangers:

- **Intents are not frozen before approval.** `/api/sign/complete` accepts `consentVersion` but no server-issued intent. Add a T0 that persists the exact intent bytes with a nonce and returns `intentId`. `complete` must require `intentId` and `intentDigest`, and reject a stale or foreign intent. Without T0, "exact intents" are reconstructed after the fact.
- **Don't nest intents as parsed JSON inside the core.** Reserializing the core rewrites them. The core should list `{recipientId, intentSha256, methodEvidenceSha256}`, and the bundle carries the exact byte files. Apply the same rule to provider evidence: the current `JSON.stringify` size check is not an exact-bytes bound.
- **The public checkpoint is an unblinded commitment.** It hashes a chain that includes IPs, emails and names. Either put it only inside the blinded core, or show that every chain event contains a server-random field. The core must also carry the v2 chain events up to the checkpoint, so the verifier can recompute the checkpoint rather than trust an opaque value.
- **The manifest needs domain separation:** schema, installation ID, document/revision ID, `evidenceDigest`, `preparedHash`, frozen policy, and the expected sealer SPKI fingerprint.
- **Build the appendix only from the parsed frozen core,** never from live `recipients` rows. Test this by mutating a recipient row after T1: the output must not change, or publish must refuse.

## 2. App→Python IPC and filesystem safety

Smallest safe interface: two separate helper entry points.

- `seal`: has key access, performs no network access.
- `validate`: has no key.

Both use one-shot, versioned JSON with a byte-length header over stdin/stdout:

```
seal-req  {v, jobId, generation, inputSha256, inputLen, keyRef, expectedSpkiSha256, fieldName, reason, manifestSha256}
seal-resp {v, ok, outputSha256, outputLen, signerSpkiSha256, errorCode∈closed set}
```

Requirements:

- Spawn with a fixed absolute interpreter, no shell, a minimal env and Python `-I`.
- Pin dependencies with hash-locked requirements.
- Pass the key password over stdin or a file descriptor, never argv or env. The key file must be a read-only mount.
- Node enforces a wall-clock timeout, kills the whole process group, and caps stdout and stderr.
- Log only `errorCode`; stderr may contain paths or document text.
- If temp files are needed:
  - use a per-job `mkdtemp` directory with mode 0700 under a non-shared root;
  - create files with exclusive create and no-follow flags where the OS supports them;
  - delete the directory in `finally`, and sweep orphans at startup.
- **Test these semantics on Linux CI.** Windows development does not exercise them.
- Node recomputes `outputSha256` and checks the exact prepared prefix, if the spike adopts incremental assembly. It checks that `signerSpkiSha256` equals the key version persisted for the attempt, then runs `validate` on the exact bytes it will publish.
- Sealing and validating with the same library is a sanity check, not independence. Keep a second validator (e.g. pdfsig) in CI.
- Don't assume the helper can build a placeholder in an unprivileged parser. The engine spike decides that. Until then, record that the key holder parses the candidate PDF.

## 3. Legacy pending branch

Required constraints to keep this from becoming a second finalizer:

- Add `documents.schema_version` with DB CHECKs:
  - v1 allows only `pending→completed|cancelled`;
  - v2 allows only `pending→finalizing→completed` and `pending→cancelled`;
  - new inserts must be v2.
- Legacy completion uses the **unchanged** v1 in-transaction finalizer, including its rollback behavior. It is never sealed, never enqueued, never given a v2 manifest, and never presented as sealed.
- Dispatch on `schema_version` at the all-signed branch. Unknown versions fail closed.
- Test: a v1 pending document signed after the upgrade produces output that the v1 verifier accepts. Its events use v1 canonicalization byte-for-byte.
- Deferable: removing the legacy branch through a migration once `count(v1 pending)=0`.

## 4. Key/DB crash-consistent initialization

Order matters. Write the **DB row first**, so a key without a row can only come from an external cause.

1. Take `pg_advisory_lock` (session-level) and re-read state.
2. Insert `instance_identity(state='provisioning', installation_id, provisioning_nonce)` and commit.
3. Generate the key and write a temp file with mode 0600. Fsync it, rename it, fsync the directory, then write a sidecar containing `installation_id` and the nonce.
4. Update the row to `active` with the SPKI and certificate fingerprints, then commit.

Reconciliation:

| DB state | Key volume | Action |
|---|---|---|
| none | empty | fresh: provision |
| provisioning | empty or partial | discard, regenerate |
| provisioning | matching sidecar | finish binding |
| none | key present | **disable sealing**, require explicit command |
| active | missing or mismatched | disable sealing; reads stay up |

Define "fresh" as: no identity row, no seal-key rows, no v2 artifacts. Legacy v1 documents do not make an upgraded install non-fresh.

Never auto-generate when an external key or secret path is configured. Bind identity to the SPKI hash and keep certificates historical, so certificate renewal is distinguishable from key replacement. Don't store the P12 password next to the P12. Either use a plain 0600 PEM, or take the password from a secret.

## 5. Policy and timestamp stripping

`Contents` is outside the ByteRange. An attacker can therefore delete an unsigned timestamp attribute and re-pad, leaving the signature valid. The **signed manifest's `timestamp: required`** is the actual defense.

- The verifier must fail when the policy says required and no valid token is present.
- The profile checker must require `Contents` to be exactly one DER CMS followed only by zero padding.

Required tests (the timestamp-token tests move to D with the TSA work):

- a stripped token fails;
- trailing garbage in `Contents` fails;
- a token over the wrong imprint fails;
- a manifest claiming `off` cannot be produced without the key.

With the default `off`, verification reports "no trusted time". The CMS `signingTime` is self-asserted, so certificate validity at signing time is also only claimed.

## 6. Verification and trust

- Emit structured results per axis (integrity, profile, evidence, issuer trust, time, participant assurance), plus exit codes that separate "intact, untrusted" from failure.
- Trust inputs are `--trust-spki`/`--trust-root` only.
- Evidence steps, in order:
  1. raw digest of the core bytes equals `evidenceDigest`;
  2. strict parse;
  3. each intent file's hash equals its core entry;
  4. each intent binds `preparedHash`;
  5. the prepared PDF hashes to `preparedHash`;
  6. the recomputed chain equals the checkpoint.
- When the core is absent, report "PDF-only" as a distinct, non-complete result.

## 7. Exact commit boundaries

- **T0:** issue the intent.
- **T1:** the final signer's transaction, under the document lock.
  - Validate the method and intent, then write the signature and the `recipient.signed` event.
  - Once all have signed, build the core bytes from committed rows plus a fresh nonce, store them as bytea with their digest, set the checkpoint, set `status='finalizing'`, and insert the job with `UNIQUE(document_id, revision)`.
  - Commit.
- **Claim:** a single `UPDATE … WHERE id=(SELECT … FOR UPDATE SKIP LOCKED) RETURNING generation`, which also persists the selected key version and bumps the generation. Commit.
- **Work:** hold no DB connection while working, to avoid pool starvation.
- **Publish:**
  - `SELECT … FOR UPDATE` on the document, recheck `finalizing`, the checkpoint, the evidence digest and the generation;
  - insert the artifact (`UNIQUE(document_id)`), set `completed`, append `document.completed` with `completedHash`, the manifest digest and the SPKI hash;
  - close the job and commit.
- **Failure writes** also require a generation match.
- Compare leases against the DB's `now()`. Expiry only enables a reclaim, and reclaiming bumps the generation.

Route gaps in the current code:

- The idempotent `signed_at` path must return an "accepted, finalizing" DTO.
- The Swedish "PDF-filen kunde inte färdigställas… Ingen underskrift sparades" message must stay v1-only.
- `/api/sign/download` must return a distinct `finalizing` code.
- `bearer(…, true)` must not append signing-chain events when the status is not pending.

## Required vs deferable

**Required before the three streams start:**
- the manifest/core schema with test vectors;
- the helper protocol above;
- the state CHECKs and the `schema_version` dispatch;
- the identity reconciliation table.

**Required for C:**
- the stripping/padding profile checks;
- structured CLI results.

**Deferable:**
- legacy branch removal;
- TSA embedding and placeholder sizing (D);
- orphan temp-dir metrics;
- browser verification.

## Focused tests

- Crash after each of T1, claim, seal and publish.
- Two workers where a stale generation publishes.
- Concurrent final signers.
- A mutated recipient row after T1.
- `kill -9` between each initialization step.
- A restored DB with a foreign key.
- A helper that hangs or floods stdout.
- A symlinked temp path, on Linux.
- A stripped timestamp with a `required` manifest.
- A detached core with one byte changed.
- A legacy v1 pending document completed after the upgrade.