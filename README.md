# Signhere

Simple, self-hosted document signing. Swedish interface based on the supplied Signhere prototype. Licensed under AGPL-3.0-only.

**Local-sealing development foundation, not a production-certified signing service.** New documents receive a cryptographic PDF seal from this installation and can be verified offline. The draw method records consent and evidence without verifying a person's identity. Trusted timestamps, BankID and FrejaID are not implemented. Docker isolation/lifecycle checks and independent PDF-reader validation remain release gates; see the [implementation status](docs/sealing-implementation.md).

## What works

- Protected first-owner setup, login, persistent sessions and team invitations.
- Upload a PDF, automatically flatten supported annotations and forms, optionally preview the signing copy, add recipients, and share personal signing links.
- Read the actual PDF, draw a signature, and explicitly agree to the recorded consent. Selecting “Jag ska också signera” adds the sender separately from every entered party, even when they share an email address, and opens the sender’s signing step after creation. Each assignment needs its own signature and audit event; the document stays pending until all have signed.
- Track recipient progress and audit events; revoke a pending document or rotate a recipient link.
- Download the signing document, sealed completed PDF, preserved pre-conversion upload, and portable verification bundle. Full evidence is restricted to authenticated team members; recipient receipt/copy links provide the completed PDF.
- Public `/verify` page: anyone can check a completed PDF without an account, uploading its contents, or revealing recipient details.
- A versioned internal draw signing adapter, with provider integration boundaries documented for later work.
- Block-based document editor (preview) at `/editor/…`. It has a cover, parties, pricing packages with VAT, rich text with dynamic `@` fields, image, terms and signature blocks, plus theming and a desktop/mobile preview. Drafts are saved in the browser for now. Sending from the editor will be enabled once the server renders blocks to PDF.

The implementation uses React, TypeScript, Express, PostgreSQL and a bundled Python/pyHanko PDF sealer. PDF bytes and evidence live in PostgreSQL; private sealing keys have a separate persistent volume. The last approval queues durable finalization, and completion publishes the verified PDF and evidence atomically. Fonts are served locally. No hosted service, paid certificate, SMTP account, Redis or object store is required. Link sharing is manual. Unsigned links default to 7 days (`SIGNHERE_SIGNING_LINK_TTL_DAYS`, 1–365); after acceptance the same link provides a read-only receipt for 30 days and permits exact idempotent retries. Download the completed copy during that period.

## Public verification

Share `https://your-signhere-host/verify` with anyone who needs to check a completed PDF. The page is separate from the account area and works without a session; `/verifiera` is an alias. Its appearance is the same for signed-in visitors. The browser calculates the file fingerprint locally and only that SHA-256 digest is sent to the server. A match confirms that the bytes match a completed PDF held by this installation. Use the server where the document was signed. This is an installation-local hash lookup; independent cryptographic verification is described below.

## Automatic PDF preparation

The authenticated upload step checks the source, then uses the bundled MuPDF WebAssembly engine to flatten supported annotations and form widgets into static PDF content. It keeps text and vector graphics rather than rasterizing every page. Ordinary links become inactive. Comment text is retained in an extra notes appendix; the optional preview includes that appendix. PDFs that are already static keep their exact bytes.

The sender can preview the PDF, but no preview acknowledgement is required. Sending prepares the uploaded source on the server and freezes that version for recipients to read and sign. Recipient signatures must match its digest. Both the source and prepared PDF are retained when they differ, with immutable conversion metadata in the audit trail. Existing documents are not converted retroactively.

This is not a universal PDF repair service: active scripts, attachments, pre-existing digital signatures, encrypted documents and unsupported structures remain rejected. Conversion runs locally in a bounded PDF child process; Docker bundles all preparation and sealing dependencies without an external API or additional service. Native development also needs the Python environment below. MuPDF's [document baking API](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFDocument.html#PDFDocument.prototype.bake) supplies the flattening engine.

## Docker installation

Requires Docker with Compose and a Linux host supporting the required PDF sandbox. The application and database have separate containers; PostgreSQL is not published to the host network. See [deployment, keys and recovery](docs/deployment.md) for runtime privilege separation, sandbox limits and paired backups.

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` and `APP_DATABASE_PASSWORD` to different long URL-safe random passwords. If Node is installed, `npm run setup:env` creates the file securely for you and preserves existing settings.
2. For public hosting, set `BASE_URL` to the exact public HTTPS origin and place the app behind your TLS reverse proxy. Defaults bind only to localhost.
3. Run:

```sh
docker compose up -d --build
docker compose exec signhere cat /data/setup-token
```

Open `http://localhost:3000`, create your account and enter the installation key. Setup closes after the first owner exists. Keep `.env` private. The installation key is not printed in application logs.

Persistent named volumes hold PostgreSQL data, the app's setup state, and the separate private sealing key store. `docker compose down` preserves them. Do not use `down -v` unless you intend to delete the installation's persistent data.

