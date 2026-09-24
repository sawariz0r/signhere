# Deployment, keys, and recovery

This is a local-sealing development preview until the Docker lifecycle/isolation CI and independent reader checks have passed on a working Linux host. Docker and the installed Ubuntu WSL distribution cannot run on the current development machine. Static configuration checks and Windows tests do not establish Linux sandbox or container execution success.

## Fresh Docker installation

The stack remains two services: Signhere and PostgreSQL. Python and the maintained PDF/CMS library are bundled inside the application image. There is no certificate purchase, certificate-generation command, central Signhere account, Redis, or separate worker service.

Run `npm run setup:env`, or copy `.env.example` and set **two different** long URL-safe random passwords: `POSTGRES_PASSWORD` for the schema owner/migrator and `APP_DATABASE_PASSWORD` for the application role. Keep the file private. Existing `.env` files are preserved; add the second value explicitly when upgrading an old configuration. Set `BASE_URL` to the exact public HTTPS origin and use a TLS reverse proxy for public access.

```sh
docker compose up -d --build
docker compose exec signhere cat /data/setup-token
```

Unsigned recipient links default to 7 days. Set `SIGNHERE_SIGNING_LINK_TTL_DAYS` to an integer from 1 to 365 to change the lifetime of new or rotated links. Acceptance changes the original capability to a 30-day read-only receipt with exact idempotent retries; it cannot accept a changed signature. Separate completed-copy links also expire after 30 days and can be revoked by the team.

The setup token is an administrator credential; enter it only into the first-owner setup form. It is not written to application logs.

Three persistent named volumes retain PostgreSQL data (`postgres-data`), existing setup state (`signhere-data`), and private sealing keys (`signhere-keys`). Keeping the small existing setup-state volume avoids moving or reinterpreting prior installations. Key files are in `/keys`, owned by the application UID with a private directory. Keys are never part of the image or database rows. `docker compose down` preserves the volumes; `down -v` deletes the installation and must not be used for ordinary updates.

A fresh database and empty key volume create a unique local identity. Existing database identity plus a missing or mismatched key is an operator-action condition, never permission to silently create another identity. Preserve read/download access while resolving it. Public certificate discovery is `/.well-known/signhere-sealing.json`; an independently retained fingerprint can be used for explicit issuer trust. Merely downloading that URL from the same server is not independent trust.

`/api/health` reports application/database availability and sealing state. `/api/ready` returns success only when this installation can seal; missing/unusable keys return 503 while read-only historical access remains available. Do not automatically restart or erase the installation because readiness fails. The image health check uses liveness to avoid restart loops during key recovery.

## Runtime database privileges

On a **fresh** PostgreSQL volume, `deploy/postgres/10-signhere-roles.sh` creates:

- `signhere_migrator`: non-superuser database/schema owner, used only for migrations through `MIGRATION_DATABASE_URL`.
- `signhere`: non-superuser runtime role with table SELECT/INSERT/UPDATE/DELETE, sequence access, and schema USAGE. It cannot create tables, change triggers, or grant itself privileges.
- `postgres`: bootstrap superuser whose network password is disabled after provisioning. Local container administration remains available for backups/restoration.

The default grants cover future tables created by the migrator. Migrations run through a separate pool and close it before ordinary application queries use the runtime pool. This separates SQL permissions; it is not protection from full application/container compromise when the deployment supplies migration credentials to that container. An operator requiring a stronger boundary must run migrations as a separate privileged deployment step and start the application without those credentials, once supported by the deployment workflow.

PostgreSQL initialization scripts do not rerun on an existing volume. Never delete a volume to make an upgrade appear to work. For an older installation, take a tested backup, inventory pending legacy documents, and perform the explicit schema/role upgrade on a restored copy first. Existing pending v1 documents retain the tested legacy completion path and remain unsealed; new documents use v2. Do not silently cancel, reassign, rewrite or retrospectively upgrade existing evidence. The old `signhere` database-owner role cannot be made a restricted runtime role merely by changing its password or setting a new connection URL. Ownership transfer, separate credentials, grants, and successful runtime DDL-denial checks are required. The fresh-install bootstrap script must not be run blindly against that database.

### Upgrading a database created before separate roles

Installations created with `POSTGRES_USER: signhere` have `signhere` as the PostgreSQL bootstrap superuser, and no `postgres` or `signhere_migrator` role. Symptoms: PostgreSQL logs `role "postgres" does not exist`, and Signhere refuses to start with "PostgreSQL rejected the migration or runtime login". PostgreSQL 16+ cannot demote a bootstrap superuser, so `deploy/postgres/upgrade-legacy-roles.sh` renames it to `postgres` (local socket only, network password removed), creates `signhere_migrator` with `POSTGRES_PASSWORD` and a new restricted `signhere` with `APP_DATABASE_PASSWORD`, moves ownership of the database and every application object to `signhere_migrator`, and applies the fresh-install grants. It verifies runtime DDL denial before committing; any failure rolls the whole transaction back. It refuses extensions or object kinds it does not move, and rerunning it after success changes nothing.

