# syntax=docker/dockerfile:1.7
# Automatisches Datenbank-Backup: pg_dump, verschlüsselt mit age für einen oder mehrere öffentliche Schlüssel.
# Gleiches Basis-Image wie der Dienst "db" in compose.yml (pg_dump passend zur Server-Hauptversion 17).
# Basis-Image per Digest fixiert. Aktualisieren: Digest des neuen Tags eintragen (Dependabot macht das wöchentlich).
FROM postgres:17-trixie@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac
# Sicherheitsupdates von Debian einspielen; gosu (Rechtewechsel beim Start des Datenbank-Servers) wird hier nicht gebraucht.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends age tzdata \
 && rm -rf /var/lib/apt/lists/* /usr/local/bin/gosu \
 && useradd --uid 1000 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin backup-runner \
 && mkdir -p /backups \
 && chown backup-runner:backup-runner /backups \
 && chmod 0700 /backups
COPY --chmod=0755 bastion-backup.sh /usr/local/bin/bastion-backup
USER backup-runner
WORKDIR /backups
ENTRYPOINT ["/usr/local/bin/bastion-backup"]
CMD ["run"]
HEALTHCHECK --interval=5m --timeout=10s --start-period=15m CMD ["/usr/local/bin/bastion-backup", "health"]
