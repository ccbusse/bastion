#!/usr/bin/env bash
# Bastion – automatisches, verschlüsseltes Datenbank-Backup
#
#   run                 Dienst: täglich um BACKUP_TIME sichern (beim Start sofort, wenn das letzte Backup älter als 24 h ist)
#   now                 sofort ein Backup erstellen
#   list                vorhandene Backups anzeigen
#   restore DATEI       Backup in eine neue Datenbank zurückspielen und gegen die aktuelle tauschen
#                       (privater Schlüssel über die Standardeingabe; die bisherige Datenbank bleibt erhalten)
#   keygen              neues Schlüsselpaar erzeugen (privaten Schlüssel offline aufbewahren)
#   health              Healthcheck: letztes erfolgreiches Backup nicht älter als 26 Stunden
#
# Konfiguration (Umgebung): PGHOST, PGUSER, PGPASSWORD, PGDATABASE (Eigentümer-Konto der Datenbank),
#   BACKUP_AGE_RECIPIENTS  öffentliche age-Schlüssel (age1…), mehrere durch Leerzeichen oder Komma getrennt
#   BACKUP_TIME            Uhrzeit HH:MM (Zeitzone TZ), Standard 02:30
#   BACKUP_KEEP            Anzahl aufbewahrter Backups, Standard 14 (die neuesten bleiben immer erhalten)
set -euo pipefail
umask 077

DIR=/backups
STATUS="$DIR/.last-success"
LOCK="$DIR/.lock"
DB=${PGDATABASE:-bastion}
BACKUP_TIME=${BACKUP_TIME:-02:30}
BACKUP_KEEP=${BACKUP_KEEP:-14}
MAX_AGE=$((26 * 3600))

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }
err() { log "FEHLER: $*" >&2; }

