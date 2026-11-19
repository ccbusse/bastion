# Contributing to Bastion

Thanks for your interest in Bastion! Bug reports, ideas, documentation fixes and code are all welcome. Bastion is a password vault, so please read the [security](#security-first) section before you start.

## Ways to contribute

* **Report a bug:** open an [issue](https://github.com/ccbusse/bastion/issues) with what you did, what you expected and what happened instead. Include the Bastion version (bottom of the sidebar or `/api/health`), your browser and, if relevant, `docker compose logs bastion`. Never post passwords, master passwords, `.env` contents, backup keys or real vault data.
* **Suggest a feature:** open an issue first and describe the use case. For larger changes, wait for feedback before writing code, so your work fits the design.
* **Improve the docs:** typo fixes and clarifications can go straight to a pull request.
* **Send code:** see below.

## Security first

**Do not report vulnerabilities in public issues.** Use GitHub's [private vulnerability reporting](https://github.com/ccbusse/bastion/security/advisories/new) (*Security → Report a vulnerability*). You will get a reply there, and a fix is coordinated before details become public.

Bastion is a zero-knowledge vault: the server must never see plain-text secrets or master passwords. Changes that touch cryptography, key handling, authentication, permissions, sessions or the audit log get an especially careful review. Please:

* keep all encryption and decryption in the browser (`web/src/lib/crypto/`, shared with the extension),
* use the existing crypto primitives instead of adding new libraries or algorithms,
* add or extend a test in `tests/security/` that proves the protection works (and fails without your change),
* explain the security reasoning in the pull request.

## Development setup

You need Docker with Compose v2, the .NET 10 SDK and Node.js 24.

The quickest way to run everything from source:

```bash
cp .env.example .env    # then set APP_SECRET, POSTGRES_PASSWORD, APP_DB_PASSWORD (see README)
GIT_COMMIT=$(git describe --always --dirty) docker compose -f compose.yml -f compose.build.yml up -d --build
```

For working on single parts (server with `dotnet run`, web client with `npm run dev`), see [Development](README.md#development) in the README.

| Part | Folder | Stack |
|---|---|---|
| Server / API | `server/` | C# (.NET 10, ASP.NET Core, Entity Framework Core) |
| Web client | `web/` | React, TypeScript, Vite, Tailwind CSS |
| Browser extension | `extension/` | React, TypeScript, Manifest V3 |
| Reverse proxy | `caddy/` | Caddy, built from source |
| Database backup | `backup/` | pg_dump + age |

## Checks before you open a pull request

CI runs all of these on every pull request; running them locally saves round trips.

```bash
# Server: build and unit tests
cd server && dotnet test

# Web client and extension: type check and build
cd web && npm ci && npm run typecheck && npm run build
cd extension && npm ci && npm run typecheck && npm run build

# Security regression tests (Docker; builds the image from your working tree)
cd web && npm ci && cd .. && BUILD=1 bash tests/security/run.sh

# Database backup and restore test (Docker)
bash tests/backup/run.sh
```

The security and backup tests start their own isolated Compose projects with random secrets and remove them afterwards; they do not touch a running installation. Details: [tests/security/README.md](tests/security/README.md).

## Guidelines

* **Small, focused pull requests.** One topic per pull request is much easier to review.
* **Both languages.** The interface is German (default) and English. Every user-visible text needs an entry in `web/src/i18n/de.ts` **and** `web/src/i18n/en.ts` (TypeScript checks that both have the same keys). The same applies to the in-app help in `web/src/help/de.ts` and `en.ts`. If you only speak one of the languages, say so in the pull request and we will help with the other.
* **Database changes** go into a new numbered SQL file in `server/src/Bastion.Server/Data/Migrations/`. Migrations only run forward; never edit one that has been released.
* **Changelog:** add a line under *Unveröffentlicht* in `CHANGELOG.md` for anything users or operators notice. German is preferred, English is fine.
* **Style:** follow the surrounding code. Comments explain *why*, not *what*. Keep dependencies to a minimum; every new package becomes part of what has to be trusted.
* **No secrets or personal data** in code, tests, screenshots or commits. Use `example.com` / `*.test` addresses in tests.
* **Commits:** clear messages describing the change; one logical change per commit where practical.

## License

Bastion is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). By contributing, you agree that your contribution is licensed under the same terms.
