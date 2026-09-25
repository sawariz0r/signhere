# CEN-007 — Hash-only RFC 3161 timestamp gateway

- ID: CEN-007
- Status: Backlog
- Priority: P1
- Milestone: Portable verification beta
- Owner: Cryptography/backend engineering (unassigned)
- Depends on: CEN-001, CEN-002, CEN-006

## Goal

Provide an optional independent timestamp without transmitting document contents to
signhere.se or the timestamp authority. Preserve a standard, portable proof of existence
by a time; it is not proof of participant identity or truth of the recorded approval events.

## Scope and deliverables

- Define an authenticated, rate-limited gateway contract for a bounded RFC 3161 request:
  supported digest algorithm, signature-value imprint, nonce, and requested policy.
  Reject PDFs, document fields, arbitrary URLs, and unsupported request extensions.
- Publish the exact data flow and metadata policy: signhere.se observes request and
  connection metadata; the TSA observes the request and gateway connection. Do not
  forward the installation's IP address. Hash-only does not mean anonymous or zero data.
- Maintain a reviewed allowlist of TSA endpoints, roots, policies, and supported algorithms.
  A submitted request, PDF, certificate, AIA/CRL field, or token cannot select a fetch URL.
- Use a dedicated transport with verified HTTPS, no redirects/userinfo/fragments, a total
  deadline, bounded DNS/connect/read phases, bounded concurrency, and capped responses.
  Resolve and reject non-public IPv4/IPv6, including mapped/private/link-local addresses,
  then pin the checked address while retaining the original hostname for TLS verification.
- Validate DER and response status, exact nonce/imprint/algorithm, CMS signature, chain,
  frozen policy, time bounds, and validity at the token time. Require a critical EKU
  containing only timeStamping; generic membership checks do not suffice.
- Set and verify response, chain, parsing, and signature-slot budgets using the feasibility
  checkpoint as a starting point: 64 KiB response and 128 KiB Contents reservation.
  Reject overflow, duplicate tokens, unexpected unsigned attributes, and malformed ASN.1.
- Coordinate CEN-005 integration: the key worker produces CMS and the exact signature-value
  imprint/nonce without network access or PDF parsing; a public helper validates the token;
  insert one signatureTimeStampToken into the existing reserved Contents slot and validate
  the final PDF. Do not add incremental revisions or a separate document timestamp.
- Freeze required/optional policy and acceptable provider trust before invitations. Retrying
  a pending envelope must satisfy that frozen policy; configuration changes cannot downgrade
  it or silently switch authority. An enabled required timestamp blocks final delivery on failure.
- Define retry/idempotency behavior, token-to-signature binding, bounded transient storage,
  safe crash recovery, and upstream quota/error handling with CEN-005 and CEN-011.
- Distribute TSA verification material under CEN-006 trust rules. Operator-approved or
  embedded roots may validate publication policy without becoming trusted for every verifier.

## Acceptance criteria

- [ ] Captured synthetic request traffic contains only the specified timestamp request
  and transport/authentication metadata, with no PDF, recipient fields, or forwarded IP.
- [ ] A valid synthetic TSA token is inserted into the reserved CMS slot, and the exact
  final artifact passes the supported single-signature, whole-file validation profile.
- [ ] Wrong/missing nonce, imprint, algorithm or policy; non-success status; invalid chain;
  future/invalid time; validity mismatch; or non-critical/wrong/mixed EKU is rejected.
- [ ] Missing/stripped tokens under required policy, extra unsigned attributes, oversized
  chains/tokens, malformed ASN.1, and Contents overflow cannot yield a completed document.
- [ ] Redirects, private/mapped IPs, DNS rebinding, slow responses, and certificate-directed
  network requests fail boundedly through injected transport tests without loosening policy.
- [ ] Upstream timeout, quota exhaustion, and a crash after approval preserve accepted
  approvals and leave finalization pending; a policy-compliant retry completes safely.
- [ ] A changed deployment configuration cannot remove an envelope's required timestamp,
  silently replace its permitted TSA, or reuse a token for a different signature value.
- [ ] Known-versus-unknown TSA fixtures produce separate cryptographic-token and trusted-time
  results in CEN-008; an embedded self-signed TSA never earns an independent-time claim.
- [ ] Logs, traces, metrics, and error payloads satisfy CEN-010 retention/redaction rules;
  proxy and upstream access are included in the privacy verification.

## Verification evidence

- Reviewed gateway/API contract and frozen-policy/finalization state diagram.
- Local generated-TSA positive and negative fixtures, maintained-library test results,
  injected adversarial transport results, and an exact-final-PDF integration transcript.
- Sanitized request/log samples and documented operational budgets and upstream limits.
- CEN-008 interoperability fixtures with the request/token correspondence preserved.

## Open decisions and exclusions

- Select TSA provider, procurement/service limits, acceptable policy OIDs and roots, clock
  skew, finalization deadlines, and precise size budgets before production enablement.
- Decide whether an optional timestamp mode is offered at all; any explicitly required
  policy must fail closed. Explain each mode before consent rather than after a failure.
- Retroactive timestamping proves existence at the later timestamp, not the earlier claimed
  signing date. This gateway provides neither document retention nor participant approval.
- LT/LTA, automatic revocation fetching, archival renewal, and qualified-status claims are
  outside this milestone; evaluate the preservation requirements in CEN-015 separately.

## Design references

- [RFC 3161 feasibility checkpoint](../../rfc3161-feasibility.md)
- [Fable review dispositions](../../reviews/2026-09-24-fable-trust-dispositions.md)
