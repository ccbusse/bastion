<p align="center"><img src="branding/bastion-logo.svg" alt="Bastion" width="320"></p>

# Bastion – your self-hosted password vault

**Your keys. Your fortress.** Bastion is a self-hosted, **zero-knowledge** password vault for businesses and for private use: a company with departments, a small office, a club, a family or just yourself. Every item is encrypted in the browser; the server never sees passwords or master passwords.

[Deutsche Fassung: README.de.md](README.de.md)

## Who it is for

* **Businesses and organizations:** departments and folders, fine-grained roles, user invitations with fingerprint verification, audit log, account recovery by administrators, emergency backup for the worst case.
* **Private use:** one installation for yourself, your family or your household. Shared folders for things everyone needs (Wi-Fi, streaming, insurance), a personal vault for each person, two-factor authentication, browser extension.

Both run on the same software. Each organization or household is a separate, cryptographically isolated *tenant*, so one installation can serve several of them.

## Features

| Area | What you get |
|---|---|
| **Cryptography** | Argon2id (64 MiB, t=3, p=4), HKDF-SHA-256, AES-256-GCM with context binding (AAD), RSA-OAEP-4096, aligned with BSI TR-02102-1 |
| **First start** | Initial system admin with a one-time password, then your own master password |
| **Tenants** | System admins create tenants (a company, a family …); each tenant is cryptographically separated |
| **Structure** | Tenant → departments → folders, every folder with its own key |
| **Users** | Invitation by email → account setup → **confirmation by an admin comparing fingerprints** |
| **Permissions** | Roles with fine-grained rights at tenant, department and folder level, inheritance, per-folder override, delegation to managers without privilege escalation |
| **Master password** | Policy with length, character variety, zxcvbn strength, no personal data, check against known breaches (HIBP) |
| **MFA** | TOTP with recovery codes, can be made mandatory per tenant |
| **Recovery** | Tenant admins can reset master passwords without seeing plain text. Personal vaults are excluded |
| **Items** | Logins (with TOTP generator), secure notes, payment cards, bank accounts, SSH keys, API keys. Trash with restore (deleted for good after 30 days, configurable) |
| **Tools** | Password generator, security report (breached / weak / reused), import (Bitwarden, KeePass, CSV), encrypted export |
| **Backups** | Daily encrypted database backup, plus an **emergency backup** that opens offline without Bastion: key sheet **and** passphrase, offline tool as a single HTML file |
| **Audit** | Append-only audit log with hash chain and database trigger, integrity check with one click |
| **Help** | Built-in guides, a getting-started checklist per role and a short tour |
| **Operation** | Docker Compose: app, PostgreSQL 17, Caddy (automatic TLS) |
| **Languages** | German (default) and English |

## Installation

Requirements: Docker with Compose v2 on a Linux server (x86-64).

### Quick start

```bash
curl -fsSL https://github.com/ccbusse/bastion/releases/latest/download/install.sh | bash
```

