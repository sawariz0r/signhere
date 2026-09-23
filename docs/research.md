# Signing platform research

Research date: 2026-09-23. These notes distinguish observed behavior in other projects from Signhere's implementation decisions. They are technical research, not a certification or a determination that a particular contract will be enforceable.

## What the reference projects contribute

| Project | Relevant behavior | Signhere implication |
| --- | --- | --- |
| DocuSeal | Produces a completion certificate with envelope and recipient identifiers, event times, request metadata, and authentication evidence. | Preserve an understandable history alongside the signed document; the drawn mark alone is insufficient evidence of the process. |
| Documenso | Separates recipient actions from the instance's X.509 PDF signature. Locks content, fields and recipients after sending and provides a completed document and audit record. | Separate signing methods, workflow state, evidence, and a future PDF sealing service. |
| OpenSign | Maintains activity records and creates a completion certificate. Its PDF implementation signs final PDFs and certificates and calculates a SHA-256 document digest. | Make evidence export and document integrity first-class features, with accurate descriptions of which cryptographic operations Signhere actually performs. |

Primary sources: [DocuSeal audit certificate](https://www.docuseal.com/faq/what-is-the-certificate-of-signature-audit-log), [Documenso signing certificates](https://docs.documenso.com/docs/concepts/signing-certificates), [Documenso lifecycle](https://docs.documenso.com/docs/concepts/document-lifecycle), [OpenSign repository](https://github.com/OpenSignLabs/OpenSign), [OpenSign PDF implementation](https://github.com/OpenSignLabs/OpenSign/blob/staging/apps/OpenSignServer/cloud/parsefunction/pdf/PDF.js).

Documenso's source also separates local certificate and cloud HSM transports, supports timestamping, and uses a finalization job that checks required actions before persisting the output and completion event. These are references for later work; Signhere has not implemented those features. [Signing package](https://github.com/documenso/documenso/blob/main/packages/signing/index.ts), [Finalization job](https://github.com/documenso/documenso/blob/main/packages/lib/jobs/definitions/internal/seal-document.handler.ts).

Links to moving branches describe the source reviewed on the research date, not a pinned upstream release or an independent security review.

## Legal baseline and terminology

EU eIDAS Article 25 prevents rejection of an electronic signature solely because it is electronic or does not meet qualified-signature requirements. It gives qualified electronic signatures the equivalent legal effect of handwritten signatures. Article 26 imposes additional requirements for advanced signatures: linkage to and identification of the signer, control of signature-creation data, and detectable subsequent document changes. The regulation does not make every electronic workflow suitable for every document. [Consolidated eIDAS, Articles 25–26](https://eur-lex.europa.eu/eli/reg/2014/910/2024-10-18/eng).

Signhere's initial draw method is a **simple electronic signature workflow**. It records a person's stated name, possession of a signing link, drawing, consent and server-observed events. A name or email entered by a sender is an assertion; possession of a bearer link does not verify civil identity or prove that a particular person controlled an email inbox.

The first build has no PAdES signature, X.509 PDF seal, trusted timestamp authority, qualified trust service integration, or independent identity verification. Its PDF evidence appendix and hash-chain JSON export must not be described as those capabilities. A completion record called a certificate or verifikat in the interface is an application-generated evidence record, not a qualified certificate.

An internally consistent hash chain can expose changes relative to an independently retained chain head or export. An administrator who controls the database can replace a document, its events and all associated hashes. Local hashes cannot establish trusted time or exclude operator fabrication. Future certificate sealing, trusted timestamping and external evidence retention can strengthen different parts of this trust model; none should silently change the claimed assurance of the draw method.

Contract requirements depend on jurisdiction, document category and the parties involved. Review those requirements before representing a deployment as suitable for a regulated signing use case. Retaining documents, IP addresses and identity evidence also requires appropriate data protection and security measures. [European Commission: security of personal data processing](https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/obligations_en).

## Implications for future identity methods

BankID exposes a signing operation with displayed text and optional non-displayed data. Its return-flow guidance requires session binding and checking the completed order. A future adapter should bind the frozen document digest to the signing payload and validate completion server-side. [BankID sign API](https://developers.bankid.com/api-references/auth--sign/sign).

Freja's signing service has initiation, result polling and cancellation. Extended signatures cover displayed text and binary data in returned JWS evidence; registration level and signature type must be represented explicitly. A successful authentication is not automatically evidence of consent to a particular document. [Freja signature service](https://frejaeid.atlassian.net/wiki/spaces/DOC/pages/2162814).

Neither provider is implemented in the initial build. Their contracts motivate the asynchronous extension boundary described in [Signing methods](signing-methods.md).

## Self-hosting decision

Signhere uses one Node.js application and PostgreSQL. Docker Compose provides the two services; a real portable PostgreSQL 18.6 instance also runs locally for development without Docker. Document blobs, workflow state and evidence stay in one transactional database, with per-document locking for concurrent signatures.

For comparison, Documenso requires PostgreSQL and can use its database for background jobs and document storage, with external object storage optional. Signhere defers a durable provider/finalizer queue until asynchronous integrations need it; this is a deliberate first-build scope decision. [Documenso self-hosting requirements](https://docs.documenso.com/docs/self-hosting/getting-started/requirements).

## Licenses and independent implementation

Signhere uses AGPL-3.0-only, as selected by the project owner. The public core repositories of these reference projects use AGPL-3.0. Documenso also contains commercially licensed enterprise code. Open source availability does not mean code may be copied without license obligations; inspect the actual package and file licenses before any reuse.

Signhere uses these projects as technical inspiration. No competitor source code is copied by this research or the foundation described here. Independently implementing an observed workflow is distinct from adapting protected source code, assets or branding.

- [DocuSeal license](https://github.com/docusealco/docuseal/blob/master/LICENSE)
- [Documenso core license](https://github.com/documenso/documenso/blob/main/LICENSE)
- [Documenso enterprise license](https://github.com/documenso/documenso/blob/main/packages/ee/LICENSE)
- [OpenSign license](https://github.com/OpenSignLabs/OpenSign/blob/staging/LICENSE)

## Requested second-model review

The initial terminal invocation stopped on expired OAuth credentials. After the user renewed authentication, a read-only, tools-disabled consultation completed successfully; the CLI reported canonical model `claude-opus-5-5`. Claude considered the proposed single-node simple-signature foundation sound and recommended stronger PDF processing boundaries, concurrency protection, explicit identity claims and portable evidence. This was an architecture critique, not a production certification. Accepted recommendations, deferred work and the later PostgreSQL decision are recorded in [Claude review](claude-review.md).