recipients() {
  local r out=()
  for r in ${BACKUP_AGE_RECIPIENTS//,/ }; do
    [[ $r == age1* ]] || { err "BACKUP_AGE_RECIPIENTS enthält keinen gültigen öffentlichen age-Schlüssel: ${r:0:12}…"; return 1; }
    out+=(-r "$r")
  done
  [ ${#out[@]} -gt 0 ] || { err "BACKUP_AGE_RECIPIENTS ist leer – ohne öffentlichen Schlüssel wird nicht gesichert (Einrichtung: https://github.com/ccbusse/bastion/blob/master/docs/OPERATIONS.de.md#datenbank-backup)"; return 1; }
  printf '%s\n' "${out[@]}"
}

validate_config() {
  [[ $BACKUP_TIME =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { err "BACKUP_TIME muss HH:MM sein, ist: $BACKUP_TIME"; return 1; }
  [[ $BACKUP_KEEP =~ ^[1-9][0-9]*$ ]] || { err "BACKUP_KEEP muss eine Zahl ≥ 1 sein, ist: $BACKUP_KEEP"; return 1; }
  recipients >/dev/null
}

backups() { find "$DIR" -maxdepth 1 -type f -name 'bastion-*.dump.age' -printf '%f\n' | sort; }

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Stand an Bastion melden (system_settings "backup.database"), damit System-Admins ihn in der Oberfläche sehen.
# Nur Anzeige: enthält keine Geheimnisse, und ein Fehler beim Melden beeinträchtigt das Backup nicht.
# Aufruf: report config | success DATEI GRÖSSE_KIB | failure MELDUNG
report() {
  local kind=$1 object
  case "$kind" in
    config) object="jsonb_build_object('configured', :'configured'::boolean, 'schedule', :'schedule', 'timezone', :'timezone', 'keep', :'keep'::int, 'count', :'count'::int, 'reportedAt', :'now')" ;;
    success) object="jsonb_build_object('lastAttemptAt', :'now', 'lastSuccessAt', :'now', 'lastFile', :'file', 'lastSizeKiB', :'size'::bigint, 'lastError', NULL, 'count', :'count'::int, 'reportedAt', :'now')" ;;
    failure) object="jsonb_build_object('lastAttemptAt', :'now', 'lastError', :'message', 'reportedAt', :'now')" ;;
    *) return 0 ;;
  esac
  local configured=false
  validate_config >/dev/null 2>&1 && configured=true
  PGOPTIONS='-c client_min_messages=warning' psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname="$DB" \
    -v configured="$configured" -v schedule="$BACKUP_TIME" -v timezone="${TZ:-$(date +%Z)}" -v keep="$BACKUP_KEEP" \
    -v count="$(backups | wc -l)" -v now="$(now_iso)" -v file="${2:-}" -v size="${3:-0}" -v message="${2:-}" >/dev/null 2>&1 <<SQL || true
INSERT INTO system_settings (key, value, updated_at) VALUES ('backup.database', $object, now())
ON CONFLICT (key) DO UPDATE SET value = system_settings.value || EXCLUDED.value, updated_at = now();
SQL
}

backup_now() {
  local args name tmp size
  recipients >/dev/null || { report failure "BACKUP_AGE_RECIPIENTS fehlt"; return 1; }
  mapfile -t args < <(recipients)
  exec 9>"$LOCK"
  flock -n 9 || { err "Es läuft bereits ein Backup"; return 1; }
  name="bastion-$(date -u '+%Y%m%dT%H%M%SZ').dump.age"
  tmp="$DIR/.$name.tmp"
  log "Backup startet: $name"
  if ! pg_dump --format=custom --compress=6 --dbname="$DB" | age "${args[@]}" -o "$tmp"; then
    rm -f "$tmp"; err "Backup fehlgeschlagen"; report failure "pg_dump oder Verschlüsselung fehlgeschlagen (docker compose logs backup)"; return 1
  fi
  size=$(stat -c %s "$tmp")
  if [ "$size" -lt 200 ]; then rm -f "$tmp"; err "Backup verdächtig klein ($size Bytes), verworfen"; report failure "Backup verdächtig klein ($size Bytes), verworfen"; return 1; fi
  mv "$tmp" "$DIR/$name"
  date +%s > "$STATUS"
  log "Backup fertig: $name ($((size / 1024)) KiB)"
  prune
  report success "$name" "$((size / 1024))"
  flock -u 9
}

prune() {
  local all n
  mapfile -t all < <(backups)
  n=${#all[@]}
  if [ "$n" -gt "$BACKUP_KEEP" ]; then
    for f in "${all[@]:0:n-BACKUP_KEEP}"; do rm -f -- "$DIR/$f" && log "Altes Backup entfernt: $f"; done
  fi
}

last_success() { [ -s "$STATUS" ] && cat "$STATUS" || echo 0; }

seconds_until_next() {
  local now next
  now=$(date +%s)
  next=$(date -d "today $BACKUP_TIME" +%s)
  [ "$next" -gt "$now" ] || next=$(date -d "tomorrow $BACKUP_TIME" +%s)
  echo $((next - now))
}

# Bei einer frischen Installation läuft die Migration parallel zum Start dieses Dienstes: kurz warten, bis die Tabellen
# angelegt sind, damit schon das erste Backup gemeldet wird. Gesichert wird danach in jedem Fall.
wait_schema() {
  local _
  for _ in $(seq 1 60); do
    PGOPTIONS='-c client_min_messages=warning' psql --no-psqlrc --quiet --dbname="$DB" -c 'SELECT 1 FROM system_settings LIMIT 1' >/dev/null 2>&1 && return 0
    sleep 2
  done
  log "Datenbank noch nicht eingerichtet (Migration?); der Stand wird erst beim nächsten Lauf gemeldet."
}

run() {
  trap 'log "Beende Backup-Dienst"; exit 0' TERM INT
  wait_schema
  if ! validate_config; then
    err "Backup-Dienst ist nicht eingerichtet und sichert nichts. Der Healthcheck meldet den Dienst als unhealthy."
    # Stündlich melden: Beim ersten Start kann die Datenbank noch ohne Tabellen sein (Migration läuft parallel)
    while true; do report config; sleep 3600 & wait $!; done
  fi
  log "Backup-Dienst gestartet: täglich um $BACKUP_TIME ($(date +%Z)), Aufbewahrung: $BACKUP_KEEP Backups, Ziel: $DIR"
  report config
  if [ $(( $(date +%s) - $(last_success) )) -ge 86400 ]; then backup_now || true; fi
  while true; do
    local wait_s
    report config
    wait_s=$(seconds_until_next)
    log "Nächstes Backup in $((wait_s / 3600)) h $((wait_s % 3600 / 60)) min"
    sleep "$wait_s" & wait $!
    # Bei einem Fehler nach 15 Minuten erneut versuchen, höchstens viermal
    for attempt in 1 2 3 4 5; do
      backup_now && break
      [ "$attempt" -lt 5 ] && { sleep 900 & wait $!; }
    done
  done
}

health() {
  validate_config >/dev/null 2>&1 || { echo "nicht eingerichtet (BACKUP_AGE_RECIPIENTS)"; exit 1; }
  local age_s=$(( $(date +%s) - $(last_success) ))
  if [ "$age_s" -gt "$MAX_AGE" ]; then echo "letztes erfolgreiches Backup vor $((age_s / 3600)) Stunden"; exit 1; fi
  echo "ok"
}

list() {
  local f
  [ -n "$(backups)" ] || { echo "Keine Backups vorhanden."; return 0; }
  printf '%-40s %10s\n' "Datei" "Größe"
  while read -r f; do printf '%-40s %8s KiB\n' "$f" "$(( $(stat -c %s "$DIR/$f") / 1024 ))"; done < <(backups)
}

psql_admin() { PGOPTIONS='-c client_min_messages=warning' psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --dbname=postgres "$@"; }

restore() {
  local file=${1:-} id ts others
  [ -n "$file" ] || { err "Aufruf: restore DATEI  (privater Schlüssel über die Standardeingabe)"; exit 2; }
  [[ $file == */* ]] || file="$DIR/$file"
  [ -f "$file" ] || { err "Datei nicht gefunden: $file"; exit 2; }
  [ ! -t 0 ] || { err "Privaten Schlüssel über die Standardeingabe übergeben, z. B.: docker compose run --rm -T backup restore $1 < bastion-backup-key.txt"; exit 2; }

  id=$(mktemp /tmp/identity.XXXXXX)
  # shellcheck disable=SC2064  # Pfad jetzt einsetzen: $id ist beim Beenden nicht mehr im Gültigkeitsbereich
  trap "rm -f '$id'" EXIT
  cat > "$id"
  grep -q '^AGE-SECRET-KEY-' "$id" || { err "Kein privater age-Schlüssel (AGE-SECRET-KEY-…) in der Standardeingabe"; exit 2; }

  others=$(psql_admin -At -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()")
  if [ "$others" != "0" ]; then
    err "Die Datenbank wird noch benutzt ($others Verbindungen). Zuerst die Anwendung stoppen: docker compose stop bastion"
    exit 1
  fi

  log "Spiele $(basename "$file") in die neue Datenbank ${DB}_restore ein …"
  psql_admin -c "DROP DATABASE IF EXISTS ${DB}_restore" -c "CREATE DATABASE ${DB}_restore"
  if ! age --decrypt -i "$id" "$file" | pg_restore --no-owner --no-acl --exit-on-error --dbname="${DB}_restore"; then
    psql_admin -c "DROP DATABASE IF EXISTS ${DB}_restore" || true
    err "Wiederherstellung fehlgeschlagen (falscher Schlüssel oder beschädigte Datei). Die bisherige Datenbank ist unverändert."
    exit 1
  fi

  ts=$(date -u '+%Y%m%d%H%M%S')
  psql_admin --single-transaction \
    -c "ALTER DATABASE $DB RENAME TO ${DB}_before_restore_$ts" \
    -c "ALTER DATABASE ${DB}_restore RENAME TO $DB"
  log "Wiederherstellung abgeschlossen. Die bisherige Datenbank heißt jetzt ${DB}_before_restore_$ts."
  log "Weiter mit: docker compose up -d   (der Dienst migrate richtet dabei die Rechte des App-Kontos neu ein)"
  log "Bisherige Datenbank löschen, wenn alles passt: docker compose exec db dropdb -U bastion ${DB}_before_restore_$ts"
}

keygen() {
  local key
  key=$(age-keygen 2>/dev/null)
  {
    echo "# Bastion – privater Schlüssel für die Datenbank-Backups"
    echo "# Offline aufbewahren (z. B. Passwort-Safe außerhalb von Bastion, ausgedruckt im Tresor). Ohne ihn sind die Backups wertlos."
    echo "$key"
  }
  echo "In .env eintragen: BACKUP_AGE_RECIPIENTS=$(grep -o 'age1[0-9a-z]*' <<<"$key")" >&2
}

case "${1:-run}" in
  run) run ;;
  now) validate_config && backup_now ;;
  list) list ;;
  restore) shift; restore "$@" ;;
  keygen) keygen ;;
  health) health ;;
  *) err "Unbekannter Befehl: $1 (run, now, list, restore, keygen, health)"; exit 2 ;;
esac
