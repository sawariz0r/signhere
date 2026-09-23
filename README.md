# Signhere

Simple, self-hosted document signing. Swedish interface based on the supplied Signhere prototype. Licensed under AGPL-3.0-only.

**Initial development foundation, not a production-certified signing service.** The draw method records consent and evidence but does not verify a person's identity. Completed PDFs have a signature appendix; cryptographic PDF sealing, trusted timestamps, BankID and FrejaID are not implemented yet.

## What works

- Protected first-owner setup, login, persistent sessions and team invitations.
- Upload a PDF, automatically flatten supported annotations and forms, optionally preview the signing copy, add recipients, and share personal signing links.
- Read the actual PDF, draw a signature, and explicitly agree to the recorded consent. Selecting “Jag ska också signera” adds the sender separately from every entered party, even when they share an email address, and opens the sender’s signing step after creation. Each assignment needs its own signature and audit event; the document stays pending until all have signed.
- Track recipient progress and audit events; revoke a pending document or rotate a recipient link.
- Download the signing document, completed PDF, preserved pre-conversion upload, and portable JSON evidence.
- Public `/verify` page: anyone can check a completed PDF without an account, uploading its contents, or revealing recipient details.
- A versioned internal draw signing adapter, with provider integration boundaries documented for later work.
- Block-based document editor (preview) at `/editor/…`. It has a cover, parties, pricing packages with VAT, rich text with dynamic `@` fields, image, terms and signature blocks, plus theming and a desktop/mobile preview. Drafts are saved in the browser for now. Sending from the editor will be enabled once the server renders blocks to PDF.

The implementation uses React, TypeScript, Express and PostgreSQL. Original/final PDF bytes and evidence are stored in PostgreSQL so completion has a single transactional boundary. Fonts are served locally. No hosted service, SMTP account, Redis or object store is required. Link sharing is manual, as in the prototype. Unsigned links expire after 7 days; signing extends that recipient's access for 30 days. Recipients should download their completed copy during that period.

## Public verification

Share `https://your-signhere-host/verify` with anyone who needs to check a completed PDF. The page is separate from the account area and works without a session; `/verifiera` is an alias. Its appearance is the same for signed-in visitors. The browser calculates the file fingerprint locally and only that SHA-256 digest is sent to the server. A match confirms that the bytes match a completed PDF held by this installation. Use the server where the document was signed.

## Automatic PDF preparation

The authenticated upload step checks the source, then uses the bundled MuPDF WebAssembly engine to flatten supported annotations and form widgets into static PDF content. It keeps text and vector graphics rather than rasterizing every page. Ordinary links become inactive. Comment text is retained in an extra notes appendix; the optional preview includes that appendix. PDFs that are already static keep their exact bytes.

The sender can preview the PDF, but no preview acknowledgement is required. Sending prepares the uploaded source on the server and freezes that version for recipients to read and sign. Recipient signatures must match its digest. Both the source and prepared PDF are retained when they differ, with immutable conversion metadata in the audit trail. Existing documents are not converted retroactively.

This is not a universal PDF repair service: active scripts, attachments, pre-existing digital signatures, encrypted documents and unsupported structures remain rejected. Conversion runs locally in the existing bounded PDF worker; no external API, Python installation or additional Docker service is needed. MuPDF's [document baking API](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFDocument.html#PDFDocument.prototype.bake) supplies the flattening engine.

## Docker installation

Requires Docker with Compose. The application and database have separate containers; PostgreSQL is not published to the host network.

1. Copy `.env.example` to `.env` and replace `POSTGRES_PASSWORD` with a long URL-safe random password. If Node is installed, `npm run setup:env` creates the file securely for you and preserves existing settings.
2. For public hosting, set `BASE_URL` to the exact public HTTPS origin and place the app behind your TLS reverse proxy. Defaults bind only to localhost.
3. Run:

```sh
docker compose up -d --build
docker compose exec signhere cat /data/setup-token
```

Open `http://localhost:3000`, create your account and enter the installation key. Setup closes after the first owner exists. Keep `.env` private. The installation key is not printed in application logs.

Persistent named volumes hold PostgreSQL data and the app's setup state. `docker compose down` preserves them. Do not use `down -v` unless you intend to delete the installation's persistent data.

This machine cannot run Docker, so the Compose configuration is statically validated; container execution must be verified on a working Docker host. The app is tested directly against real PostgreSQL locally.

## Deploy with Coolify (GitHub → Docker Compose)

Coolify builds the image from this repository and runs the app and PostgreSQL from `docker-compose.yaml`. Coolify's proxy terminates TLS; nothing else needs to be exposed.

