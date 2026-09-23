# Signing methods

The first method is **Draw here**. Its purpose is to make the existing signing interaction the first explicit method implementation, so future methods can be added without rewriting document authorization, consent, evidence storage or completion.

This document distinguishes the initial behavior from the future asynchronous provider design. It is not a promise that arbitrary third-party plugins can already be installed or that BankID/Freja integrations exist.

## Initial draw method

The method collects a drawn signature, the recipient's stated full name and affirmative consent. The server checks the recipient capability and document state, validates submitted evidence, and records its method identifier/version with the immutable document binding.

The evidence says that someone with access to this signing link approved this document through this method. It does not assert verified legal identity, email-inbox control, biometrically verified handwriting, an advanced signature or a qualified signature.

The core application owns:

- Team and recipient authorization, token lifecycle and document access.
- Frozen document bytes and digest, recipient assignment and allowed workflow transitions.
- Consent policy and the exact accepted wording/version.
- Audit timestamps and observed request metadata.
- Atomic storage of evidence, recipient state and completed artifacts.
- PDF generation, export and verification behavior.

The method owns input validation and the method-specific evidence it returns. A method must not directly change another recipient, replace document bytes, write arbitrary audit history or mark an envelope completed.

## Proposed asynchronous provider boundary

External methods need durable attempts because a user can leave the browser while a remote signing request is pending. The following is a target interface for later adapters, not a statement that all of these hooks are implemented today:

```ts
interface SigningMethod {
  id: string;
  version: string;
  capabilities: MethodCapabilities;
  start(context: FrozenSigningContext): Promise<AttemptUpdate>;
  submit?(context: AttemptContext, input: unknown): Promise<AttemptUpdate>;
  poll?(context: AttemptContext): Promise<AttemptUpdate>;
  cancel?(context: AttemptContext): Promise<AttemptUpdate>;
  handleCallback?(context: CallbackContext): Promise<AttemptUpdate>;
}
```

`FrozenSigningContext` identifies the team, document revision, recipient, digest algorithm/value, consent version, signing payload, expiry and server-generated attempt/idempotency identifier. The core constructs this context from its database, never from untrusted client identity or document fields.

`AttemptUpdate` is a discriminated result: `pending`, `completed`, `failed`, `cancelled` or `expired`. A completed result includes the provider transaction reference, method and evidence schema versions, exact data or digest covered, verified identity claims with their source/assurance, and the raw provider proof needed for later validation. A drawing is method-specific evidence rather than a mandatory field for every provider.

Persist attempts before leaving the local process boundary. Bind each callback or poll result to an existing attempt and revalidate its expected recipient, provider transaction, document revision and state. Browser navigation, a return URL, an HTTP 200 response or a client-submitted `completed` flag is not sufficient proof of signing.

Completed transitions must be idempotent. A later duplicate result can return the retained outcome; it cannot add another signature. A result arriving after cancellation or expiry needs an explicit reconciliation policy and audit event. Do not silently reactivate the document. Provider network calls and polling never run inside a held PostgreSQL document transaction; persist the attempt, release locks, call the provider, then revalidate and commit the result in a new transaction.

## Identity methods and PDF sealing are different capabilities

| Boundary | Responsibility | Initial status |
| --- | --- | --- |
| Signing method | Capture intent and evidence linked to the document; optionally authenticate identity. | Draw only. |
| Provider evidence verifier | Validate a provider's response, identity claims and signed payload. | Future adapters. |
| PDF finalizer | Produce the readable completed PDF and appendix. | Durable v2 finalization; legacy v1 synchronous path retained. |
| PDF sealer | Apply a cryptographic PDF signature using a managed certificate/key. | Local installation seal for new v2 documents; self-signed default or imported certificate. See [profile](pdf-sealing-spike.md). |
| Timestamp provider | Obtain and validate independent timestamp evidence. | Not implemented. |

Keep assurance explicit. Avoid a generic `verified: true` field that conflates link possession, email verification, an identity provider's authentication level and qualified signing. Declared capabilities guide routing; a plugin's self-declared label does not establish its legal classification.

## BankID and Freja integration notes

BankID signing should use the signing operation and preserve what the user was shown together with the exact bound non-visible data. Bind the return flow to the originating attempt and verify the final order server-side. Client credentials and provider response validation belong on the backend. [BankID sign API](https://developers.bankid.com/api-references/auth--sign/sign).

Freja requires an initiation/result/cancellation lifecycle. Preserve returned JWS evidence and explicitly track the selected signature type and identity registration/assurance level. Request only necessary identity attributes. An authentication result must not be relabeled as a signature over a document that the provider did not cover. [Freja signature service](https://frejaeid.atlassian.net/wiki/spaces/DOC/pages/2162814).

Before implementing either adapter, pin and review the then-current provider API contract, obtain operator-controlled credentials, implement proof validation, and add deterministic tests for bad signatures, wrong documents, mismatched identities, timeouts, replays and concurrent callbacks. The provider's own onboarding and agreement requirements remain separate from installing Signhere.

## Plugin trust and compatibility

Begin with trusted, code-reviewed adapters installed by the operator. Loading arbitrary code into the application gives that code the process's privileges; the word plugin does not create a security sandbox. Remote plugin installation and untrusted runtime uploads are outside the first build.

Store method version and evidence schema version with each accepted attempt. Upgrading a method must not require rewriting historical evidence. Preserve raw proof in a documented format alongside normalized claims so future validators can examine what was actually returned.

Provider secrets must be injected through server-side configuration or private secret files and omitted from client bundles, logs and exports. Use approved provider endpoints, bounded requests and explicit callback verification. A future independently deployed adapter needs authenticated transport and a narrowly scoped protocol.

The legal distinction between simple, advanced and qualified signatures, and the current limits of hash-based evidence, are documented in [Research](research.md).
