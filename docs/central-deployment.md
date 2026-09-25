# Running the central trust service (signhere.prpl.se → signhere.se)

The central service is optional. Self-hosted installations do not need it, and installations whose participants use BankID do not need it at all. It adds one thing: participants without BankID can confirm their email address and approve the exact document at a party independent of the installation operator, and receive a signed receipt that verifies offline. Protocol and guarantees: [central-protocol.md](central-protocol.md).

What the service stores: installation accounts (name, origin, hashed API keys) and short-lived approval rows (email address, claimed name, title, document/intent/policy hashes, state, the issued receipt). It never receives PDFs, drawings or audit logs. Rows are deleted `CENTRAL_RETENTION_DAYS` (default 30) after they close or expire.

## 1. Server and DNS

- A small Linux host with Docker (1 vCPU / 1 GB is plenty for a beta).
- DNS: `signhere.prpl.se` → the host.
- A TLS reverse proxy (Caddy, Traefik/Coolify, nginx) forwarding to `127.0.0.1:3100`. Caddy example:

  ```
  signhere.prpl.se {
      reverse_proxy 127.0.0.1:3100
  }
  ```

- Outbound SMTP (or a Resend account) for confirmation codes, with SPF/DKIM for the sender domain so codes are not marked as spam.

Serve nothing else on this hostname (no analytics, marketing scripts or admin panels): the approval page's security depends on the origin containing only this service.

## 2. Configure and create keys

```sh
git clone https://github.com/sawariz0r/signhere && cd signhere/deploy/central
cp .env.example .env         # set CENTRAL_ORIGIN, CENTRAL_DATABASE_PASSWORD and mail settings
docker compose build
docker compose run --rm central node dist/server/central/admin.js keys init --service https://signhere.prpl.se
```

`keys init` prints the **trust root public key** (43 characters). Then:

1. Put it in `.env` as `CENTRAL_TRUST_ROOT=…`.
2. Publish it through a channel other than the service itself, e.g. commit it to the repository README and include it in release notes. Installations and verifiers pin this value.
3. Copy the root private key out of the volume and store it offline (password manager / encrypted USB), then delete it from the server:

   ```sh
   docker compose run --rm central sh -c 'cat /keys/root.pem' > root.pem   # store offline, then:
   docker compose run --rm central rm /keys/root.pem
   ```

   The running service only needs `trust-bundle.jws` and the receipt key. The root is needed again only for `keys rotate` / `keys revoke`.

4. Back up the `central-keys` volume (receipt key + bundle) encrypted. Losing the receipt key is recoverable by rotation (old receipts stay verifiable); losing the root means every installation must pin a new root.

## 3. Start

```sh
docker compose up -d
curl https://signhere.prpl.se/v1/health
curl https://signhere.prpl.se/.well-known/signhere-trust.json
```

Open `https://signhere.prpl.se/` (landing page) and `/verifiera` (receipt checker).

## 4. Connect an installation

On the central host:

```sh
docker compose run --rm central node dist/server/central/admin.js instance create --name "Exempel AB" --origin https://sign.exempel.se
```

The origin must be the installation's exact `BASE_URL`. The command prints an API key once. On the installation, set:

```
SIGNHERE_CENTRAL_URL=https://signhere.prpl.se
SIGNHERE_CENTRAL_TRUST_ROOT=<root public key>
SIGNHERE_CENTRAL_API_KEY=shc_…        # or SIGNHERE_CENTRAL_API_KEY_FILE=/run/secrets/…
```

and restart it. Senders then see "Kräv oberoende bekräftelse via signhere.prpl.se" when creating a document. Nothing changes for documents that do not tick it, and nothing is sent to the service for them.

Other admin commands: `instance list`, `instance key <id> [--revoke-others]` (rotate API key), `instance suspend|activate <id>` (blocks new approvals; issued receipts stay valid).

## 5. Key rotation and incidents

```sh
# temporarily restore root.pem into the volume first
docker compose run --rm central node dist/server/central/admin.js keys rotate
docker compose run --rm central node dist/server/central/admin.js keys revoke <kid> --at 2026-10-01T00:00:00Z
docker compose restart central
```

Rotation retires the current receipt key after a grace period (`--grace-hours`, default 24) and activates a new one; restart the service within that period. Installations pick up the new bundle automatically. Revocation is for a suspected key compromise: receipts from that key stop being trusted by anyone using the new bundle, so tell affected installations. Remove `root.pem` from the server again afterwards.

## 6. Moving from signhere.prpl.se to signhere.se

Receipts name the service origin they were issued under, and documents freeze the service URL at creation. So:

- Keep `signhere.prpl.se` running (or at least serving `/.well-known/signhere-trust.json`) until documents created against it are completed; afterwards their receipts verify offline without the service.
- Run `signhere.se` as a new deployment with its own `keys init` (a new root, published the same way), or deliberately reuse the root by copying `root.pem` and creating a bundle for the new origin. Reusing the root is simpler for verifiers; a new root keeps the two services fully separate. Either is valid; decide before launch.
- Installations switch by changing `SIGNHERE_CENTRAL_URL` (and the root if it changed). Pending documents keep their frozen service; new documents use the new one.

## Operational notes

- Logs never contain email addresses, codes, capabilities or document hashes.
- Rate limits: 60 participant requests/min/IP, 10 code requests/15 min/IP, 600 API requests/min/IP, and at most 2000 open approvals per installation.
- The database user owns its schema; a separate restricted runtime role (as the installation uses) is a later hardening step.
- Not yet in place for production claims: HSM/KMS custody of the receipt key, an external security review, and a legal/privacy review of retention (see the backlog, CEN-006/010/012).