This machine cannot run Docker, so the Compose configuration is statically validated; container execution must be verified on a working Docker host. The app is tested directly against real PostgreSQL locally.

## Deploy with Coolify (GitHub → Docker Compose)

Coolify builds the image from this repository and runs the app and PostgreSQL from `docker-compose.yaml`. Coolify's proxy terminates TLS; nothing else needs to be exposed.

1. **DNS:** point a hostname, e.g. `sign.example.com`, at your Coolify server.
2. **Create the resource:** in Coolify choose *Project → New → Resource → Private Repository (with GitHub App)*, or *Public Repository*, then select this repository and the `main` branch. Set *Build Pack* to **Docker Compose**; the default *Docker Compose Location* `/docker-compose.yaml` is correct.
3. **Environment variables:** set three under *Environment Variables*, before the first deploy:

   | Variable | Value |
   |---|---|
   | `POSTGRES_PASSWORD` | A long random URL-safe value, e.g. from `openssl rand -hex 32`. Don't change it after the first deploy; the database keeps the original. |
   | `APP_DATABASE_PASSWORD` | A different long URL-safe random value for the restricted runtime role. Keep it stable after first deployment. |
   | `BASE_URL` | The exact public origin, e.g. `https://sign.example.com`, with no trailing slash. Requests from any other origin are rejected. |

   That's all. PostgreSQL runs inside the same stack, so there is no connection string to set. `TRUST_PROXY` defaults to `uniquelocal`, which trusts Coolify's proxy on the private Docker network so the audit trail records visitors' real IPs. Leave `PORT` and `BIND_ADDRESS` at their defaults; change `PORT` only if host port 3000 is already taken.
4. **Domain:** on the `signhere` service, set *Domains* to `https://sign.example.com:3000`. The `:3000` tells the proxy which container port to route to; it is not part of the public URL. Leave the `postgres` service without a domain.
5. **Deploy**, and wait for the health check to turn green.
6. **Create the owner account:** open the `signhere` container's *Terminal* in Coolify (or run `docker exec <container> cat /data/setup-token` on the server) and run:

   ```sh
   cat /data/setup-token
   ```

   Then open `https://sign.example.com`, create your account, and enter that installation key. Setup closes once the first owner exists.

**Updates:** with the GitHub App, turn on *Auto Deploy* so every push to `main` rebuilds and redeploys. The named volumes, `postgres-data`, `signhere-data` and `signhere-keys`, survive redeploys. Don't delete the resource's volumes unless you intend to wipe the installation.

