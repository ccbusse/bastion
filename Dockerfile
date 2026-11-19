# syntax=docker/dockerfile:1.7
# Basis-Images per Digest fixiert (reproduzierbar, Schutz vor ausgetauschten Tags). Aktualisieren: Digest des neuen Tags eintragen.
# ---------- Web-Client bauen ----------
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS web-build
WORKDIR /build/web
COPY VERSION /build/VERSION
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- Browser-Erweiterung bauen (nutzt die Krypto-Module des Web-Clients) ----------
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS extension-build
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
WORKDIR /build/extension
COPY VERSION /build/VERSION
COPY branding /build/branding
COPY web/src/lib /build/web/src/lib
COPY extension/package.json extension/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY extension/ ./
RUN npm run build \
 && mkdir -p /build/downloads \
 && cd dist && zip -qr -X "/build/downloads/bastion-extension-chromium-$(cat /build/VERSION).zip" .

# ---------- Server bauen (C#, .NET 10) ----------
# Das SDK-Image dient nur zum Kompilieren. Der Server wird "self-contained" veröffentlicht (Laufzeit im Paket) und läuft
# auf demselben Debian-Basisimage wie Datenbank und Reverse-Proxy; Microsoft bietet für .NET 10 keine Debian-Images an.
FROM mcr.microsoft.com/dotnet/sdk:10.0-noble@sha256:fe0fd4e93bd2fbb47c883b7a6369e5c8d3db8bf01cdc5981f6ee35fbdf3ff4fb AS server-build
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
WORKDIR /build/server
COPY server/global.json server/Directory.Build.props ./
COPY server/src/Bastion.Server/Bastion.Server.csproj server/src/Bastion.Server/packages.lock.json src/Bastion.Server/
RUN dotnet restore src/Bastion.Server/Bastion.Server.csproj -r linux-x64 --locked-mode
COPY server/src/Bastion.Server/ src/Bastion.Server/
RUN dotnet publish src/Bastion.Server/Bastion.Server.csproj -c Release -r linux-x64 --self-contained --no-restore \
      -p:DebugType=none -p:GenerateDocumentationFile=false -o /out \
 && rm -f /out/appsettings.Development.json

# ---------- Laufzeit-Image (Debian 13) ----------
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3t64 libstdc++6 tini smbclient \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin bastion
# Ohne Diagnose-Schnittstelle (kein Debugger/Profiler-Zugang, keine IPC-Dateien im schreibgeschützten Dateisystem)
ENV PORT=3000 \
    WEB_DIST=/app/public \
    DOTNET_EnableDiagnostics=0 \
    DOTNET_gcServer=0 \
    ASPNETCORE_ENVIRONMENT=Production
WORKDIR /app
COPY --from=server-build --chown=root:root /out ./
COPY --from=web-build --chown=root:root /build/web/dist ./public
COPY --from=extension-build --chown=root:root /build/downloads ./public/downloads
# Versionsangaben: VERSION ist die einzige Quelle, Commit optional per Build-Argument, Build-Datum automatisch
COPY VERSION ./VERSION
ARG GIT_COMMIT=""
RUN printf '%s' "$GIT_COMMIT" > ./BUILD_COMMIT && date -u +%Y-%m-%dT%H:%M:%SZ > ./BUILD_DATE
# Ziel für den automatischen Export des Notfall-Backups (Volume); einziges beschreibbares Verzeichnis der Anwendung
RUN mkdir -p /backup && chown bastion:bastion /backup && chmod 750 /backup
# Läuft als unprivilegierter Benutzer; Anwendungsdateien gehören root und sind nicht beschreibbar
USER bastion
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["/app/Bastion.Server", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# Migrationen und Einrichtung des Datenbankkontos laufen im eigenen Dienst "migrate" (compose.yml)
CMD ["/app/Bastion.Server"]
