#!/usr/bin/env bash
# Bastion installieren: Compose-Datei und Vorlage laden, Geheimnisse erzeugen, optional den Backup-Schlüssel anlegen, starten.
#
#   curl -fsSL https://github.com/ccbusse/bastion/releases/latest/download/install.sh | bash
#
# Fragt nach Domain und Ports (ohne Terminal: Standardwerte). Ohne Rückfragen, z. B. für Automatisierung:
#   BASTION_DOMAIN=vault.firma.de BASTION_BACKUP_KEY=ja bash install.sh
#
# Einstellungen über die Umgebung (alle optional):
#   BASTION_DIR          Zielordner (Standard: ./bastion)
#   BASTION_DOMAIN       Domain, z. B. vault.firma.de (Standard: localhost)
#   HTTP_PORT, HTTPS_PORT  Ports des Reverse-Proxys (Standard: 80, 443)
#   ACME_EMAIL           Kontaktadresse für Let's Encrypt (nur bei echter Domain gefragt; leer = ohne)
#   BASTION_PROXY        ja|nein: Davor steht ein Proxy, der HTTPS annimmt, z. B. HAProxy auf pfSense (Standard: nein)
#   TRUSTED_PROXIES      Adresse(n)/Netz(e) dieses Proxys (Standard: private_ranges = alle privaten Netze)
#   BASTION_BACKUP_KEY   ja|nein: Schlüssel für das Datenbank-Backup jetzt erzeugen (Standard: ja)
#   BASTION_BASE_URL     Quelle für compose.yml und .env.example (Standard: dieses Release auf GitHub)
#   BASTION_REGISTRY, BASTION_VERSION  andere Image-Quelle bzw. -Version (werden in .env übernommen)
set -euo pipefail
umask 077

# Das Release setzt hier seine Version ein; ohne Ersetzung (Aufruf aus dem Repository) gilt das neueste Release.
RELEASE="__BASTION_RELEASE__"
REPO="https://github.com/ccbusse/bastion"
if [[ $RELEASE == v* ]]; then DEFAULT_BASE="$REPO/releases/download/$RELEASE"; else DEFAULT_BASE="$REPO/releases/latest/download"; fi
BASE_URL=${BASTION_BASE_URL:-$DEFAULT_BASE}
DIR=${BASTION_DIR:-./bastion}

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mFEHLER:\033[0m %s\n' "$*" >&2; exit 1; }

# Rückfragen auch bei "curl … | bash": vom Terminal lesen, nicht von der Standardeingabe (dort steht das Skript)
TTY=
if { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ask() { # ask VARIABLE "Frage" Standardwert
  local answer
  if [ -n "${!1:-}" ]; then return 0; fi
  if [ -n "$TTY" ]; then
    read -r -p "  $2 [$3]: " answer <"$TTY" || answer=
    printf -v "$1" '%s' "${answer:-$3}"
  else
    printf -v "$1" '%s' "$3"
  fi
}

rand_b64() { if command -v openssl >/dev/null; then openssl rand -base64 "$1"; else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi; }
rand_hex() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; fi; }

# Wert in .env setzen (vorhandene Zeile ersetzen, sonst anhängen); awk statt sed, weil Base64 "/" und "+" enthält
set_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp .env.XXXXXX)
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 } $0 ~ "^" k "=" { print k "=" v; done = 1; next } { print } END { if (!done) print k "=" v }' .env >"$tmp"
  mv "$tmp" .env
}

download() { # download URL ZIEL
  if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null; then wget -qO "$2" "$1"
  else fail "curl oder wget wird benötigt."; fi
}

bold "Bastion – Installation"

