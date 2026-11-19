#!/usr/bin/env bash
# Test des automatischen Datenbank-Backups gegen eine frische, isolierte Instanz (eigenes Compose-Projekt, eigene Volumes):
#   Testdaten anlegen → Backup → Datenbank komplett verlieren → Wiederherstellung → Inhalt identisch, Anmeldung klappt.
#   Außerdem: Backup ist verschlüsselt, falscher Schlüssel ändert nichts, laufende Anwendung blockiert die
#   Wiederherstellung, Aufbewahrung löscht nur ältere Backups.
# Voraussetzungen wie bei tests/security/run.sh (Docker, Node.js 24, npm ci in web/, Image bastion:latest).
# Das Backup-Image wird gebaut. Die Instanz wird am Ende samt Volumes entfernt (KEEP=1 lässt sie stehen).
set -euo pipefail

cd "$(dirname "$0")/../.."           # Hauptverzeichnis des Repos
# Git Bash unter Windows: Pfade im Container (/backups/…) nicht in Windows-Pfade umschreiben
export MSYS2_ARG_CONV_EXCL='/backups'
PROJECT=${PROJECT:-bastion-backuptest-ci}
WORK=$(mktemp -d)
ENV_FILE="$WORK/env"
KEY="$WORK/key.txt"
WRONG_KEY="$WORK/wrong.txt"
COMPOSE=(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f compose.yml -f tests/security/compose.test.yml)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then "${COMPOSE[@]}" logs --no-color backup bastion migrate | tail -n 80 || true; fi
  if [ "${KEEP:-0}" != "1" ]; then "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FEHLGESCHLAGEN: $*" >&2; exit 1; }
rand() { node -e "console.log(require('crypto').randomBytes($1).toString('$2'))"; }
psql_db() { "${COMPOSE[@]}" exec -T db psql -U bastion -d "${2:-bastion}" -v ON_ERROR_STOP=1 -At -c "$1"; }
backup_files() { "${COMPOSE[@]}" exec -T backup sh -c 'ls -1 /backups/bastion-*.dump.age 2>/dev/null || true'; }
wait_health() {
  for _ in $(seq 1 60); do curl -fs http://127.0.0.1:13000/api/health >/dev/null 2>&1 && return 0; sleep 2; done
  fail "Anwendung nicht erreichbar"
}

# Prüfsumme über den Inhalt aller Tabellen (Reihenfolge-unabhängig). Ausgenommen ist die Statusmeldung des Backup-Dienstes:
# Er schreibt sie erst nach dem Dump, sie kann im Backup also nie dem Stand danach entsprechen.
fingerprint() {
  local t out="" where
  for t in $(psql_db "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"); do
    where=""
    [ "$t" = "system_settings" ] && where="WHERE x.key <> 'backup.database'"
    out+="$t $(psql_db "SELECT count(*) || ' ' || md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM \"$t\" x $where")"$'\n'
  done
  printf '%s' "$out"
}

backup_report() { psql_db "SELECT coalesce(value->>'$1', '') FROM system_settings WHERE key = 'backup.database'"; }

INITIAL=$(rand 18 hex)
cat > "$ENV_FILE" <<EOF
APP_SECRET=$(rand 48 base64)
POSTGRES_PASSWORD=$(rand 32 hex)
APP_DB_PASSWORD=$(rand 32 hex)
INITIAL_ADMIN_PASSWORD=Init-$INITIAL
HIBP_ENABLED=false
EMERGENCY_BACKUP_PATH=
BACKUP_PATH=
BACKUP_KEEP=2
EOF

step "Backup-Image bauen, Schlüssel erzeugen"
docker build -q -t "${BASTION_TEST_BACKUP_IMAGE:-bastion-backup:latest}" backup >/dev/null
"${COMPOSE[@]}" run --rm -T backup keygen > "$KEY" 2>/dev/null
"${COMPOSE[@]}" run --rm -T backup keygen > "$WRONG_KEY" 2>/dev/null
RECIPIENT=$(grep -o 'age1[0-9a-z]*' "$KEY" | head -1)
[ -n "$RECIPIENT" ] || fail "keygen lieferte keinen öffentlichen Schlüssel"
grep -q '^AGE-SECRET-KEY-' "$KEY" || fail "keygen lieferte keinen privaten Schlüssel"

step "Ohne Schlüssel wird nicht gesichert"
if "${COMPOSE[@]}" run --rm -T backup now >/dev/null 2>&1; then fail "Backup ohne BACKUP_AGE_RECIPIENTS darf nicht laufen"; fi
echo "BACKUP_AGE_RECIPIENTS=$RECIPIENT" >> "$ENV_FILE"

