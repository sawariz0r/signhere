# Self-host Signhere

[Back to README](../README.md) · [Using Signhere](getting-started.md) · [Backups and recovery](deployment.md)

Use the repository's Docker Compose stack on Coolify or another Linux server. It includes the app, PostgreSQL and a one-time database upgrade job. PDF tools are bundled, and the installation creates its own sealing certificate. No central Signhere account is needed.

You'll need Docker Engine 23+ with Compose, and a Linux host with Landlock and seccomp support (kernel 5.13+ with Landlock enabled). For public access, you'll also need a domain and HTTPS. See [sandbox requirements](deployment.md#pdf-parser-boundary-in-the-linux-image) if the host reports a sandbox error.

This is a development preview. Check the [release validation status](sealing-implementation.md) before using it for important agreements.

## Coolify

1. Point your domain's DNS at your Coolify server.
2. Create an application from this Git repository (public repository or GitHub App). Choose the **Docker Compose** build pack and `/docker-compose.yaml` as the Compose file.
3. Before deploying, set these runtime environment variables:

   | Variable | Value |
   | --- | --- |
   | `POSTGRES_PASSWORD` | A long random password for database migrations. |
   | `APP_DATABASE_PASSWORD` | A different long random password for the app. |
   | `BASE_URL` | Your exact public origin, e.g. `https://sign.example.com`, without a trailing slash. |

   Run `openssl rand -hex 32` twice to generate separate URL-safe passwords. Replace any placeholder values. Keep passwords out of build-time variables; the image build doesn't need them.

4. In **Domains**, route HTTPS for your hostname to the **signhere** service on internal port **3000**. In a combined URL field, enter `https://sign.example.com:3000`. The public URL is still `https://sign.example.com`. Give PostgreSQL no public domain.
5. Deploy and wait for the app to become healthy. The `postgres-upgrade` job exits after success; this is expected.
6. Open the **signhere** container's terminal and retrieve the installation key:

   ```sh
   cat /data/setup-token
   ```

7. Open your public URL, create the first owner account and enter that key. First-owner setup then closes.

Coolify supplies the HTTPS proxy. Leave `BIND_ADDRESS` and `PORT` at their defaults. `TRUST_PROXY=uniquelocal` is the Compose default for proxies on private Docker networks; narrow it to your proxy's IPs or CIDRs if needed.

Keep both database passwords stable after the first deployment. Changing environment variables alone does not change passwords in an existing database.

For Coolify's current UI details, see its [Docker Compose guide](https://coolify.io/docs/applications/builds/docker-compose) and [domain configuration](https://coolify.io/docs/applications/configuration/general).

## Docker Compose

These commands use a Linux shell on your server and require Git.

### 1. Get the code and configure it

```sh
git clone https://github.com/sawariz0r/signhere.git
cd signhere
cp .env.example .env
chmod 600 .env
```

Edit `.env` before starting:

- Set `POSTGRES_PASSWORD` and `APP_DATABASE_PASSWORD` to **different** long random, URL-safe passwords. Run `openssl rand -hex 32` twice to generate them.
- For public hosting, set `BASE_URL` to your exact HTTPS origin, e.g. `https://sign.example.com`.
- Leave `BIND_ADDRESS=127.0.0.1` so port 3000 is only reachable locally on the host.

If Node.js is already installed, `npm run setup:env` can create `.env` with both passwords instead of copying the example. It preserves an existing file.

### 2. Start Signhere

```sh
docker compose up -d --build
```

Wait for the app to become healthy, then retrieve the installation key:

```sh
docker compose exec signhere cat /data/setup-token
```

For a local trial, keep `BASE_URL=http://localhost:3000` and open that address on the Docker host. For a public server, configure HTTPS below before creating your owner account. Enter the installation key during signup. Keep it private; it is not printed in application logs.

### 3. Set up HTTPS

Point your domain at the server and configure your reverse proxy to forward to `http://127.0.0.1:3000`. For example, with Caddy installed **on the same host**, use this Caddyfile:

```caddyfile
sign.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Replace the hostname, allow ports 80 and 443 to reach Caddy, and reload it. Caddy handles the HTTPS certificate. See [Caddy's reverse proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).

If your proxy runs in a container, attach it to the app's Docker network and route to `signhere:3000` instead. Set `TRUST_PROXY` to match the actual proxy addresses; the default trusts private network ranges. Keep PostgreSQL private.

### 4. Check the installation

Open your configured `BASE_URL`, create the owner account and send a disposable test document through the full signing flow. Check that you can download the completed PDF and find it through `/verify`.

`/api/health` checks app/database availability. `/api/ready` checks whether sealing is ready; a 503 there needs investigation even if the container is healthy.

## Optional email

Without email, copy and share signing links yourself. To send invitations and completed copies automatically, add these in Coolify or `.env`:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=sign@example.com
SMTP_PASSWORD=replace-with-smtp-password
SIGNHERE_MAIL_FROM=Signhere <sign@example.com>
```

Use your mail provider's values, then redeploy. SMTP requires TLS. Resend and SMTP URL configuration are also supported; see [email delivery](deployment.md#email-delivery) for details and troubleshooting.

## Updates and backups

Back up the database, private sealing keys and deployment settings together, encrypted and off-host. A database-only backup cannot restore the installation's ability to make new seals. Follow the [paired backup and restore guide](deployment.md#paired-encrypted-backups).

For Compose updates, after backing up:

```sh
git pull --ff-only
docker compose up -d --build
```

For Coolify, deploy the desired commit from the dashboard. Review changes before enabling automatic deployments on an installation holding real documents. Existing installations from before separate database roles need the [legacy upgrade guidance](deployment.md#upgrading-a-database-created-before-separate-roles).

Keep the existing database passwords when updating. Editing `.env` alone does not change them inside an existing database.

Keep the named volumes: `postgres-data` (documents and evidence), `signhere-keys` (private sealing keys), `signhere-data` (setup state), and `postgres-upgrade-backups` (legacy upgrade dumps). Redeploys and `docker compose down` preserve them. **`docker compose down -v` deletes persistent data.**