The script creates a `bastion/` folder and downloads `compose.yml` and `.env.example` of the current release. It asks for your domain and ports (and an optional email for Let's Encrypt), generates all secrets in `.env` and, if you like, the key for the [database backup](#database-backup). Then it starts Bastion and shows the setup address with the initial password.

* A specific version instead of the latest: `…/releases/download/v2.4.1/install.sh`
* Without questions, e.g. for automation: `BASTION_DOMAIN=vault.example.com BASTION_BACKUP_KEY=yes bash install.sh` (all settings are listed at the top of the script)

To read the script first, download it and check it against `SHA256SUMS` from the same release:

```bash
curl -fsSLO https://github.com/ccbusse/bastion/releases/latest/download/install.sh
curl -fsSLO https://github.com/ccbusse/bastion/releases/latest/download/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS && less install.sh && bash install.sh
```

### Manual installation

Two files from the [GitHub release](https://github.com/ccbusse/bastion/releases) are all you need: `compose.yml` and the template `env.example`. The package `bastion-X.Y.Z.tar.gz` contains both (the template as `.env.example`) plus Caddyfile, license and docs. The images (`ghcr.io/ccbusse/bastion`, `bastion-caddy`, `bastion-backup`) are pulled ready-built.

```bash
mkdir bastion && cd bastion
curl -fsSLO https://github.com/ccbusse/bastion/releases/latest/download/compose.yml
curl -fsSL https://github.com/ccbusse/bastion/releases/latest/download/env.example -o .env
```

Then set at least `APP_SECRET`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `PUBLIC_URL` and `BASTION_DOMAIN` in `.env`. Bastion refuses placeholders containing `CHANGE_ME`. Generate secrets with:

```bash
openssl rand -base64 48
```

Use hex only for the database passwords, as they are part of the connection URL:

```bash
openssl rand -hex 32
```

`POSTGRES_PASSWORD` belongs to the owner account that only the one-off `migrate` service uses for migrations. The running application uses the restricted account `bastion_app` with `APP_DB_PASSWORD` (data access only, audit log append-only).

Start:

```bash
docker compose up -d
```

Read the initial password of the first admin from the log:

```bash
docker compose logs bastion
```

Then open `PUBLIC_URL/setup`, sign in as `admin` with the initial password and choose your own master password.

### Verify the images

Optional but recommended (requires [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)). The images are signed by this repository's release workflow; a tampered or foreign image fails this check.

```bash
for i in bastion bastion-caddy bastion-backup; do
  cosign verify "ghcr.io/ccbusse/$i:2.4.1" \
    --certificate-identity-regexp '^https://github.com/ccbusse/bastion/\.github/workflows/release\.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com > /dev/null && echo "$i: signature ok"
done
```

### Trying it locally

* With `BASTION_DOMAIN=localhost`, Caddy creates a self-signed certificate. Accept the browser warning once.
* Other ports (e.g. `HTTPS_PORT=8443`) must also appear in `PUBLIC_URL`: `PUBLIC_URL=https://localhost:8443`.

### Production

* `BASTION_DOMAIN=vault.example.com` and `PUBLIC_URL=https://vault.example.com`. With public DNS and open ports 80/443, Caddy obtains a Let's Encrypt certificate automatically. Optionally set `ACME_EMAIL=admin@example.com`: Let's Encrypt contacts you there if a certificate cannot be renewed.
* Requests over HTTP are redirected to `PUBLIC_URL` (including a non-standard HTTPS port).
* Behind a proxy that accepts HTTPS (e.g. HAProxy on pfSense, Nginx Proxy Manager), or with a domain that only exists in internal DNS: set `TLS_MODE=internal` (Caddy uses a certificate from its local CA instead of Let's Encrypt) and `TRUSTED_PROXIES` to the proxy's address or network (e.g. `10.8.10.1`, or `private_ranges`) so Bastion sees the real client IP. `install.sh` asks for this. The proxy must talk to Bastion over **HTTPS** on port 443 (pfSense: backend *Encrypt(SSL)* = yes, *SSL checks* = no); plain HTTP to port 443 ends in a redirect loop.
* Your own certificates: put your own `Caddyfile` next to `compose.yml` (template in the release package), add `tls /path/cert.pem /path/key.pem`, mount the files and uncomment the line `./Caddyfile:/etc/caddy/Caddyfile:ro` in `compose.yml`.
* Configure an SMTP server under *System settings → Email (SMTP)* and send a test mail. Without SMTP, Bastion shows invitation links for you to pass on manually.
* Backups: set up the automatic [database backup](#database-backup) **and** keep a copy of `.env` (above all `APP_SECRET`) somewhere else. Without `APP_SECRET`, TOTP secrets and the SMTP password can no longer be read. Vault contents do not depend on it.
* Use disk encryption on the host: names of tenants, departments and folders as well as email addresses are stored unencrypted in the database.

## Updating

Bastion follows [Semantic Versioning](https://semver.org/): patch versions (2.4.**x**) fix bugs, minor versions (2.**x**.0) add features, major versions (**x**.0.0) may require manual steps. New versions and their changes are listed in the [releases](https://github.com/ccbusse/bastion/releases) and in `CHANGELOG.md` (German). Watch the releases on GitHub (*Watch → Custom → Releases*) to hear about security updates.

1. Read the changelog sections of **all** versions since the installed one, especially *Hinweise zum Update* (update notes).
2. Create a backup first:

   ```bash
   docker compose exec backup bastion-backup now
   ```

3. Set the new version and restart. If the compose file, Caddyfile or `.env.example` change (the changelog says so), take them from the new release and keep your own `.env`.

   ```ini
   BASTION_VERSION=2.4.1
   ```

   ```bash
   docker compose pull && docker compose up -d
   ```

   The `migrate` service updates the database automatically at startup.
4. Check: `docker compose ps` (all services `healthy`) and the version at the bottom of the sidebar.

**Rolling back:** database migrations only run forward. An older version does not reliably start on a database that a newer version has changed. Always roll back together: set `BASTION_VERSION` to the old version, `docker compose pull`, then restore the backup from step 2 (see [database backup](#database-backup), *Restoring*). Changes since the update are lost.

The browser extension updates itself through the Chrome Web Store, independently of the server. Older and newer extensions work with every server of the same major version.

## First steps after setup

1. **System admin:** *System → Tenants → New tenant*, inviting the first tenant admin (for private use: yourself or a family member).
2. **Tenant admin:** accepts the invitation. The system admin confirms them under *Tenants → Admins* by comparing fingerprints.
3. **Tenant admin** signs in. The tenant keys (recovery and signing) are generated automatically.
4. **Tenant admin:** creates *Departments & folders* and invites users with a role and scope.
5. **New users** accept the invitation and see two fingerprints: their own key's and the organization keys'. A tenant admin compares both, confirms and thereby endorses the key. Only then are folder keys distributed automatically.
6. **System admins** who join a tenant receive keys only after a tenant admin explicitly endorses them under *Users → Endorsement pending*.

Inside Bastion, *Help & getting started* (bottom of the sidebar) walks you through these steps: a checklist per role that ticks itself off based on the actual state, a short tour and guides for every feature.

## Database backup

The `backup` service backs up the complete database daily (default 02:30) and at startup if the last backup is older than 24 hours. Every backup is encrypted with [age](https://age-encryption.org) for one or more **public** keys. The server therefore cannot read its own backups; the private key is only needed to restore and does not belong on the server. The newest `BACKUP_KEEP` backups are kept (default 14). If backups fail, older ones are not deleted.

The database backup protects operations: broken server, lost volume, operating errors. It contains everything, but is only partly usable without `APP_SECRET` (in `.env`). The [emergency backup](#emergency-backup) is something else: it makes approved vaults readable without Bastion.

**Setup**

1. Create a key pair:

   ```bash
   docker compose run --rm -T backup keygen > bastion-backup-key.txt
   ```

   The command prints the line `BACKUP_AGE_RECIPIENTS=age1…`; it goes into `.env`. The file `bastion-backup-key.txt` contains the private key: keep two copies offline in separate places (e.g. printed in a safe and on a USB stick) and delete it from the server. For several people in charge, create one key pair each and enter all public keys separated by spaces; each of them can restore.
2. Choose a target on **another disk** in `.env`, e.g. a mounted NAS share. The default is the Docker volume `db-backup` on the same host, which protects against operating errors but not against a server failure.

   ```bash
   sudo chown 1000:1000 /mnt/nas/bastion-db-backup
   ```

   ```ini
   BACKUP_PATH=/mnt/nas/bastion-db-backup
   ```

3. `docker compose up -d`. Check:

   ```bash
   docker compose ps backup        # "healthy": last backup younger than 26 hours
   docker compose logs backup
   docker compose run --rm backup list
   ```

   Without `BACKUP_AGE_RECIPIENTS` the service backs up nothing and reports `unhealthy`. An immediate backup: `docker compose exec backup bastion-backup now`.

   System admins also see the status in Bastion under *System settings* (last backup, errors, schedule). The service reports it to the database itself (table `system_settings`, key `backup.database`); the report contains no keys.

**Restoring**

Restoring loads the backup into a new database and swaps only afterwards. The previous database is kept as `bastion_before_restore_<timestamp>`; if anything fails (wrong key, damaged file), everything stays as it was. The backup must come from the same or an older Bastion version; `migrate` applies missing migrations at startup.

```bash
docker compose stop bastion
docker compose run --rm -T backup restore bastion-20261117T013000Z.dump.age < bastion-backup-key.txt
docker compose up -d
```

On a new server: set up Bastion with the saved `.env` (same `APP_SECRET`), copy the backup file into the backup directory, then proceed as above. Once everything is fine, delete the old database (the command is shown in the output of the restore).

CI runs the complete cycle on every commit (backup, total loss, restore, sign-in): `tests/backup/run.sh`.

## Emergency backup

An encrypted offline copy of all approved vaults for the worst case (details: [docs/SECURITY.md](docs/SECURITY.md), section 4a, German).

1. *System → Emergency backup*: set up the emergency key. Print the key sheet twice and keep it separate from the passphrase.
2. *Settings → Emergency backup*: a tenant admin of each tenant compares the fingerprint and approves.
3. Download backups manually or choose a target under *Automatic export → Add target*: **Windows share / NAS** (e.g. `\\NAS\Backup`), **Nextcloud** or **Hetzner Storage Box**, as well as SFTP, WebDAV or a folder on the server. Address, user, password and folder are enough; Bastion tests the connection when saving. Exports run after every change (after a quiet period) and daily; older versions are deleted after the configured number.
4. In an emergency, open `bastion-notfall-werkzeug.html` (included with every automatic export) offline in a browser, choose the backup file, enter the code from the key sheet and the passphrase.

Only the target *folder on the Bastion server* needs a Docker setting: Bastion writes to `/backup` inside the container. The default is the Docker volume `emergency-backup`; mount your own directory (e.g. a NAS share) with `EMERGENCY_BACKUP_PATH` in `.env`. It must be writable for UID 1000:

```bash
sudo chown 1000:1000 /mnt/nas/bastion-backup
```

## Permission model

* **Vault permissions** (tenant, department or folder level, inherited downwards):
  `vault.view` (overview only; secrets and their key are **not** transferred) ⊂ `vault.reveal` ⊂ `vault.edit` ⊂ `vault.manage`
* **Administrative permissions** (tenant level only): `tenant.admin`, `tenant.users.invite|confirm|manage`, `tenant.structure.manage`, `tenant.roles.manage`, `tenant.audit.read`, `tenant.settings.manage`
* **Folders without inheritance** (e.g. "Salaries"): only directly authorized users and tenant admins have access.
* **No privilege escalation:** nobody can grant permissions they do not have. Managers can delegate their folders or departments.
* Built-in roles: tenant administrator, manager, editor, reader, viewer, user management, auditor. Custom roles can be defined freely.

## Architecture

```
Browser (React + WebCrypto + Argon2id/WASM)
   │  encrypted data + auth hash only
   ▼
Caddy (TLS 1.2+/1.3, HTTP/2)  ──►  Bastion API (ASP.NET Core) ──►  PostgreSQL 17
                                     · sessions (HttpOnly, SameSite=Strict)
                                     · permission checks, audit hash chain
```

| Directory | Contents |
|---|---|
| `server/` | API in C# (.NET 10, ASP.NET Core, Entity Framework Core), SQL migrations in `src/Bastion.Server/Data/Migrations/`, unit tests in `tests/` |
| `web/` | React client, cryptography in `web/src/lib/crypto/` |
| `extension/` | Browser extension (Chromium, Manifest V3) |
| `caddy/` | Reverse proxy (own Debian image, Caddyfile) |
| `backup/` | Automatic encrypted database backup (pg_dump + age) and restore |
| `scripts/` | `install.sh` (installation), `release.sh` (prepare a new version) |
| `tests/` | Security regression tests and the backup/restore test |
| `branding/` | Logo (light/dark, icon and wordmark) |
| `docs/SECURITY.md` | Security concept, BSI reference, known limits (German) |

## Development

Provide PostgreSQL, for example with Docker:

```bash
docker run -d --name bastion-devdb -e POSTGRES_USER=bastion -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=bastion -p 55432:5432 postgres:17-trixie
```

Server (in `server/`, requires the .NET 10 SDK). `migrate` creates the schema and sets up the restricted account (requires `APP_DB_PASSWORD`); in development the server can then also run with the owner account:

```bash
dotnet run --project src/Bastion.Server -- migrate
dotnet run --project src/Bastion.Server
```

Unit tests: `dotnet test`. New migrations: change the data model in `src/Bastion.Server/Data/`, print the model's SQL with `dotnet run --project src/Bastion.Server -- schema` and add the change as the next numbered file in `Data/Migrations/`.

Environment variables for the server: `DATABASE_URL`, `APP_SECRET`, `PUBLIC_URL=http://localhost:5173`, `ALLOWED_ORIGINS=http://localhost:5173` and `COOKIE_SECURE=false`.

Web client (in `web/`) with Vite proxy to port 3000:

```bash
npm install && npm run dev
```

### Version

The version number lives only in the file `VERSION` (Semantic Versioning). Server and web client pick it up at build time. It appears in the sidebar, on the sign-in page, at `/api/health` and, with build date and Git revision, under *System settings → General*.

### Building it yourself

`compose.yml` pulls ready-built images. For development, `compose.build.yml` builds them from source (local images `bastion:latest`, `bastion-caddy:latest`, `bastion-backup:latest`); `GIT_COMMIT` passes the Git revision:

```bash
GIT_COMMIT=$(git describe --always --dirty) docker compose -f compose.yml -f compose.build.yml up -d --build
```

To make this permanent for a development folder, put `COMPOSE_PATH_SEPARATOR=:` and `COMPOSE_FILE=compose.yml:compose.build.yml` into `.env`. Afterwards `docker compose up -d --build` is enough.

### Publishing a new version

1. Add changes to `CHANGELOG.md` under *Unveröffentlicht* (with *Hinweise zum Update* if operators need to act).
2. `scripts/release.sh X.Y.Z` sets the version in `VERSION`, `web/`, `extension/` and `compose.yml`, turns *Unveröffentlicht* into the version's section, commits and creates the tag `vX.Y.Z`.
3. `git push origin master && git push origin vX.Y.Z`. The *Release* workflow waits for green CI on that commit, builds and scans the images (Trivy), publishes them with SBOM and build provenance to `ghcr.io`, signs them with cosign and creates the GitHub release with the installation files.

## Browser extension

`extension/` contains the extension for Chromium browsers (Chrome, Edge, Brave, Opera; Manifest V3). It is published in the Chrome Web Store (unlisted): <https://chromewebstore.google.com/detail/bastion/fkdcleihlodonenjchpdcjmgfnpadono>. In Bastion, *Tools → Browser extension* links there and explains the setup.

Security principles:

* **Zero-knowledge:** the same crypto modules as the web client (`web/src/lib/crypto`); master password and keys never leave the device.
* **Separate session type:** the extension signs in with a bearer token (no cookies). Such sessions may only call explicitly allowed, read-only endpoints (`[AllowExtension]`); the server rejects everything else with `EXTENSION_NOT_ALLOWED`. They appear under *My account → Active sessions* and can be revoked there.
* **Minimal permissions:** host access only to the configured vault address, no persistent content script. Logins are filled only on click or with `Ctrl+Shift+L` (via `activeTab`), only in the top frame, only for exactly the same host as in the item (no subdomains) and only over HTTPS.
* **Storage:** token and decrypted keys live only in `chrome.storage.session` (memory, blocked for content scripts). Locks after inactivity (time from the system settings), when the computer locks and when the browser restarts. Copied values are cleared from the clipboard after 30 seconds.

Build locally:

```bash
cd extension && npm install && npm run build
```

Then load `extension/dist` in `chrome://extensions` with "Load unpacked" (developer mode).

## Contributing

Bug reports, ideas and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; it covers the development setup, the checks to run and the guidelines.

## Security

Please report vulnerabilities privately via GitHub's [private vulnerability reporting](https://github.com/ccbusse/bastion/security/advisories/new) (*Security → Report a vulnerability*), not in public issues. The security concept is described in [docs/SECURITY.md](docs/SECURITY.md) (German).

## License

Bastion is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). You may use, modify and share it. If you make a modified version available to others over a network, you must also make that version's source code available to them.
