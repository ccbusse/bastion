#!/bin/sh
# Bereitet Einstellungen vor, die das Caddyfile nicht selbst ausdrücken kann, und startet dann den übergebenen Befehl (Caddy).
#  - ACME_EMAIL (optional): Kontaktadresse für Let's Encrypt. Leer = keine Angabe; eine leere "email"-Option würde Caddy
#    ablehnen, deshalb landet sie nur bei gesetzter Adresse in /tmp/caddy.d/, das das Caddyfile per Import einliest.
#  - BASTION_ORIGIN: Ursprung aus PUBLIC_URL (Schema, Host, Port) als Ziel der HTTP→HTTPS-Weiterleitung, damit ein
#    abweichender HTTPS-Port erhalten bleibt. Ohne gültige PUBLIC_URL: https://BASTION_DOMAIN.
#  - TLS_MODE (optional): "auto" (Standard: Let's Encrypt, für localhost die lokale CA) oder "internal" (immer die lokale
#    Caddy-CA, z. B. hinter einem Proxy wie HAProxy auf pfSense oder bei nur intern auflösbarer Domain).
#  - TRUSTED_PROXIES (optional): IP-Adressen/Netze (CIDR) vorgeschalteter Proxys, durch Leerzeichen oder Komma getrennt,
#    oder "private_ranges". Nur von dort übernimmt Caddy die Client-IP aus X-Forwarded-For.
# Jedes Import-Verzeichnis bekommt immer eine Datei (sonst warnt Caddy bei jedem Start über einen leeren Import).
set -eu

fail() { echo "$*" >&2; exit 1; }

mkdir -p /tmp/caddy.d /tmp/caddy.site.d /tmp/caddy.servers.d

# ---------- ACME_EMAIL ----------
echo "# ACME_EMAIL nicht gesetzt" >/tmp/caddy.d/acme-email
if [ -n "${ACME_EMAIL:-}" ]; then
  case "$ACME_EMAIL" in
    *[!A-Za-z0-9._%+@-]* | @* | *@ | *@*@*) fail "ACME_EMAIL ist keine gültige E-Mail-Adresse: $ACME_EMAIL" ;;
    *@*.*) printf 'email %s\n' "$ACME_EMAIL" >/tmp/caddy.d/acme-email ;;
    *) fail "ACME_EMAIL ist keine gültige E-Mail-Adresse: $ACME_EMAIL" ;;
  esac
fi

# ---------- TLS_MODE ----------
case "${TLS_MODE:-auto}" in
  "" | auto) echo "# TLS_MODE=auto: Zertifikat automatisch (Let's Encrypt bzw. lokale CA für localhost)" >/tmp/caddy.site.d/tls ;;
  internal) printf '%s\n' "# TLS_MODE=internal" "tls internal" >/tmp/caddy.site.d/tls ;;
  *) fail "TLS_MODE muss \"auto\" oder \"internal\" sein, nicht: $TLS_MODE" ;;
esac

# ---------- TRUSTED_PROXIES ----------
echo "# TRUSTED_PROXIES nicht gesetzt" >/tmp/caddy.servers.d/trusted-proxies
proxies=$(printf '%s' "${TRUSTED_PROXIES:-}" | tr ',' ' ')
if [ -n "$(printf '%s' "$proxies" | tr -d ' ')" ]; then
  for p in $proxies; do
    case "$p" in
      private_ranges) ;;
      *[!0-9A-Fa-f.:/]* | */*/*) fail "TRUSTED_PROXIES enthält keine IP-Adresse bzw. kein Netz (CIDR): $p" ;;
      *[.:]*) ;;
      *) fail "TRUSTED_PROXIES enthält keine IP-Adresse bzw. kein Netz (CIDR): $p" ;;
    esac
  done
  # shellcheck disable=SC2086 # Wörter einzeln übergeben
  printf 'trusted_proxies static %s\ntrusted_proxies_strict\nclient_ip_headers X-Forwarded-For\n' "$(echo $proxies)" \
    >/tmp/caddy.servers.d/trusted-proxies
fi

# ---------- Weiterleitungsziel ----------
origin=$(printf '%s' "${PUBLIC_URL:-}" | sed -nE 's#^(https://[A-Za-z0-9.-]+(:[0-9]{1,5})?)(/.*)?$#\1#p')
if [ -z "$origin" ]; then
  [ -z "${PUBLIC_URL:-}" ] || echo "PUBLIC_URL ist keine https-Adresse ($PUBLIC_URL); Weiterleitung auf https://${BASTION_DOMAIN:-localhost}" >&2
  origin="https://${BASTION_DOMAIN:-localhost}"
fi
export BASTION_ORIGIN="$origin"

exec "$@"
