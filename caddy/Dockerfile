# syntax=docker/dockerfile:1.7
# Reverse-Proxy: Caddy auf Debian 13 statt Alpine, ohne Root-Rechte und ohne Capabilities.
#
# Caddy wird aus dem Quellcode gebaut (main.go, Abhängigkeiten in go.mod/go.sum festgehalten und von Dependabot
# aktualisiert). So lassen sich Sicherheitskorrekturen in Go und den mitgelieferten Bibliotheken übernehmen, ohne auf
# eine neue Caddy-Version zu warten; das offizielle Programm enthielt zuletzt bekannte Schwachstellen in diesen Teilen.
# Die Ports 80/443 gibt docker-compose per sysctl net.ipv4.ip_unprivileged_port_start=0 für den Netz-Namensraum des
# Containers frei; eine Datei-Capability (wie im offiziellen Image) ist daher nicht nötig.
# Basis-Images per Digest fixiert. Aktualisieren: Digest des neuen Tags eintragen.
FROM golang:1-trixie@sha256:f18c3d73a184fb0582828510722e723b63a93f7188d11dd223d9be6f6880e65d AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-mod=readonly GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY main.go ./
RUN go build -trimpath -ldflags "-s -w" -o /out/caddy . && /out/caddy version

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates media-types tini \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin caddy \
 && mkdir -p /config/caddy /data/caddy /etc/caddy \
 && chown -R caddy:caddy /config /data
COPY --from=build --chown=root:root /out/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
# Startskript: ACME_EMAIL und Weiterleitungsziel aus PUBLIC_URL vorbereiten (siehe entrypoint.sh)
COPY --chmod=0755 entrypoint.sh /usr/local/bin/bastion-caddy-entrypoint
ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
USER caddy
EXPOSE 80 443
WORKDIR /srv
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bastion-caddy-entrypoint"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
