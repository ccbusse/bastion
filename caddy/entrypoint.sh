#!/bin/sh
# Bereitet Einstellungen vor, die das Caddyfile nicht selbst ausdrücken kann, und startet dann den übergebenen Befehl (Caddy).
#  - ACME_EMAIL (optional): Kontaktadresse für Let's Encrypt. Leer = keine Angabe; eine leere "email"-Option würde Caddy
#    ablehnen, deshalb landet sie nur bei gesetzter Adresse in /tmp/caddy.d/, das das Caddyfile per Import einliest.
#  - BASTION_ORIGIN: Ursprung aus PUBLIC_URL (Schema, Host, Port) als Ziel der HTTP→HTTPS-Weiterleitung, damit ein
#    abweichender HTTPS-Port erhalten bleibt. Ohne gültige PUBLIC_URL: https://BASTION_DOMAIN.
set -eu

mkdir -p /tmp/caddy.d
# Immer eine Datei anlegen (sonst warnt Caddy bei jedem Start über einen leeren Import)
echo "# ACME_EMAIL nicht gesetzt" >/tmp/caddy.d/acme-email

if [ -n "${ACME_EMAIL:-}" ]; then
  case "$ACME_EMAIL" in
    *[!A-Za-z0-9._%+@-]* | @* | *@ | *@*@*) echo "ACME_EMAIL ist keine gültige E-Mail-Adresse: $ACME_EMAIL" >&2; exit 1 ;;
    *@*.*) printf 'email %s\n' "$ACME_EMAIL" >/tmp/caddy.d/acme-email ;;
    *) echo "ACME_EMAIL ist keine gültige E-Mail-Adresse: $ACME_EMAIL" >&2; exit 1 ;;
  esac
fi

origin=$(printf '%s' "${PUBLIC_URL:-}" | sed -nE 's#^(https://[A-Za-z0-9.-]+(:[0-9]{1,5})?)(/.*)?$#\1#p')
if [ -z "$origin" ]; then
  [ -z "${PUBLIC_URL:-}" ] || echo "PUBLIC_URL ist keine https-Adresse ($PUBLIC_URL); Weiterleitung auf https://${BASTION_DOMAIN:-localhost}" >&2
  origin="https://${BASTION_DOMAIN:-localhost}"
fi
export BASTION_ORIGIN="$origin"

exec "$@"
