# Änderungen

Alle nennenswerten Änderungen an Bastion. Versionen nach [Semantic Versioning](https://semver.org/lang/de/): Fehlerbehebung → Patch, neue Funktion → Minor, inkompatible Änderung → Major.
Vor jedem Update den Abschnitt der neuen Version lesen, besonders **Hinweise zum Update**.

Neue Einträge kommen unter *Unveröffentlicht*; `scripts/release.sh X.Y.Z` macht daraus die neue Version.

## [Unveröffentlicht]

### Neu
- Betrieb hinter einem Proxy, der HTTPS annimmt (z. B. HAProxy auf pfSense): `TLS_MODE=internal` lässt Caddy ein Zertifikat seiner lokalen CA verwenden statt Let's Encrypt. Das funktioniert auch, wenn die Domain nur im internen DNS existiert. `TRUSTED_PROXIES` nennt Adresse oder Netz des Proxys, damit Bastion die echte Client-IP aus `X-Forwarded-For` erhält. `install.sh` fragt danach und zeigt am Ende die nötige Einstellung im Proxy (Backend per HTTPS, Port 443).
- Caddy liefert das Zertifikat der Domain auch an Clients ohne SNI aus (manche Proxys senden keines).

### Hinweise zum Update
- Wer Bastion schon hinter einem Proxy betreibt: in `.env` `TLS_MODE=internal` und `TRUSTED_PROXIES=…` ergänzen, im Proxy das Backend auf HTTPS (Port 443) stellen und `docker compose up -d` ausführen. Eigene Caddyfiles bleiben unverändert gültig.

## [2.5.1] – 2026-11-19

### Behoben
- Anmeldeseite: Auf breiten Bildschirmen (z. B. 2K) waren die Türme der Festung oben abgeschnitten. Die Silhouette ist jetzt breiter angelegt, zeigt auf breiten Bildschirmen mehr Mauer statt sie zu beschneiden, und jeder Turm hat volle Zinnen.

## [2.5.0] – 2026-11-19

### Geändert
- Bastion richtet sich ausdrücklich an Unternehmen **und** private Nutzer (Familie, Haushalt, Verein, nur für sich). Untertitel der Anmeldeseite und Einstieg der Hilfe entsprechend angepasst.
- README auf Englisch (`README.md`), die deutsche Fassung liegt in `README.de.md`.
- Lizenz: Bastion steht jetzt unter der GNU Affero General Public License v3.0 oder später (`LICENSE`, `AGPL-3.0-or-later`). Bisher gab es keine Lizenz.

## [2.4.1] – 2026-11-18

### Neu
- `ACME_EMAIL` in `.env` wirkt jetzt: Let's Encrypt erhält die Adresse als Kontakt (z. B. für Hinweise, falls ein Zertifikat nicht erneuert werden kann). Leer bleibt es wie bisher ohne Angabe. `install.sh` fragt bei einer echten Domain danach.

### Behoben
- Die Weiterleitung von HTTP auf HTTPS verlor einen abweichenden HTTPS-Port (z. B. `HTTPS_PORT=8443` leitete auf `https://host/` statt `https://host:8443/`). Ziel ist jetzt der Ursprung aus `PUBLIC_URL`.

### Hinweise zum Update
- Caddy bekommt dafür `PUBLIC_URL` aus `.env`; `compose.yml` aus diesem Release übernehmen. Wer ein eigenes Caddyfile nutzt, übernimmt bei Bedarf die geänderten Zeilen aus dem neuen (`import /tmp/caddy.d/*` in den globalen Optionen und `redir {$BASTION_ORIGIN:https://localhost}{uri} 308`); ohne sie funktioniert es wie bisher.

## [2.4.0] – 2026-11-18

### Neu
- **Hilfe & Einstieg** (unten in der Seitenleiste): Anleitungen zu allen Funktionen auf Deutsch und Englisch, gegliedert in Grundlagen, Verwaltung und System & Betrieb, mit Suche. Jeder sieht die Anleitungen, die zu seiner Rolle passen. Auf vielen Seiten führt ein „?“ neben der Überschrift direkt zur passenden Anleitung.
- **Erste Schritte:** Checkliste je Rolle (eigenes Konto, Organisation, Installation). Die Schritte haken sich anhand des tatsächlichen Zustands selbst ab, z. B. 2FA eingerichtet, Notfall-Backup freigegeben oder Datenbank-Backup aktuell. Der Fortschritt steht im Menü, die Liste lässt sich ausblenden.
- **Kurztour** beim ersten Login, passend zur Rolle; jederzeit unter *Hilfe & Einstieg* neu startbar.
- **Stand des Datenbank-Backups** für System-Admins unter *Systemeinstellungen*: letztes Backup, Fehler, Zeitplan, Anzahl. Der Dienst `backup` meldet seinen Stand dafür selbst in die Datenbank (ohne Schlüssel oder andere Geheimnisse).
- **Installation mit einem Befehl:** `install.sh` im Release lädt `compose.yml` und die Vorlage, erzeugt alle Geheimnisse und auf Wunsch den Backup-Schlüssel und startet Bastion (README, *Installation*). `compose.yml`, `env.example` und `SHA256SUMS` liegen zusätzlich einzeln im Release.

### Geändert
- Die Compose-Datei heißt jetzt `compose.yml` (bisher `docker-compose.yml`), die Entwicklungs-Ergänzung `compose.build.yml`. Sie braucht kein Caddyfile mehr daneben: Caddy nutzt das im Image enthaltene.
- **Neue Anmeldeseite „Horizont“:** Nachthimmel mit der Festung am Horizont über die ganze Breite statt geteiltem Bildschirm, darüber der Leitsatz „Ihre Schlüssel. Ihre Festung.“ und mittig das Formular. Gilt für Anmelden, Entsperren, Ersteinrichtung und Einladung; die Karte folgt dem Tag-/Nachtmodus.

### Hinweise zum Update
- Wer Bastion vor dem Update schon benutzt hat, bekommt die Kurztour nicht automatisch angezeigt.
- Die Statusanzeige des Datenbank-Backups braucht das Backup-Image dieser Version (`bastion-backup`). Mit einem älteren Image zeigt Bastion „Keine Meldung“.
- Bestehende Installationen: `compose.yml` aus dem neuen Release übernehmen und die alte `docker-compose.yml` löschen (liegen beide im Ordner, nimmt Docker Compose `compose.yml` und warnt). Die `.env` bleibt, Compose-Projektname und Volumes sind unverändert. Wer `COMPOSE_FILE` in `.env` gesetzt hat, passt die Dateinamen an.
- Wer ein eigenes Caddyfile verwendet (z. B. für eigene Zertifikate), legt es neben `compose.yml` und kommentiert dort die Zeile `./Caddyfile:/etc/caddy/Caddyfile:ro` ein.

### Abhängigkeiten
- i18next 27.1.5, react-i18next 18.0.2, lucide-react 1.73.0, aktuelles Node-Basis-Image für den Build von Web-Client und Browser-Erweiterung.

## [2.3.0] – 2026-11-17

### Neu
- **Papierkorb:** Gelöschte Einträge landen im Papierkorb (Seitenleiste unter *Tresor*) und lassen sich wiederherstellen oder endgültig löschen. Nach `TRASH_RETENTION_DAYS` (Standard 30 Tage) löscht der Server sie selbst. Rechte wie beim Löschen; alles im Audit-Log (`item.restored`, `item.purged`, `items.purged_expired`).
- Die Schlüsselerneuerung verschlüsselt auch Einträge im Papierkorb neu.

### Hinweise zum Update
- Die Browser-Erweiterung ist unverändert kompatibel: Gelöschte Einträge erscheinen dort nicht mehr.
- Ein Browser-Tab, der noch die alte Web-Oberfläche geladen hat, kann keine Schlüsselerneuerung durchführen, solange Einträge im Papierkorb liegen (Abbruch ohne Änderung). Seite neu laden.
- Neue optionale Einstellung `TRASH_RETENTION_DAYS` in `.env` (siehe `.env.example`).

## [2.2.0] – 2026-11-17

### Neu
- **Fertige, signierte Images** in der GitHub Container Registry: `ghcr.io/ccbusse/bastion`, `bastion-caddy` und `bastion-backup`, jeweils mit SBOM und Build-Herkunft, signiert mit cosign. Installieren und Aktualisieren ohne Bauen aus dem Quellcode.
- Installationspaket je Version (`bastion-X.Y.Z.tar.gz`: Compose-Datei, Caddyfile, `.env.example`, Doku) im GitHub-Release.
- Anleitung zum Aktualisieren und Zurückrollen (README).
- Release-Prozess: `scripts/release.sh`, Workflow *Release* (veröffentlicht nur Commits mit grüner CI).

### Hinweise zum Update
- `docker-compose.yml` lädt jetzt fertige Images statt sie zu bauen; die Version steht in `BASTION_VERSION` (Standard: die Version der Compose-Datei). Wer selbst baut, nutzt zusätzlich `docker-compose.build.yml` (siehe README, Entwicklung).

## [2.1.0] – 2026-11-17

### Neu
- **Automatisches, verschlüsseltes Datenbank-Backup** (Dienst `backup`): täglich, verschlüsselt mit age für öffentliche Schlüssel, Aufbewahrung nach Anzahl, Healthcheck. Wiederherstellung in eine neue Datenbank mit Tausch erst nach Erfolg. Automatischer Test von Backup und Wiederherstellung in der CI.
- Kritische Aktionen von System-Admins nur mit erneuter Passworteingabe; Sicherheitshinweise per Mail an andere System-Admins und Kontoinhaber (neues Gerät, Browser-Erweiterung).
- Beitritt von System-Admins zu einem Tenant nur mit Zustimmung eines Tenant-Admins.
- 2FA-Einrichtung nur mit Masterpasswort.
- Audit-Eintrag beim ersten Abruf der Einträge je Sitzung (`items.listed`).

### Sicherheit
- PostgreSQL 17.12: Das bisherige Image enthielt Schwachstellen mit Codeausführung.
- Login-Zähler in der Datenbank (bleibt über Neustarts erhalten).
- Schutz gegen DNS-Rebinding bei Exportzielen und SMTP.
- Schlüsselerneuerung bricht bei nicht lesbaren Einträgen ab und übernimmt sie nur nach ausdrücklicher Bestätigung.

### Abhängigkeiten
- .NET 10.0.15, MailKit 5.0.0, Caddy 2.11.9, OpenTelemetry 1.47.0, aktuelle Basis-Images.

### Hinweise zum Update
- Für das Backup `BACKUP_AGE_RECIPIENTS` in `.env` setzen (README, Datenbank-Backup). Ohne Schlüssel sichert der Dienst nichts und meldet sich als `unhealthy`.

## [2.0.0] – 2026-11-11

### Neu
- Server in C# (.NET 10) statt Node.js, Container auf Debian.
- Ordnerschlüssel mit Herkunftsnachweis (Signatur des Absenders).
- Schutz vor Überlastung (Obergrenzen für Speicher und Prozesse, Größenlimits).
- Organisationscode als Vertrauensanker, Schlüsselerneuerung nach Rechteentzug, externer Anker für die Audit-Kette, Protokollierung von Exporten.
- Notfall-Backup mit automatischem Export (WebDAV, SFTP, SMB, Ordner).

### Entfernt
- Exportziel Cloud-Speicher (S3).

### Hinweise zum Update
- Hauptversion: Datenformat der Ordnerschlüssel erweitert. Vor dem Update sichern.

## [1.0.0] – 2026-10-27

### Neu
- Erste stabile Version: Sicherheitsaudit umgesetzt, Browser-Erweiterung (Chrome Web Store) mit Suchbereich nach Abteilung und Ordner.

## [0.2.0] – 2026-10-23

### Neu
- Unterordner, Import mit Struktur, mehrere Tenants, neues Design.
