# RFC 3161 feasibility checkpoint

Date: 2026-09-24. This is a design/spike record, not enabled timestamp support.

The pinned pyHanko runtime can support the planned required-timestamp milestone without changing the single-signature, whole-file PDF profile. A generated local TSA fixture was exercised without network calls: request creation, a nonce-bearing response, explicit CA-chain validation and SHA-256 imprint validation passed; wrong nonce and wrong imprint failed. The fixture request was 69 bytes and response 2,352 bytes. APIs inspected: `TimeStamper.request_cms`, `DummyTimeStamper.async_request_tsa_response`, `handle_tsp_response`, `validate_tst_signed_data` and `Signer.unsigned_attrs`.

## Minimal extension

1. The public preparation worker embeds the frozen required timestamp policy in the protected manifest and reserves a bounded larger Contents slot.
2. The key worker produces CMS with the normal platform signature and returns its signature-value SHA-256 imprint, a maintained-library RFC 3161 request and the exact request nonce. It still performs no PDF object parsing or network access.
3. Node POSTs the DER request through a dedicated bounded HTTPS transport. No document content, participant fields or private keys are sent.
4. A public helper parses the bounded response with maintained ASN.1 code, validates response status, exact nonce and SHA-256 imprint, CMS signature, explicit TSA trust roots, certificate validity and the timestamp date. Also explicitly require a critical extended-key-usage extension containing only timeStamping; do not assume the library's generic EKU membership check establishes the full RFC 3161 certificate profile.
5. Add one signatureTimeStampToken unsigned CMS attribute using maintained CMS objects, patch the same reserved Contents value and validate the exact final PDF. Do not add an incremental document timestamp or allow later revisions.

The maximum response can be 64 KiB with a 128 KiB DER Contents reservation; real chain size still needs an explicit cap and overflow test. Never truncate a token or silently omit timestamping. The existing frozen policy and finalization job preserve accepted approvals through timeouts, invalid responses and retries.

## Network and trust requirements

Use HTTPS with ordinary hostname/certificate verification, no userinfo/fragment, no redirects and no PDF/certificate-supplied URLs. Resolve all addresses, reject non-public IPv4/IPv6 including mapped addresses and loopback/link-local/private ranges, then pin the checked address for the actual TLS connection while preserving the original hostname as TLS servername. Apply a total timeout (for example ten seconds), bounded DNS/connect/read phases and 64 KiB response cap. Test network behavior through dependency-injected mock transport; do not weaken production private-address policy merely to run a localhost test.

Freeze the requested TSA policy/provider trust requirements at document creation. Changing deployment configuration must not silently replace a required provider/trust policy or downgrade a pending envelope. Explicit retry/recovery may only satisfy the existing policy.

Operator-configured TSA roots allow the server to validate before publication. Those roots embedded with the artifact are not automatically trusted by an independent verifier. Add a separate timestamp trust input/result, distinct from the PDF issuer fingerprint and cryptographic token integrity. An intact token from an untrusted TSA cannot be reported as externally trusted time. Keep revocation/archival/LT/LTA claims out of this milestone unless independently implemented and tested.

## Required negative tests

Missing/stripped token under required policy; wrong imprint, digest algorithm or nonce; non-success response; duplicate/extra unsigned attributes; non-critical, wrong or mixed EKU; invalid/untrusted chain; invalid/future timestamp; certificate validity mismatch; oversized/malformed/slow response; redirect/private-IP/mapped-IP/DNS-rebinding attempts; placeholder overflow; failure after accepted approvals and safe retry; standalone validation with known versus unknown TSA trust.

Conclusion: implementation is technically practical and can be tested with a generated local TSA. It is a separate transport, trust-model and verifier milestone, not a switch that should enable pyHanko's built-in HTTP client inside the key worker. The current local release rejects required timestamps until this complete path is implemented.
