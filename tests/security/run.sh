#!/usr/bin/env bash
# Sicherheits-Regressionstests gegen eine frische, isolierte Instanz (eigenes Compose-Projekt, eigene Volumes).
# Voraussetzungen: Docker, Node.js 24, installierte Abhängigkeiten in web/ (npm ci), gebautes Image bastion:latest
# (sonst mit BUILD=1 bauen lassen; BASTION_TEST_IMAGE=name:tag baut und nutzt ein eigenes Image statt bastion:latest). Die Instanz wird am Ende samt Volumes entfernt (KEEP=1 lässt sie stehen).
set -euo pipefail

cd "$(dirname "$0")/../.."           # Hauptverzeichnis des Repos
PROJECT=${PROJECT:-bastion-sectest-ci}
ENV_FILE=$(mktemp)
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f compose.yml -f tests/security/compose.test.yml)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then "${COMPOSE[@]}" logs --no-color bastion | tail -n 80 || true; fi
  if [ "${KEEP:-0}" != "1" ]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -f "$ENV_FILE"
  exit "$status"
}
trap cleanup EXIT

rand() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }
INITIAL=$(rand 18 hex)
cat > "$ENV_FILE" <<EOF
APP_SECRET=$(rand 48 base64)
POSTGRES_PASSWORD=$(rand 32 hex)
APP_DB_PASSWORD=$(rand 32 hex)
INITIAL_ADMIN_PASSWORD=Init-$INITIAL
HIBP_ENABLED=false
EMERGENCY_BACKUP_PATH=
EOF

# Nur das Anwendungs-Image (der Reverse-Proxy wird für die Tests nicht gestartet)
if [ "${BUILD:-0}" = "1" ]; then docker build -t "${BASTION_TEST_IMAGE:-bastion:latest}" .; fi
"${COMPOSE[@]}" up -d --no-build bastion

echo "Warte auf die Testinstanz ..."
for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:13000/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fs http://127.0.0.1:13000/api/health >/dev/null

# Datenbank-Container für Tests, die einen Angreifer mit Schreibzugriff auf die Datenbank nachstellen (key-proof.test.mjs)
export BASTION_TEST_DB_CONTAINER=$("${COMPOSE[@]}" ps -q db)
# Anwendungs-Container für Tests, die einen Neustart brauchen (login-protection.test.mjs)
export BASTION_TEST_APP_CONTAINER=$("${COMPOSE[@]}" ps -q bastion)

node web/node_modules/vite/bin/vite.js build --config tests/security/vite.crypto.config.mjs
BASTION_INITIAL_ADMIN_PASSWORD="Init-$INITIAL" node tests/security/seed.mjs
node --test --test-concurrency=1 tests/security/*.test.mjs
