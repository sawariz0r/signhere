# Claude Opus 5.5 critique: PDF sealing plan

Date: 2026-09-24. Claude Code CLI 2.1.281 completed successfully and reported model `claude-opus-5-5` in `modelUsage` (duration: 162047 ms).

The user requested this consultation and previously authorized source review. The supplied input was the earlier sealing-plan draft and curated excerpts from `server/plugins.ts`, `server/pdf.ts`, `scripts/verify-evidence.mjs`, the signing-completion route in `server/app.ts`, and schema/guard portions of `server/db.ts`. Credentials, document/database contents and design assets were excluded. The invocation used print mode, high effort, safe mode, disabled tools, strict MCP configuration and no session persistence. Claude did not browse, run tests or audit the full repository.

Input SHA-256: `d09da3f62eb8e146910344ac054639b0ac9ed64035f406b9933df63d2cfacee5`. Raw invocation files remain in ignored local test artifacts.

**Disposition:** [The revised plan](../sealing-plan.md#review-dispositions) records which recommendations were accepted, qualified or deferred. The response below is preserved as received; it is not a statement that every suggestion or factual assertion is correct. In particular, current finalization appends pages and reserializes rather than rasterizing every source page; original-byte preservation does not prove display equivalence, required timestamp policy cannot be silently downgraded, a small ByteRange patcher is not a full validator, and HTTPS certificate discovery is not an independent historical trust anchor. The revised plan has not received a second Claude review. This consultation is not an independent security audit or legal certification.

---

# Signhere sealing plan: architecture review

This is an architectural review of the supplied plan and source excerpts only. It is not a production audit, and it verifies no library capability. Statements about dependencies are hypotheses for the spike.

## 1. Verdict

**Approve the direction, and revise before implementation.**

The trust model is unusually well separated. It keeps four results apart: byte integrity, issuer trust, time evidence and participant assurance. It rejects a single green badge. It also avoids promising resistance to a malicious operator. The ordering is right: durable finalization comes before remote services, and self-signed sealing comes before TSA and BankID.

The plan has three problems:
- **Unresolved PDF-level decisions.** Several choices it treats as details decide whether the seal is actually verifiable.
- **Overengineered pieces.** Candidate persistence, browser verification and a full modification-detection verifier are too much for this release.
- **Tension with "dead easy" Docker.** Explicit key provisioning conflicts with the top priority.

A smaller, sharper milestone C is achievable.

## 2. Blocking flaws and underspecified decisions (priority order)

**B1. The final PDF does not provably contain the prepared PDF.**

Today `finalizePdf` re-renders the document. The evidence core can commit to `preparedHash`, but no verifier can check that the pages in the sealed file equal the prepared bytes. The operator's renderer is simply trusted.

Fix: spike producing the final document as **incremental updates on top of the exact prepared bytes**. Appendix pages and drawn-signature overlays go in one revision, and the seal in the next. The verifier then checks `sha256(final[0:len(prepared)]) == preparedHash`. That turns "source preserved" from a visual test into a cryptographic one. Whether MuPDF's incremental save or the chosen library can append pages cleanly is a spike question, not an assertion. If it cannot, state the limitation explicitly in verifier output.

**B2. The rule for modifications after the seal is too ambitious.**

"Reject unexpected incremental modifications" in general requires difference analysis. pyHanko has this. A Node verifier would need a large new component.

For documents Signhere produces, use a strict and simple rule. Exactly one signature is expected. Its `/ByteRange` must start at 0, cover the whole file except the `/Contents` hex string, and end at EOF. There must be no other signature dictionaries, and anything else is rejected.

B-T can keep this rule because the signature timestamp is an unsigned CMS attribute inside `/Contents`, not a new revision. Defer difference policies until LTA or document timestamps exist.

Size the `/Contents` placeholder for the worst case: certificate chain plus TSA token. Treat overflow as a hard failure, never a silent truncation.

**B3. The key-holding process parses hostile-derived PDFs.**

The plan separates parsing workers from secrets. However, the signer usually parses the PDF to find or insert the placeholder, and the prepared PDF derives from hostile input. `worker_threads` share the process, so they are not a boundary.

Recommended split:
- The unprivileged worker builds the PDF with a fixed-size placeholder.
- The key holder only validates the ByteRange geometry, hashes those ranges, builds CMS, and splices hex at a known offset.

That gives the key process a parser of a few dozen lines. Accept that the seal key lives in the main app process for v1, and document that app RCE means key theft. A separate signer container is not justified yet.

**B4. Key provisioning conflicts with "dead easy".**

"Explicit instance provisioning" adds a step. Decide the behavior per state:
- **Key volume empty and database has no identity marker:** generate the key on first boot, then write the public fingerprint and marker to the database.
- **Marker present, key missing:** the app still runs and accepts signatures. Finalization jobs move to action-needed, and a one-command `rotate --lost-key` records the rotation.
- **Key present but fingerprint mismatches the database:** refuse to seal.

Losing a self-signed key costs little, because old PDFs verify from the retained public certificates. The real risk is theft, not loss. Use two named volumes (`pgdata`, `keys`) in Compose.

**B5. Policy is coupled to evidence.**

The plan freezes protection policy at creation and freezes an evidence core at the last signature. Keep policy **out** of the participant evidence core. Signers never saw the policy.

Record the policy, the actual key and certificate, and TSA results in seal metadata and the completion event. The "explicit recovery" for a missing TSA or key can then be an audited operator override without touching the frozen core.

Without this separation, recovery either mutates the core or strands documents in `finalizing` forever.

**B6. The state machine is underspecified.**

Define it as follows:
- **Document states:** `pending → finalizing → completed`, plus `pending → cancelled`. Retry, failure and action-needed live only in the jobs table; they are not document states.
- **No audit events in `finalizing`.** Block `recipient.viewed` and `link.rotated`. `document.completed` keeps `previous = checkpoint` (the last `recipient.signed`), so the current trigger invariant still holds.
- **Document trigger.** `guard_document` must allow only `finalizing → completed` with the completed columns set.
- **Job claim.** Claim with `FOR UPDATE SKIP LOCKED`, set `lease_until`, and increment `generation`.
- **Publish.** Use `UPDATE … WHERE generation=$n AND status='finalizing'` and check the row count.
- **Concurrency.** A single worker is fine.

**B7. Retain exact bytes rather than relying on canonicalization.**

The plan says it will retain exact bytes; make that the only verification path:
- Store evidence as `bytea`, not `jsonb`. `jsonb` reorders keys and drops duplicates.
- Verifiers hash the bytes first, then parse strictly and reject duplicate keys.
- Use RFC 8785 only on the producer side.
- Quantize stroke coordinates to integers (for example 0–10000) in v2. Cross-language float serialization is the classic JCS interoperability trap.
- Normalize or refuse non-NFC names deliberately.

**B8. Privacy commitments must be salted.**

If restricted metadata such as IP address and user agent is replaced by digests in the PDF-embedded core, those digests need per-field random salts carried in the restricted bundle. Unsalted IPv4 hashes can be brute-forced. Decide now what is embedded in the PDF (recommended: public core plus salted commitments) and what is detached.

**B9. Seal semantics visible in readers.**

Set these deliberately:
- **Certificate subject:** make it obviously a platform seal, for example `Signhere seal – <instance-id>`, never a person.
- **Reason and appearance:** `/Reason` must not say "approved", and the seal should be invisible (no widget).
- **DocMDP:** decide whether the seal is a certification signature. Spike its effect on future DSS or document-timestamp additions; I am not certain how readers treat those under P=1.
- **User expectations:** set them in the UX. Acrobat will show self-signed seals as "validity unknown", which users read as a warning.

**B10. Legacy pending documents.**

The plan's options (legacy completion path, or cancel and recreate) mean two finalizers. If no external installations exist yet, which the production release gates suggest, make migration refuse while v1 documents are pending. That removes a whole compatibility branch. Please confirm the deployment situation.

## 3. Scope and order

**Milestone A (narrow).**
- SigningIntent and evidence v2 with bytes-first test vectors.
- Library spike covering four questions:
  1. PAdES `ETSI.CAdES.detached` with signing-certificate-v2.
  2. The incremental-append feasibility from B1.
  3. RSA-3072 vs P-256 reader compatibility.
  4. Licenses (MIT, BSD and Apache-2.0 are AGPLv3-compatible).
- **Move Docker CI here.** "Dead easy Docker" is the top priority, and key-volume behavior only exists in containers. Do not defer it to D because this machine lacks Docker.

**Milestone B.** As planned, with the simplifications from B5, B6 and the rejected items below.

**Milestone C.**
- Auto-provisioned local key.
- Invisible B-B seal.
- Strict whole-file ByteRange verifier in Node.
- Public certificate and fingerprint at a well-known URL. The fingerprint then inherits the domain's HTTPS trust, which is the practical pinning channel for most users.
- Portable package and CLI.

Also in C: PKCS#12 import, if the spike shows chain embedding works. It uses the same code path and is what users wanting an Acrobat green check need. Otherwise put it in D.

**Milestone D.** Required-mode TSA producing B-T, rotation and expiry drills, resource isolation.

**Later.**
- Browser-side CMS verification. For now, `/verify` offers hash lookup plus the downloadable CLI.
- HSM and remote signer interface.
- LT/LTA and revocation.
- Participant completed-copy portal.
- BankID.

**Parallel production gate, not a C blocker.** Hostile-PDF memory isolation. `resourceLimits` does not cap WASM memory. Spike an OS-enforced option: spawning the worker as a child process under `prlimit`, or relying on a container memory limit, which turns exhaustion into denial of service rather than compromise. Do not claim isolation until one is tested.

## 4. What each mechanism actually buys (Q4)

| Mechanism | Protects against | Still trusts operator for |
|---|---|---|
| Self-signed seal | Tampering by recipients or third parties with distributed copies, **only if** the verifier pins the fingerprint out of band. Anyone can mint a look-alike self-signed certificate. | Everything the operator produces or re-seals |
| CA or AATL certificate | Reader UX, and an issuer identity for the organization | Same as above. The operator still holds the key. |
| Required TSA | Backdating after the fact. A forged version gets a later time, which retained copies expose. | Content at timestamp time, and "not earlier than" |
| BankID signing | Forging a participant's authorization without their credential. Binds identity to the intent digest. | What is displayed versus bound. Put the document title and a short hash in the displayed text and bind the full SigningIntent digest in the non-displayed data; verify both in the returned signature during the BankID spike. |
| Independently retained copies | Operator rewriting history | Nothing, once retained |

## 5. Missing adversarial and interoperability tests

**PDF**
- An incremental update after the seal: text, annotation, new field, or new signature.
- ByteRange with a gap, overlap, a range not ending at EOF, or a second `/Contents`.
- Multiple signature dictionaries.
- Known attack classes from published research: incremental saving, signature wrapping, universal forgery, and shadow hide/replace variants.
- Trailing bytes after `%%EOF`.
- Placeholder overflow.

**CMS**
- messageDigest mismatch.
- Missing or altered signed attributes.
- Swapped certificate in the SignedData set, as a signing-certificate-v2 binding test.
- Multiple SignerInfos.
- SHA-1.
- A same-subject self-signed certificate with a different key, which must yield "unknown issuer".

**Evidence**
- Detached bundle altered by one byte.
- Duplicate keys.
- BOM.
- NFD names.
- Oversized bundles.
- Commitment present but bundle absent: the result must be "PDF-only verified", not a failure or a pass.
- Prepared-prefix mismatch.

**TSA**
- Wrong imprint, nonce or policy.
- Missing or non-critical `timeStamping` EKU.
- Signing time outside the TSA certificate's validity.
- A rejection status.
- A huge or slow response.
- A redirect to an internal address.
- Configured-host DNS rebinding.

**Job**
- `kill -9` at every step.
- Lease expiry while a TSA call is in flight, with the stale worker returning afterwards.
- Two workers.
- Concurrent final signatures.
- Cancellation racing the last signature.
- A duplicate enqueue.

**Keys**
- Missing, wrong or mismatched key after restore.
- Overly open file permissions.
- Corrupt P12, wrong password, or cert/key mismatch.
- Chain ordering.
- Expired BYO certificate.

**Interoperability.** Validate with:
- pyHanko (MIT, CI only; do not ship Python in the image).
- Poppler `pdfsig`.
- Acrobat Reader, manually per release.
- Optionally the EU DSS validator in CI.

Also test pdf.js rendering, and the 10 MB worst case under the time and memory limits.

## 6. Exact plan changes

**Accept as written**
- The trust model and the four result types.
- Plugin boundaries.
- Evidence core excludes the completed hash.
- Postgres jobs with fencing.
- No exactly-once promise for external calls.
- Fail-closed required TSA.
- No LT/LTA claims.
- No self-built CMS or ASN.1.
- Retain public certificates.
- Pin trust explicitly.
- BankID signing, not login.

**Change**
1. "Explicit instance provisioning" → auto-generate on a fresh database with an empty key volume, and refuse to seal on marker/key mismatch (B4).
2. "Reject unexpected incremental modifications" → a strict single-signature, whole-file ByteRange rule for v2. Defer difference policies (B2).
3. Add: build the final PDF as incremental updates over the prepared bytes, subject to the spike, plus a prefix check in the verifier (B1).
4. Add: minimal-parse key process with placeholder built in the unprivileged worker (B3).
5. Move protection policy and key selection out of the evidence core into seal and completion metadata. Add an audited operator override for a stranded `finalizing` document (B5).
6. Specify: no audit events during `finalizing`; failure states live only in jobs (B6).
7. Store evidence as `bytea` and verify bytes-first; integer strokes (B7).
8. Salted commitments for restricted metadata (B8).
9. Move Docker CI to milestone A.
10. Seal subject, reason and invisibility requirements, plus a DocMDP spike item (B9).

**Reject or defer**
- "Persist immutable … candidate results needed to resume." Restart attempts from scratch and store only attempt metadata. Persisting candidates adds up to 10 MB of bloat per attempt and a resume path that is harder to verify than a redo.
- Browser-local cryptographic verification in this release.
- The completed-copy access portal as a sealing prerequisite.
- A legacy-pending finalizer, if no external installations exist.

**Needs your confirmation**
- Whether any external deployments hold pending v1 documents.
- Whether BYO PKCS#12 belongs in C or D, depending on the spike.