# ---------- Voraussetzungen ----------
command -v docker >/dev/null || fail "Docker ist nicht installiert (https://docs.docker.com/engine/install/)."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 fehlt (Befehl \"docker compose\")."
docker info >/dev/null 2>&1 || fail "Docker läuft nicht oder dieser Benutzer darf es nicht verwenden (ggf. mit sudo ausführen)."

mkdir -p "$DIR"
cd "$DIR"
[ -e .env ] && fail "In $(pwd) ist Bastion bereits eingerichtet (.env vorhanden). Aktualisieren: siehe https://github.com/ccbusse/bastion/blob/master/docs/OPERATIONS.de.md#aktualisieren."

# ---------- Dateien ----------
info "Lade compose.yml und .env.example aus $BASE_URL …"
download "$BASE_URL/compose.yml" compose.yml
download "$BASE_URL/env.example" .env.example
grep -q '^services:' compose.yml || fail "compose.yml ist keine Compose-Datei. Quelle prüfen: $BASE_URL"

# ---------- Fragen ----------
echo
bold "Einstellungen"
ask BASTION_DOMAIN "Domain (z. B. vault.firma.de; localhost zum Ausprobieren)" localhost
[[ $BASTION_DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || fail "Ungültige Domain: $BASTION_DOMAIN"
ask HTTPS_PORT "HTTPS-Port" 443
ask HTTP_PORT "HTTP-Port (Weiterleitung und Let's Encrypt)" 80
[[ $HTTPS_PORT =~ ^[0-9]+$ && $HTTP_PORT =~ ^[0-9]+$ ]] || fail "Ports müssen Zahlen sein."
ask BASTION_PROXY "Steht ein Proxy davor, der HTTPS annimmt (z. B. HAProxy auf pfSense)? (ja/nein)" nein
PROXY=
if [[ $(printf %s "$BASTION_PROXY" | tr "[:upper:]" "[:lower:]") =~ ^(j|ja|y|yes)$ ]]; then
  PROXY=1
  ask TRUSTED_PROXIES "IP-Adresse oder Netz des Proxys (z. B. 10.8.10.1 oder 10.8.10.0/24)" private_ranges
  TRUSTED_PROXIES=${TRUSTED_PROXIES//,/ }
  [ -n "${TRUSTED_PROXIES// /}" ] || fail "Keine Adresse des Proxys angegeben."
  for p in $TRUSTED_PROXIES; do
    [[ $p == private_ranges || ( $p =~ ^[0-9A-Fa-f.:]+(/[0-9]{1,3})?$ && $p =~ [.:] ) ]] || fail "Keine IP-Adresse bzw. kein Netz: $p"
  done
fi
ACME_EMAIL=${ACME_EMAIL:-}
if [ "$BASTION_DOMAIN" != "localhost" ] && [ -z "$PROXY" ]; then
  ask ACME_EMAIL "E-Mail für Let's Encrypt (optional, Enter = ohne)" ""
  [ -z "$ACME_EMAIL" ] || [[ $ACME_EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "Ungültige E-Mail-Adresse: $ACME_EMAIL"
fi
ask BASTION_BACKUP_KEY "Schlüssel für das tägliche Datenbank-Backup jetzt erzeugen? (ja/nein)" ja

PUBLIC_URL="https://$BASTION_DOMAIN"
[ "$HTTPS_PORT" = "443" ] || PUBLIC_URL="$PUBLIC_URL:$HTTPS_PORT"
INITIAL="Init-$(rand_hex 12)"

# ---------- .env ----------
cp .env.example .env
chmod 600 .env
set_env PUBLIC_URL "$PUBLIC_URL"
set_env BASTION_DOMAIN "$BASTION_DOMAIN"
set_env HTTP_PORT "$HTTP_PORT"
set_env HTTPS_PORT "$HTTPS_PORT"
[ -z "$ACME_EMAIL" ] || set_env ACME_EMAIL "$ACME_EMAIL"
if [ -n "$PROXY" ]; then
  set_env TLS_MODE internal
  set_env TRUSTED_PROXIES "$TRUSTED_PROXIES"
fi
set_env APP_SECRET "$(rand_b64 48)"
set_env POSTGRES_PASSWORD "$(rand_hex 32)"
set_env APP_DB_PASSWORD "$(rand_hex 32)"
set_env INITIAL_ADMIN_PASSWORD "$INITIAL"
[ -n "${BASTION_REGISTRY:-}" ] && set_env BASTION_REGISTRY "$BASTION_REGISTRY"
[ -n "${BASTION_VERSION:-}" ] && set_env BASTION_VERSION "$BASTION_VERSION"
info ".env mit zufälligen Geheimnissen angelegt."

# ---------- Backup-Schlüssel ----------
KEYFILE=
if [[ $(printf %s "$BASTION_BACKUP_KEY" | tr "[:upper:]" "[:lower:]") =~ ^(j|ja|y|yes)$ ]]; then
  info "Erzeuge das Schlüsselpaar für das Datenbank-Backup …"
  docker compose run --rm --no-deps -T backup keygen >bastion-backup-key.txt 2>/dev/null || fail "Schlüssel konnte nicht erzeugt werden (docker compose run --rm backup keygen)."
  chmod 600 bastion-backup-key.txt
  RECIPIENT=$(grep -o 'age1[0-9a-z]*' bastion-backup-key.txt | head -1)
  [ -n "$RECIPIENT" ] || fail "Kein öffentlicher Schlüssel in bastion-backup-key.txt."
  set_env BACKUP_AGE_RECIPIENTS "$RECIPIENT"
  KEYFILE="$(pwd)/bastion-backup-key.txt"
fi

# ---------- Start ----------
echo
info "Starte Bastion (lädt beim ersten Mal die Images) …"
docker compose up -d
info "Warte, bis Bastion bereit ist …"
state=
for _ in $(seq 1 90); do
  id=$(docker compose ps -q bastion 2>/dev/null || true)
  state=$( [ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || true)
  [ "$state" = "healthy" ] && break
  sleep 2
done
[ "$state" = "healthy" ] || fail "Bastion ist nach 3 Minuten nicht bereit. Protokoll: cd $(pwd) && docker compose logs bastion migrate"

# ---------- Zusammenfassung ----------
echo
bold "Bastion läuft."
echo
info "Ersteinrichtung:   $PUBLIC_URL/setup"
info "Benutzername:      admin"
info "Initialpasswort:   $INITIAL   (gilt einmal; danach vergeben Sie Ihr eigenes Masterpasswort)"
echo
info "Ordner:            $(pwd)"
info "Wichtig:"
info " • .env enthält die Geheimnisse der Installation. Bewahren Sie eine Kopie getrennt vom Server auf"
info "   (ohne APP_SECRET sind 2FA-Secrets und das SMTP-Passwort nach einer Wiederherstellung nicht mehr lesbar)."
if [ -n "$KEYFILE" ]; then
  info " • $KEYFILE enthält den PRIVATEN Schlüssel der Datenbank-Backups."
  info "   Zweimal offline aufbewahren (z. B. ausgedruckt und auf einem USB-Stick) und danach vom Server löschen."
else
  info " • Das Datenbank-Backup ist noch nicht eingerichtet (https://github.com/ccbusse/bastion/blob/master/docs/OPERATIONS.de.md#datenbank-backup)."
fi
if [ -n "$PROXY" ]; then
  SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  info " • Proxy davor: Das Backend dort per HTTPS ansprechen (${SERVER_IP:-<IP dieses Servers>}, Port $HTTPS_PORT, verschlüsselt)."
  info "   pfSense/HAProxy: Backend → Encrypt(SSL) = yes, SSL checks = no. Unverschlüsselt ergibt das eine Weiterleitungsschleife."
  info "   Bastion nutzt ein Zertifikat seiner lokalen CA; das Zertifikat für die Browser stellt der Proxy bereit."
elif [ "$BASTION_DOMAIN" = "localhost" ]; then
  info " • Für localhost erzeugt Bastion ein selbstsigniertes Zertifikat: die Browserwarnung einmal bestätigen."
else
  info " • Für $BASTION_DOMAIN holt Bastion automatisch ein Let's-Encrypt-Zertifikat (DNS und Ports $HTTP_PORT/$HTTPS_PORT müssen erreichbar sein)."
fi
info " • Danach in Bastion: Hilfe & Einstieg → Erste Schritte."