The one-shot `postgres-upgrade` Compose service runs this script on every deployment, and Signhere starts only after it exits successfully. On current installations it logs "nothing to upgrade". On a legacy database it logs in as the legacy superuser with `POSTGRES_PASSWORD` (the password the old compose file gave it). It first writes a `pg_dump` to the `postgres-upgrade-backups` volume, then upgrades. `.env` must set both passwords, and they must differ. Rehearse on a restored copy when the database holds real documents. To rerun it manually: `docker compose run --rm postgres-upgrade`.

If the legacy superuser's password no longer matches `POSTGRES_PASSWORD`, the service fails and the application stays stopped. Run the script inside the PostgreSQL container instead; the local socket needs no password:

```sh
docker compose stop signhere
docker compose exec -T postgres sh /usr/local/share/signhere/upgrade-legacy-roles.sh --confirm
docker compose up -d
```

On startup with `MIGRATION_DATABASE_URL`, Signhere refuses a runtime role that can create or own database objects.

## PDF parser boundary in the Linux image

The image builds `deploy/pdf-sandbox/launcher.c` with compiler warnings treated as errors. `SIGNHERE_PDF_SANDBOX_LAUNCHER` points at that executable; `SIGNHERE_REQUIRE_PDF_SANDBOX=true` requires it for parser operations. Linux Landlock (kernel 5.13+ with `landlock` in `/sys/kernel/security/lsm`) and seccomp filters must be available, and the container seccomp profile must allow the `landlock_*` syscalls (Docker Engine 23+ does by default). Unsupported kernels/policies fail closed with the errno, kernel release and a hint; do not disable the requirement to declare a production deployment ready. The startup probe logs the detected Landlock ABI.

Landlock ABI 1 (Linux 5.13-5.18) cannot grant cross-directory rename/link, so the kernel denies them all. ABI 1-2 (before Linux 6.2) do not control truncation, so the syscall filter denies `truncate(2)`, read-only `O_TRUNC` opens and `openat2` on every kernel; write opens and `ftruncate` remain governed by Landlock write access. Image code is root-owned so no permitted read path is writable by the parser, even without the read-only root filesystem.

The unprivileged launcher clears inherited application environment variables and file descriptors, applies no-new-privileges, and confines file access to image-owned public runtime/code plus one private job directory below `/tmp`. It denies reads/writes to `/keys`, `/data`, `/proc`, other jobs, and arbitrary host paths. Its syscall filter denies external network and Unix-service sockets/connections, ptrace/process-memory access, queued signals and resource-limit changes targeting other processes, new processes, namespace operations and io_uring. Filesystem metadata mutation syscalls (permissions, ownership, timestamps and extended attributes) are separately denied because Landlock alone does not cover all of them. An anonymous Unix socket pair is permitted because Python asyncio uses it internally; it does not provide a connection to external services. Runtime threads remain available.

Python parsing has a 768 MiB address-space limit, CPU and output bounds. Node/V8/WASM requires large virtual reservations and therefore has a 64 GiB **virtual-address** ceiling plus the worker's JavaScript heap limit. The Compose cgroup caps the entire application container at 768 MiB of resident/native memory. This is a container-wide exhaustion bound, not a claim that every native parser allocation is limited to a small per-job budget; an adversarial exhaustion can still terminate the application container. Parent deadlines and process cleanup remain necessary.

The key holder performs bounded signing operations separately from PDF parsing. This boundary protects sealing files from a compromised parser; it does not protect the key from compromise of the parent application or a privileged host operator. Landlock also does not conceal every filesystem metadata observation. The launcher is small and explicit but has not undergone an external security audit.

`scripts/test-pdf-sandbox.mjs` runs inside the actual image and checks both Python and Node startup, denied key/setup-file/parent-environment reads, inherited-secret descriptor closure, network/process denial, symlink/hardlink escape attempts, and writes outside a job. The Docker lifecycle CI additionally exercises real upload preparation, signing and verification with the required launcher. Cross-compilation alone is not execution evidence. Windows development runs outside this Linux boundary and must remain labeled as such.

## Paired, encrypted backups

The database contains all document bytes, immutable evidence, jobs, installation identity and historical public certificates. The private key volume is separate. A database dump alone restores historical files but cannot restore the same installation's ability to issue future seals. Keep a paired database/key backup and deployment settings. Historical PDF verification needs public certificates, not old private keys.

`npm run backup -- backups/signhere.dump` still creates a consistent database dump only. `BACKUP_DATABASE_URL` may select a backup connection; otherwise the script uses the migration or application connection. No password is put in command arguments. Preserve the corresponding keys separately.

