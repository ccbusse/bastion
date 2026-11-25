# Developing Bastion

Architecture, local development, building and releasing. Please also read [CONTRIBUTING.md](../CONTRIBUTING.md). [Deutsche Fassung](DEVELOPMENT.de.md)

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

