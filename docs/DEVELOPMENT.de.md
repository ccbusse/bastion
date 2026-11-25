# Bastion entwickeln

Architektur, lokale Entwicklung, Bauen und Veröffentlichen. Bitte auch [CONTRIBUTING.md](../CONTRIBUTING.md) lesen. [English version](DEVELOPMENT.md)

## Architektur

```
Browser (React + WebCrypto + Argon2id/WASM)
   │  nur verschlüsselte Daten + Auth-Hash
   ▼
Caddy (TLS 1.2+/1.3, HTTP/2)  ──►  Bastion API (ASP.NET Core) ──►  PostgreSQL 17
                                     · Sessions (HttpOnly, SameSite=Strict)
                                     · Rechteprüfung, Audit-Hash-Kette
```

| Verzeichnis | Inhalt |
|---|---|
| `server/` | API in C# (.NET 10, ASP.NET Core, Entity Framework Core), SQL-Migrationen unter `src/Bastion.Server/Data/Migrations/`, Unit-Tests unter `tests/` |
| `caddy/` | Reverse-Proxy (eigenes Debian-Image, Caddyfile) |
| `backup/` | Automatisches, verschlüsseltes Datenbank-Backup (pg_dump + age) und Wiederherstellung |
| `scripts/` | `release.sh`: neue Version vorbereiten (siehe Entwicklung) |
| `web/` | React-Client, Kryptografie unter `web/src/lib/crypto/` |
| `branding/` | Logo (hell/dunkel, Icon und Wortmarke) |
| `docs/SECURITY.md` | Sicherheitskonzept, BSI-Bezug, bekannte Grenzen |

## Entwicklung

PostgreSQL bereitstellen, zum Beispiel per Docker:

```bash
docker run -d --name bastion-devdb -e POSTGRES_USER=bastion -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=bastion -p 55432:5432 postgres:17-trixie
```

Server (in `server/`, benötigt das .NET-10-SDK). `migrate` legt das Schema an und richtet das eingeschränkte Konto ein (benötigt `APP_DB_PASSWORD`); in der Entwicklung kann der Server danach auch mit dem Eigentümer-Konto laufen:

```bash
dotnet run --project src/Bastion.Server -- migrate
dotnet run --project src/Bastion.Server
```

Unit-Tests: `dotnet test`. Neue Migrationen: Datenmodell in `src/Bastion.Server/Data/` ändern, mit `dotnet run --project src/Bastion.Server -- schema` das SQL des Modells ausgeben und die Änderung als nächste nummerierte Datei in `Data/Migrations/` ablegen.

Benötigte Umgebungsvariablen für den Server: `DATABASE_URL`, `APP_SECRET`, `PUBLIC_URL=http://localhost:5173`, `ALLOWED_ORIGINS=http://localhost:5173` und `COOKIE_SECURE=false`.

Web-Client (in `web/`) mit Vite-Proxy auf Port 3000:

```bash
npm install && npm run dev
```

### Version

Die Versionsnummer steht ausschließlich in der Datei `VERSION` (Semantic Versioning). Server und Web-Client übernehmen sie beim Bauen. Sie erscheint in der Seitenleiste, auf der Anmeldeseite, unter `/api/health` und mit Build-Datum und Git-Stand unter *Systemeinstellungen → Allgemein*.

### Selbst bauen

`compose.yml` lädt fertige Images. Für die Entwicklung baut `compose.build.yml` sie aus dem Quellcode (lokale Images `bastion:latest`, `bastion-caddy:latest`, `bastion-backup:latest`), den Git-Stand gibt `GIT_COMMIT` mit:

```bash
GIT_COMMIT=$(git describe --always --dirty) docker compose -f compose.yml -f compose.build.yml up -d --build
```

Dauerhaft für einen Entwicklungsordner in `.env`: `COMPOSE_PATH_SEPARATOR=:` und `COMPOSE_FILE=compose.yml:compose.build.yml`. Danach genügt `docker compose up -d --build`.

### Neue Version veröffentlichen

1. Änderungen in `CHANGELOG.md` unter *Unveröffentlicht* eintragen (mit *Hinweise zum Update*, wenn Betreiber etwas tun müssen).
2. `scripts/release.sh X.Y.Z` setzt die Version in `VERSION`, `web/`, `extension/` und `compose.yml`, macht aus *Unveröffentlicht* den Abschnitt der Version, committet und legt den Tag `vX.Y.Z` an.
3. `git push origin master && git push origin vX.Y.Z`. Der Workflow *Release* wartet auf die grüne CI des Commits, baut und prüft die Images (Trivy), veröffentlicht sie mit SBOM und Build-Herkunft in `ghcr.io`, signiert sie mit cosign und legt das GitHub-Release mit Installationspaket an.