For a simple coherent pair, pause application writes/key rotation by stopping the application, keep PostgreSQL running, export both volumes, and restart. The following **POSIX shell** example uses [age](https://age-encryption.org/) on the administrator's machine. It streams directly into encryption; no plaintext key archive is written. The passphrase is entered through age's terminal prompt, not the command line. Use separate strong passphrases or an offline age identity, and keep decryption credentials separately from the host and backups.

```sh
set -euo pipefail
umask 077
mkdir -p backups/paired-2026-09-24
docker compose stop signhere
docker compose exec -T postgres pg_dump -U postgres -d signhere -Fc --no-owner --no-acl \
  | age -p -o backups/paired-2026-09-24/database.dump.age
docker compose run --rm -T --no-deps --entrypoint tar signhere -C /keys -cf - . \
  | age -p -o backups/paired-2026-09-24/keys.tar.age
age -p -o backups/paired-2026-09-24/deployment.env.age .env
docker compose start signhere
```

If any export fails, keep the partial pair labeled unusable, resolve the failure, and restart the application deliberately. Do not overwrite a known good pair. Age recipient-based encryption is suitable for unattended backups because only the public recipient key needs to be on the server. Copy the encrypted pair off-host and test restoration regularly. These binary pipelines should run over SSH/WSL on a working POSIX shell; older Windows PowerShell pipelines can corrupt binary output.

Restore into an **isolated new Compose project with empty volumes**, using its own deployment passwords and port. Preserve a record of the original installation ID/certificate fingerprint and compare them after restore. The commands below assume the new project's `.env` and image are already prepared. Do not run them against the live database or a nonempty key volume.

```sh
set -euo pipefail
docker compose up -d --wait postgres
age -d /secure-backups/database.dump.age \
  | docker compose exec -T postgres pg_restore -U postgres -d signhere \
      --role=signhere_migrator --no-owner --no-acl --exit-on-error
docker compose run --rm -T --no-deps --entrypoint node signhere \
  -e 'if(require("node:fs").readdirSync("/keys").length) throw Error("Key restore target is not empty")'
age -d /secure-backups/keys.tar.age \
  | docker compose run --rm -T --no-deps --entrypoint tar signhere -C /keys -xf -
docker compose up -d --wait signhere
```

Use only your own authenticated backup archives. Successful restoration means: old PDF/evidence bytes still verify, installation ID and certificate fingerprint match the saved reference, restricted runtime permissions remain in effect, and a new disposable test document seals. The CI restore test uses generated test-only keys; it does not back up or manipulate user documents.

## Lost keys, rotation, and optional external services

A missing key and a stolen key are different incidents. Do not remove the database identity marker, overwrite the old key volume, or restart with empty volumes to bypass either condition. Restore a matching backup or use the explicit identity-preserving recovery/rotation workflow. Use the administrator CLI to inspect status before selecting the appropriate operation:

```sh
docker compose exec signhere node scripts/sealing-keys.mjs status
docker compose exec signhere node scripts/sealing-keys.mjs rotate
docker compose exec signhere node scripts/sealing-keys.mjs recover-lost-key
docker compose exec signhere node scripts/sealing-keys.mjs retry-with-current-key DOCUMENT_UUID
```

Native installations can use `npm run sealing:keys -- status` and the same subcommands. These are explicit alternatives, not a sequence to run blindly. Ordinary rotation verifies the old local key; lost-key recovery is a deliberate exception. For an imported certificate, rotation adopts the newly configured certificate. `retry-with-current-key` requeues only a job needing operator action and explicitly clears its pinned failed key identity; it preserves accepted participant approvals and the frozen protection policy. Retain old public certificate metadata for historical verification; record the change and distribute the new fingerprint through an independent channel. For suspected theft, investigate the compromise and communicate the affected identity/time period; routine lost-key recovery does not revoke a thief's copy.

Certificate or timestamp-provider settings are administrator options. The current local profile has no trusted timestamp. Required timestamping must never silently fall back to a local clock; it remains a separate milestone. BankID credentials and participant signing evidence are also separate from the platform's PDF certificate and the website's HTTPS certificate.

Optional certificate inputs use `SIGNHERE_SEAL_P12_FILE` and `SIGNHERE_SEAL_PASSWORD_FILE` file paths. Both inputs must be regular files, not symlinks, owned by the application UID with no group/other permission bits (0400 or 0600). The key directory and its subdirectories must be owned by that UID with mode 0700. Supply certificate inputs through read-only secret mounts; do not put private keys or literal certificate passwords in `.env`, image layers, logs or repository files. Back up external certificates/keys according to their provider's supported policy. A hardware/provider-held key may be intentionally non-exportable.