1. **DNS:** point a hostname, e.g. `sign.example.com`, at your Coolify server.
2. **Create the resource:** in Coolify choose *Project → New → Resource → Private Repository (with GitHub App)*, or *Public Repository*, then select this repository and the `main` branch. Set *Build Pack* to **Docker Compose**; the default *Docker Compose Location* `/docker-compose.yaml` is correct.
3. **Environment variables:** set two under *Environment Variables*, before the first deploy:

   | Variable | Value |
   |---|---|
   | `POSTGRES_PASSWORD` | A long random URL-safe value, e.g. from `openssl rand -hex 32`. Don't change it after the first deploy; the database keeps the original. |
   | `BASE_URL` | The exact public origin, e.g. `https://sign.example.com`, with no trailing slash. Requests from any other origin are rejected. |

   That's all. PostgreSQL runs inside the same stack, so there is no connection string to set. `TRUST_PROXY` defaults to `uniquelocal`, which trusts Coolify's proxy on the private Docker network so the audit trail records visitors' real IPs. Leave `PORT` and `BIND_ADDRESS` at their defaults; change `PORT` only if host port 3000 is already taken.
4. **Domain:** on the `signhere` service, set *Domains* to `https://sign.example.com:3000`. The `:3000` tells the proxy which container port to route to; it is not part of the public URL. Leave the `postgres` service without a domain.
5. **Deploy**, and wait for the health check to turn green.
6. **Create the owner account:** open the `signhere` container's *Terminal* in Coolify (or run `docker exec <container> cat /data/setup-token` on the server) and run:

   ```sh
   cat /data/setup-token
   ```

   Then open `https://sign.example.com`, create your account, and enter that installation key. Setup closes once the first owner exists.

**Updates:** with the GitHub App, turn on *Auto Deploy* so every push to `main` rebuilds and redeploys. The named volumes, `postgres-data` and `signhere-data`, survive redeploys. Don't delete the resource's volumes unless you intend to wipe the installation.

**Backups:** all documents live in PostgreSQL. Schedule the `pg_dump` command from [Backups and restore](#backups-and-restore) against the `postgres` service, for example with Coolify's *Scheduled Tasks*, and copy the dumps off the server.

## Development without Docker

Use Node.js 22.16+ (24 LTS recommended) and PostgreSQL 17+. Set `DATABASE_URL` to a dedicated application database owned by a non-superuser role. Do not use a shared production database for development.

```sh
npm ci
npm run dev
```

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

Integration tests require `TEST_DATABASE_URL` (or a dedicated development `DATABASE_URL`). Tests create isolated schemas and exercise real database transactions. CI provisions PostgreSQL and additionally builds the Docker image.

## Backups and restore

All document bytes and evidence live in PostgreSQL. Use PostgreSQL's consistent snapshot tooling, not a live filesystem copy of the database volume.

A local roundtrip test has restored a completed document and verified its evidence. With a `pg_dump` client matching your server and `DATABASE_URL` configured:

```sh
npm run backup -- backups/signhere.dump
```

The script does not overwrite existing backups or put credentials in command-line arguments. `PG_DUMP` can select a client binary. Store backups encrypted off-host and test restoring into a fresh, isolated database with `pg_restore`. Back up deployment configuration separately; future provider/sealing keys will also need an explicit backup policy.

For Docker, create a dump inside the database container, then copy it out (this avoids binary-output corruption in older Windows PowerShell):

```sh
docker compose exec postgres pg_dump -U signhere -d signhere -Fc -f /tmp/signhere.dump
docker compose cp postgres:/tmp/signhere.dump ./backups/signhere.dump
```

## Offline evidence verification

Export the JSON evidence and both PDFs from the document, then run:

```sh
npm run verify:evidence -- evidence.json original.pdf completed.pdf
```

For a converted document, `original.pdf` means the prepared signing PDF. Add the preserved upload as a fourth argument (`uploaded.pdf`) to verify its source digest too; otherwise the verifier explicitly reports that the pre-conversion upload was not checked.

The verifier recomputes both file digests and every audit link, checks consent/document binding and completion, and compares the signing checkpoint. Keep a separate trusted copy of the files or checkpoint: an internally consistent forged export is not evidence of issuer authenticity.

## Evidence and security boundaries

The uploaded source bytes are retained unchanged. When conversion is needed, the static signing PDF has its own digest; the source digest and conversion details are bound into the initial audit event. The completed PDF is a newly generated artifact and has its own hash. An exported hash chain can be checked offline and compared with an independently retained copy. It is not a trusted timestamp, independently certified identity, or a PDF cryptographic signature. A privileged operator can rewrite local records.

Personal links grant access to signing and are credentials. Recipients should receive only their own link. Names are claims; a drawing and possession of a link do not establish verified identity. Network metadata describes the observed connection and is not identity proof.

Before real production use, complete independent security and legal review, establish retention/erasure procedures, validate backup restoration, set storage/concurrency limits, and decide which contract types require stronger authentication or qualified signatures. These are tracked release requirements, not promises made by the current interface.

- [Architecture](docs/architecture.md)
- [Signing methods and future provider integrations](docs/signing-methods.md)
- [DocuSeal, Documenso, OpenSign and legal-source research](docs/research.md)
- [Claude Opus 5.5 architecture review](docs/claude-review.md)

## License and contribution

Application code is AGPL-3.0-only; see `LICENSE`. If you modify the application and offer it to users over a network, provide the corresponding source as required by that license. Dependencies retain their own licenses. Competitor projects were researched as references; their source code was not copied.

The `design/prototype` folder preserves the supplied design reference and is excluded from the runtime image. Changes to legal or identity claims in the prototype were intentional: the interface must describe evidence the backend actually produces.