step "Instanz starten und Testdaten anlegen"
"${COMPOSE[@]}" up -d --no-build bastion
wait_health
node web/node_modules/vite/bin/vite.js build --config tests/security/vite.crypto.config.mjs
BASTION_INITIAL_ADMIN_PASSWORD="Init-$INITIAL" node tests/security/seed.mjs
node tests/backup/verify.mjs record "$WORK/items.json"

step "Backup-Dienst starten: erstes Backup sofort"
"${COMPOSE[@]}" up -d --no-build backup
for _ in $(seq 1 30); do [ -n "$(backup_files)" ] && break; sleep 2; done
FIRST=$(backup_files | head -1)
[ -n "$FIRST" ] || fail "Kein Backup nach dem Start des Dienstes"
"${COMPOSE[@]}" exec -T backup bastion-backup health | grep -q ok || fail "Healthcheck meldet nicht ok"
BEFORE=$(fingerprint)
[ "$(printf '%s\n' "$BEFORE" | awk '$2 > 0' | wc -l)" -ge 8 ] || fail "Zu wenige gefüllte Tabellen für einen aussagekräftigen Test"

step "Backup ist verschlüsselt"
"${COMPOSE[@]}" exec -T backup head -c 22 "$FIRST" | grep -q '^age-encryption.org/v1' || fail "Kein age-Format"
if "${COMPOSE[@]}" exec -T backup grep -aqE 'sysadmin@sectest|audit_logs|CREATE TABLE' "$FIRST"; then fail "Klartext im Backup"; fi

step "Aufbewahrung: nur die neuesten BACKUP_KEEP=2 bleiben"
# Zeitstempel im Dateinamen hat Sekundenauflösung
sleep 1.1; "${COMPOSE[@]}" exec -T backup bastion-backup now
sleep 1.1; "${COMPOSE[@]}" exec -T backup bastion-backup now
[ "$(backup_files | wc -l)" -eq 2 ] || fail "Erwartet 2 Backups, gefunden: $(backup_files | wc -l)"
backup_files | grep -qF "$FIRST" && fail "Ältestes Backup wurde nicht entfernt"
LATEST=$(basename "$(backup_files | tail -1)")

step "Der Dienst meldet seinen Stand an Bastion (Anzeige für System-Admins)"
[ "$(backup_report configured)" = "true" ] || fail "Meldung: configured fehlt"
[ "$(backup_report lastFile)" = "$LATEST" ] || fail "Meldung: lastFile ist '$(backup_report lastFile)', erwartet $LATEST"
[ "$(backup_report count)" = "2" ] || fail "Meldung: count ist '$(backup_report count)', erwartet 2"
[ -n "$(backup_report lastSuccessAt)" ] || fail "Meldung: lastSuccessAt fehlt"
[ -z "$(backup_report lastError)" ] || fail "Meldung: unerwarteter Fehler '$(backup_report lastError)'"
if psql_db "SELECT value::text FROM system_settings WHERE key = 'backup.database'" | grep -q 'AGE-SECRET-KEY\|age1'; then fail "Meldung enthält Schlüsselmaterial"; fi

step "Wiederherstellung bei laufender Anwendung wird abgelehnt"
if "${COMPOSE[@]}" run --rm -T backup restore "$LATEST" < "$KEY"; then fail "Wiederherstellung trotz laufender Anwendung"; fi

step "Totalverlust: Anwendung stoppen, alle Daten löschen"
"${COMPOSE[@]}" stop bastion backup
psql_db "SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
[ "$(psql_db "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" = "0" ] || fail "Daten nicht gelöscht"

step "Falscher Schlüssel: Abbruch, Datenbank unverändert"
if "${COMPOSE[@]}" run --rm -T backup restore "$LATEST" < "$WRONG_KEY"; then fail "Wiederherstellung mit falschem Schlüssel"; fi
[ "$(psql_db "SELECT count(*) FROM pg_database WHERE datname = 'bastion_restore'")" = "0" ] || fail "Reste der fehlgeschlagenen Wiederherstellung"

step "Wiederherstellung mit dem richtigen Schlüssel"
"${COMPOSE[@]}" run --rm -T backup restore "$LATEST" < "$KEY"
AFTER=$(fingerprint)
if [ "$BEFORE" != "$AFTER" ]; then diff <(echo "$BEFORE") <(echo "$AFTER") || true; fail "Inhalt nach der Wiederherstellung weicht ab"; fi
[ "$(psql_db "SELECT count(*) FROM pg_database WHERE datname LIKE 'bastion_before_restore_%'")" = "1" ] || fail "Bisherige Datenbank nicht aufbewahrt"

step "Anwendung startet auf der wiederhergestellten Datenbank, Anmeldung und Tresor funktionieren"
"${COMPOSE[@]}" up -d --no-build bastion
wait_health
node tests/backup/verify.mjs compare "$WORK/items.json"

echo
echo "Backup-Test bestanden."