**Backups:** documents and evidence live in PostgreSQL; private signing keys live in a separate volume. Schedule paired encrypted database/key backups and copy them off-host. Follow [deployment, keys and recovery](docs/deployment.md#paired-encrypted-backups). A database-only backup is incomplete for future sealing.

## Development without Docker

Use Node.js 22.16+ (24 LTS recommended), Python 3.11+ and PostgreSQL 17+. Set `DATABASE_URL` to a dedicated application database owned by a non-superuser role. Do not use a shared production database for development. Create the local sealing environment once (PowerShell):

```powershell
python -m venv .local/seal-python
.local/seal-python/Scripts/python.exe -m pip install --require-hashes -r scripts/pdf-seal/requirements.txt
npm ci
npm run dev
```

On Linux/macOS, use `.local/seal-python/bin/python` for the pip command. The application discovers that environment automatically; `SIGNHERE_SEAL_PYTHON` can select a different **absolute** interpreter path. Keep private keys outside public runtime/code directories. Native Windows development does not provide the Linux parser sandbox used by the Docker image.

Retrieve the first-owner installation key with `Get-Content data/setup-token` in PowerShell or `cat data/setup-token` on Unix (use your configured `DATA_DIR` if different). Enter it during the two-step signup.

The development launcher reads `.env` and, if present, the ignored `.local/postgres.env`. The frontend runs at `http://localhost:5173`, with same-origin API proxying to port 3000. `DEV_BASE_URL` can override the development browser origin. The normal production build serves UI and API together:

```sh
npm run build
npm start
```

For this workspace, a portable PostgreSQL installation is kept in `.local/postgres`, with its data in `.local/pgdata`. It listens only on `127.0.0.1:15432`; credentials are in `.local/postgres.env`, outside version control. It is not a Windows service. Use `npm run db:status`, `npm run db:start` or `npm run db:stop` to control it without changing PowerShell execution policy.

## Validation

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
```

Browser tests use installed Edge on Windows; elsewhere install Chromium with `npx playwright install chromium`. They create a disposable database schema, exercise the real signing flow and save screenshots under the ignored `.test-artifacts/browser` directory.

Integration tests require `TEST_DATABASE_URL` (or a dedicated development `DATABASE_URL`). Tests create isolated schemas and exercise real database transactions. CI provisions PostgreSQL and has a separate Docker lifecycle job for fresh setup/signing, sandbox probes, runtime privilege checks, restart/persistence, and paired database/key restoration. Those container checks require a working Linux runner; they have not run on this machine.

## Backups and restore

All document bytes and evidence live in PostgreSQL. Use PostgreSQL's consistent snapshot tooling, not a live filesystem copy of the database volume.

A local roundtrip test has restored a completed document and verified its evidence. With a `pg_dump` client matching your server and `DATABASE_URL` configured:

```sh
npm run backup -- backups/signhere.dump
```

The script does not overwrite existing backups or put credentials in command-line arguments. `PG_DUMP` can select a client binary. Store backups encrypted off-host and test restoring into a fresh, isolated database with `pg_restore`. Pair each database backup with an encrypted backup of the sealing key store and deployment configuration; follow the [paired backup and restore instructions](docs/deployment.md#paired-encrypted-backups). A database dump alone does not restore future sealing capability.

For Docker, create a dump inside the database container, then copy it out (this avoids binary-output corruption in older Windows PowerShell):

```sh
docker compose exec postgres pg_dump -U signhere -d signhere -Fc -f /tmp/signhere.dump
docker compose cp postgres:/tmp/signhere.dump ./backups/signhere.dump
```

## Offline evidence verification

Export the complete verification bundle from the authenticated document page. Keep its exact PDFs and JSON together. Using the Node/Python environment above, run for new sealed v2 documents:

```sh
npm run verify:sealed -- evidence.json original.pdf completed.pdf
```

For a converted document, `original.pdf` means the prepared signing PDF. Add the preserved upload as a fourth argument (`uploaded.pdf`) to verify its source digest too; otherwise the verifier reports that the pre-conversion upload was not checked. The package contains standalone verifier source and hash-locked dependencies for use without the Signhere server. Obtain verifier software from a trusted source or inspect it before executing software supplied alongside an untrusted document.

The verifier checks PDF/CMS integrity and coverage, the protected evidence commitment and participant/document bindings. It reports certificate trust separately. Add `--trust-fingerprint` followed by a SHA-256 certificate fingerprint obtained through an independently trusted channel. Exit 0 means the checks pass with that explicit fingerprint; exit 3 means integrity/evidence pass but the issuer is unknown; exit 1 means verification failed. No trusted timestamp or online revocation check is performed.

Existing v1 documents remain unsealed legacy evidence. For them, `npm run verify:evidence -- evidence.json original.pdf completed.pdf` checks hashes and audit consistency only. They are not silently upgraded.

## Evidence and security boundaries

The uploaded source bytes are retained unchanged. When conversion is needed, recipients approve the frozen static signing copy; the source hash and conversion metadata are bound into the evidence. The completed PDF adds per-signer evidence pages and an installation seal. Its full-file hash is stored/exported separately to avoid a circular hash dependency.

Each fresh installation automatically generates its own certificate and private key. A default self-signed seal makes changes detectable against that key, but an unknown certificate does not prove issuer identity. Independently retain the certificate fingerprint, evidence and files. Optional imported certificate files are supported; an external certificate and a trusted timestamp are distinct from participant identity verification. A privileged operator who controls the key can issue another seal.

Personal links are credentials. Signing consumes the ability to change that recipient's approval, while receipt access continues for 30 days; this is not literal destruction of the token after one use. Names are claims; a drawing and possession of a link do not establish verified identity. Network metadata describes the observed connection. Private JSON/ZIP evidence includes personal request details and should be shared deliberately.

Before real production use, complete independent security and legal review, actual Linux container/isolation tests, reader interoperability checks, retention/erasure procedures, paired restore drills, and measured storage/concurrency limits. These are release requirements, not promises made by the interface.

- [How signing is sealed and secured](docs/signing-security.md)
- [Architecture](docs/architecture.md)
- [Sealing implementation status and review dispositions](docs/sealing-implementation.md)
- [SES specification coverage and differences](docs/ses-spec-crosscheck.md)
- [Deployment, private keys and paired recovery](docs/deployment.md)
- [PDF seal profile and validation limits](docs/pdf-sealing-spike.md)
- [Signing methods and future provider integrations](docs/signing-methods.md)
- [DocuSeal, Documenso, OpenSign and legal-source research](docs/research.md)
- [Claude Opus 5.5 architecture review](docs/claude-review.md)

## License and contribution

Application code is AGPL-3.0-only; see `LICENSE`. If you modify the application and offer it to users over a network, provide the corresponding source as required by that license. Dependencies retain their own licenses. Competitor projects were researched as references; their source code was not copied.

The `design/prototype` folder preserves the supplied design reference and is excluded from the runtime image. Changes to legal or identity claims in the prototype were intentional: the interface must describe evidence the backend actually produces.
