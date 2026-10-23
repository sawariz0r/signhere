# Signhere

Simple, self-hosted document signing. An open-source alternative to Cling.se and other signing platforms, built around two things:

1. Create a document in a nice editor, then send it for signing.
2. Upload a PDF and send it for signing.

Run it on your own server, keep control of your documents, and share personal signing links. The interface is currently in Swedish.

**This is an AI-driven project.** AI tools are used extensively in its design, code and documentation. It's under active development, and contributions, bug reports and PRs are welcome.

## Start here

- [Create and sign your first document](docs/getting-started.md)
- [Self-host with Coolify](docs/self-hosting.md#coolify)
- [Self-host elsewhere with Docker Compose](docs/self-hosting.md#docker-compose)
- [Develop locally and contribute](docs/development.md)

## Available today

- A document editor with saved drafts, pricing tables, images and private client review.
- PDF uploads, personal signing links and drawn signatures.
- Progress tracking, signed PDF downloads and separately signed attachments (*bilagor*).
- Optional email delivery through SMTP or Resend; manual link sharing works without email.
- Team accounts, basic branding and optional connections to your own AI agent.
- Cryptographic PDF seals, an audit trail, downloadable evidence and document verification.

Self-hosting needs no central Signhere account, paid signing certificate or AI-provider key. The app and PostgreSQL run together with Docker Compose.

**Development preview:** independent security review, Linux container validation and PDF-reader checks remain release requirements. See the [implementation status](docs/sealing-implementation.md) before relying on it for important agreements.

## Evidence and verification

Signhere is built with everyday Swedish agreements (*avtal*) in mind. Swedish agreements generally allow flexibility in how acceptance is recorded, although some require specific formalities. Written records help show what was agreed. See [Konsumentverket's explanation](https://www.konsumentverket.se/fragor-och-svar/3244517/ar-muntliga-avtal-bindande/).

Our aim is to retain useful evidence even when you host the platform yourself: the exact signing PDF, explicit consent, signing times, an audit trail and a cryptographic seal. A drawn signature and possession of a link do **not** independently verify someone's identity. The default seal uses the installation's own certificate; it does not establish independent trust or trusted signing time. Whether that evidence is sufficient depends on the agreement and its requirements.

Today, anyone can use your installation's `/verify` page to check whether a PDF matches one of its completed documents. The file stays in the browser; only its fingerprint is sent. Team members can also export an evidence bundle for offline cryptographic verification. See [how verification works and its limits](docs/signing-security.md#6-verify-independently-of-the-running-platform).

## Planned

These are plans, not available features:

- **A simple central verification service:** an optional way to check a signed document's authenticity with evidence outside the self-hosted installation. Its design and trust guarantees are still to be defined.
- **Bring your own BankID:** connect your own BankID integration and certificate.
- **An easier BankID option:** we're exploring a cost-effective way to offer BankID signing without each operator needing their own BankID certificate.

BankID, FrejaID and trusted timestamps are not implemented. See the [signing-method notes](docs/signing-methods.md) for the technical direction.

## More documentation

- [Backups, keys and recovery](docs/deployment.md)
- [Signing security and trust limits](docs/signing-security.md)
- [Connect your agent through MCP or the API](docs/agent-connection.md)
- [Architecture](docs/architecture.md)

## Contributing and license

PRs are welcome: clearer docs, bug fixes, tests, design improvements and help with self-hosting all count. For larger changes, open an issue first to discuss the approach. See the [development guide](docs/development.md) for setup and checks.

Signhere is licensed under [AGPL-3.0-only](LICENSE). If you modify it and offer it over a network, provide the corresponding source as required by the license. Dependencies retain their own licenses.
