# Bastion betreiben

Installation, Aktualisierung, Backups und Rechtemodell im Detail. Den schnellen Überblick gibt die [README](../README.de.md). [English version](OPERATIONS.md)

## Inhalt

* [Installation](#installation)
* [Aktualisieren](#aktualisieren)
* [Erste Schritte nach der Einrichtung](#erste-schritte-nach-der-einrichtung)
* [Datenbank-Backup](#datenbank-backup)
* [Notfall-Backup](#notfall-backup)
* [Rechtemodell](#rechtemodell)
* [Browser-Erweiterung](#browser-erweiterung)

## Installation

Voraussetzungen: Docker mit Compose v2, ein Linux-Server (x86-64).

### Schnellstart

```bash
curl -fsSL https://github.com/ccbusse/bastion/releases/latest/download/install.sh | bash
```

Das Skript legt den Ordner `bastion/` an und lädt `compose.yml` und `.env.example` der aktuellen Version. Es fragt nach Domain und Ports, erzeugt alle Geheimnisse in `.env` und auf Wunsch den Schlüssel für das [Datenbank-Backup](#datenbank-backup). Dann startet es Bastion und zeigt die Adresse der Ersteinrichtung mit dem Initialpasswort.

* Bestimmte Version statt der neuesten: `…/releases/download/v2.4.1/install.sh`
* Ohne Rückfragen, z. B. für Automatisierung: `BASTION_DOMAIN=vault.firma.de BASTION_BACKUP_KEY=ja bash install.sh` (alle Einstellungen stehen am Anfang des Skripts)

Wer das Skript vorher lesen möchte, lädt es zuerst und prüft es gegen `SHA256SUMS` aus demselben Release:

```bash
curl -fsSLO https://github.com/ccbusse/bastion/releases/latest/download/install.sh
curl -fsSLO https://github.com/ccbusse/bastion/releases/latest/download/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS && less install.sh && bash install.sh
```

### Von Hand

Für die Installation reichen zwei Dateien aus dem [GitHub-Release](https://github.com/ccbusse/bastion/releases): `compose.yml` und die Vorlage `env.example`. Das Installationspaket `bastion-X.Y.Z.tar.gz` enthält beide (die Vorlage als `.env.example`), dazu Caddyfile und Doku. Die Images (`ghcr.io/ccbusse/bastion`, `bastion-caddy`, `bastion-backup`) werden fertig gebaut geladen.

```bash
mkdir bastion && cd bastion
curl -fsSLO https://github.com/ccbusse/bastion/releases/latest/download/compose.yml
curl -fsSL https://github.com/ccbusse/bastion/releases/latest/download/env.example -o .env
```

Danach in `.env` mindestens `APP_SECRET`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `PUBLIC_URL` und `BASTION_DOMAIN` setzen. Platzhalter mit `CHANGE_ME` lehnt Bastion ab. Geheimnisse erzeugen:

```bash
openssl rand -base64 48
```

Datenbank-Passwörter nur als Hex erzeugen, da sie Teil der Verbindungs-URL sind:

```bash
openssl rand -hex 32
```

`POSTGRES_PASSWORD` gehört dem Eigentümer-Konto, mit dem nur der einmalige Dienst `migrate` die Migrationen ausführt. Die laufende Anwendung nutzt das eingeschränkte Konto `bastion_app` mit `APP_DB_PASSWORD` (nur Datenzugriff, Audit-Log nur anhängen). Bestehende Installationen ergänzen `APP_DB_PASSWORD` in `.env`; `migrate` legt das Konto beim nächsten Start an.

Starten:

```bash
docker compose up -d
```

Initialpasswort des ersten Admins aus dem Log lesen:

```bash
docker compose logs bastion
```

Dann `PUBLIC_URL/setup` öffnen, als Benutzer `admin` mit dem Initialpasswort anmelden und das eigene Masterpasswort vergeben.

### Herkunft der Images prüfen

Optional, aber empfohlen (benötigt [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)). Die Images sind vom Release-Workflow dieses Repositorys signiert; ein manipuliertes oder fremdes Image fällt hier auf.

```bash
for i in bastion bastion-caddy bastion-backup; do
  cosign verify "ghcr.io/ccbusse/$i:2.4.1" \
    --certificate-identity-regexp '^https://github.com/ccbusse/bastion/\.github/workflows/release\.yml@refs/tags/v' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com > /dev/null && echo "$i: Signatur ok"
done
```

### Lokal testen

* Mit `BASTION_DOMAIN=localhost` erzeugt Caddy ein selbstsigniertes Zertifikat. Die Browserwarnung einmalig akzeptieren.
* Andere Ports (z. B. `HTTPS_PORT=8443`) müssen auch in `PUBLIC_URL` stehen: `PUBLIC_URL=https://localhost:8443`.

### Produktion

* `BASTION_DOMAIN=vault.firma.de` und `PUBLIC_URL=https://vault.firma.de`. Bei öffentlichem DNS und offenen Ports 80/443 holt Caddy automatisch ein Let's-Encrypt-Zertifikat. Optional `ACME_EMAIL=it@firma.de`: Let's Encrypt meldet sich dort, falls ein Zertifikat nicht erneuert werden kann.
* Aufrufe über HTTP leitet Caddy auf `PUBLIC_URL` weiter (inklusive eines abweichenden HTTPS-Ports).
* Hinter einem Proxy, der HTTPS annimmt (z. B. HAProxy auf pfSense, Nginx Proxy Manager), oder mit einer Domain nur im internen DNS: `TLS_MODE=internal` (Caddy verwendet ein Zertifikat seiner lokalen CA statt Let's Encrypt) und `TRUSTED_PROXIES` auf Adresse oder Netz des Proxys setzen (z. B. `10.8.10.1` oder `private_ranges`), damit Bastion die echte Client-IP sieht. `install.sh` fragt danach. Der Proxy muss Bastion per **HTTPS** auf Port 443 ansprechen (pfSense: Backend *Encrypt(SSL)* = yes, *SSL checks* = no); unverschlüsseltes HTTP auf Port 443 endet in einer Weiterleitungsschleife.
* Eigene Zertifikate: ein eigenes `Caddyfile` neben `compose.yml` legen (Vorlage im Installationspaket), dort `tls /pfad/cert.pem /pfad/key.pem` ergänzen, die Dateien einbinden und in `compose.yml` die Zeile `./Caddyfile:/etc/caddy/Caddyfile:ro` einkommentieren.
* SMTP-Server global unter *System → E-Mail (SMTP)* eintragen (Host, Port, TLS/STARTTLS, Zugangsdaten, Absender) und per Testmail prüfen. Ohne SMTP zeigt Bastion den Einladungslink zum manuellen Weitergeben an.
* Backups: das automatische Datenbank-Backup einrichten (Abschnitt [Datenbank-Backup](#datenbank-backup)) **und** `.env` (vor allem `APP_SECRET`) getrennt aufbewahren. Ohne `APP_SECRET` sind TOTP-Secrets und das SMTP-Passwort nicht mehr lesbar. Tresorinhalte sind davon unabhängig.
* Festplattenverschlüsselung auf dem Host: Namen von Tenants, Abteilungen und Ordnern sowie E-Mail-Adressen liegen unverschlüsselt in der Datenbank.

## Aktualisieren

Bastion folgt [Semantic Versioning](https://semver.org/lang/de/): Patch-Versionen (2.2.**x**) beheben Fehler, Minor-Versionen (2.**x**.0) bringen neue Funktionen, Major-Versionen (**x**.0.0) können manuelle Schritte erfordern. Neue Versionen und ihre Änderungen stehen in den [Releases](https://github.com/ccbusse/bastion/releases) und in `CHANGELOG.md`. Den Releases auf GitHub folgen (*Watch → Custom → Releases*), um Sicherheitsupdates mitzubekommen.

1. Im Changelog die Abschnitte **aller** Versionen seit der installierten lesen, besonders *Hinweise zum Update*.
2. Vor dem Update ein Backup erstellen:

   ```bash
   docker compose exec backup bastion-backup now
   ```

3. Neue Version eintragen und starten. Ändern sich Compose-Datei, Caddyfile oder `.env.example` (steht im Changelog), die Dateien aus dem neuen Installationspaket übernehmen und die eigene `.env` behalten.

   ```ini
   BASTION_VERSION=2.4.1
   ```

   ```bash
   docker compose pull && docker compose up -d
   ```

   Der Dienst `migrate` passt die Datenbank beim Start automatisch an.
4. Kontrolle: `docker compose ps` (alle Dienste `healthy`), Version unten in der Seitenleiste.

**Zurückrollen:** Datenbank-Migrationen laufen nur vorwärts. Eine ältere Version startet nicht zuverlässig auf einer Datenbank, die eine neuere Version angepasst hat. Deshalb immer zusammen zurück: `BASTION_VERSION` auf die alte Version setzen, `docker compose pull`, dann das Backup von Schritt 2 wiederherstellen (Abschnitt [Datenbank-Backup](#datenbank-backup), *Wiederherstellen*). Änderungen seit dem Update gehen dabei verloren.

Die Browser-Erweiterung aktualisiert sich über den Chrome Web Store unabhängig vom Server. Ältere und neuere Erweiterungen funktionieren mit jedem Server derselben Hauptversion.

## Erste Schritte nach der Einrichtung

1. **System-Admin:** *System → Tenants → Neuer Tenant*, dabei den ersten Tenant-Admin einladen.
2. **Tenant-Admin:** nimmt die Einladung an. Der System-Admin bestätigt ihn unter *Tenants → Admins* per Fingerprint-Abgleich.
3. **Tenant-Admin** meldet sich an. Die Tenant-Schlüssel (Recovery und Signatur) werden automatisch erzeugt.
4. **Tenant-Admin:** *Abteilungen & Ordner* anlegen und Benutzer mit Rolle und Geltungsbereich einladen.
5. **Neue Benutzer** nehmen die Einladung an und sehen dabei zwei Fingerprints: den ihres Schlüssels und den der Organisationsschlüssel. Ein Tenant-Admin gleicht beide ab, bestätigt und beglaubigt damit den Schlüssel. Erst dann werden die Ordnerschlüssel automatisch verteilt.
6. **System-Admins**, die einem Tenant beitreten, erhalten Schlüssel erst, wenn ein Tenant-Admin sie unter *Benutzer → Beglaubigung ausstehend* ausdrücklich beglaubigt.

In Bastion selbst führt *Hilfe & Einstieg* (unten in der Seitenleiste) durch diese Schritte: eine Checkliste je Rolle, die sich anhand des tatsächlichen Zustands abhakt, eine Kurztour und Anleitungen zu allen Funktionen.

## Datenbank-Backup

Der Dienst `backup` sichert die komplette Datenbank täglich (Standard 02:30 Uhr) und beim Start, wenn das letzte Backup älter als 24 Stunden ist. Jedes Backup wird mit [age](https://age-encryption.org) für einen oder mehrere **öffentliche** Schlüssel verschlüsselt. Der Server kann seine eigenen Backups also nicht lesen; den privaten Schlüssel braucht man nur zum Wiederherstellen, er gehört nicht auf den Server. Aufbewahrt werden die neuesten `BACKUP_KEEP` Backups (Standard 14). Fallen Backups aus, werden ältere nicht gelöscht.

Das Datenbank-Backup ist die Sicherung für den Betrieb: Server defekt, Volume verloren, Fehlbedienung. Es enthält alles, ist aber ohne `APP_SECRET` (in `.env`) nur eingeschränkt nutzbar. Das [Notfall-Backup](#notfall-backup) ist etwas anderes: Es macht freigegebene Tresore ohne Bastion lesbar.

**Einrichten**

1. Schlüsselpaar erzeugen:

   ```bash
   docker compose run --rm -T backup keygen > bastion-backup-key.txt
   ```

   Der Befehl zeigt die Zeile `BACKUP_AGE_RECIPIENTS=age1…` an. Sie gehört in `.env`. Die Datei `bastion-backup-key.txt` enthält den privaten Schlüssel: zweimal getrennt offline aufbewahren (z. B. ausgedruckt im Safe und auf einem USB-Stick) und vom Server löschen. Für mehrere Verantwortliche je ein Schlüsselpaar erzeugen und alle öffentlichen Schlüssel durch Leerzeichen getrennt eintragen; jeder davon kann wiederherstellen.
2. In `.env` ein Ziel auf einem **anderen Datenträger** wählen, z. B. eine eingehängte NAS-Freigabe. Standard ist das Docker-Volume `db-backup` auf demselben Host; das schützt vor Fehlbedienung, nicht vor einem Ausfall des Servers.

   ```bash
   sudo chown 1000:1000 /mnt/nas/bastion-db-backup
   ```

   ```ini
   BACKUP_PATH=/mnt/nas/bastion-db-backup
   ```

3. `docker compose up -d`. Kontrolle:

   ```bash
   docker compose ps backup        # "healthy": letztes Backup jünger als 26 Stunden
   docker compose logs backup
   docker compose run --rm backup list
   ```

   Ohne `BACKUP_AGE_RECIPIENTS` sichert der Dienst nichts und meldet sich als `unhealthy`. Ein sofortiges Backup: `docker compose exec backup bastion-backup now`.

   Den Stand sehen System-Admins auch in Bastion unter *Systemeinstellungen* (letztes Backup, Fehler, Zeitplan). Der Dienst meldet ihn dafür selbst in die Datenbank (Tabelle `system_settings`, Schlüssel `backup.database`); die Meldung enthält keine Schlüssel.

**Wiederherstellen**

Die Wiederherstellung spielt das Backup in eine neue Datenbank ein und tauscht erst danach. Die bisherige Datenbank bleibt unter `bastion_before_restore_<Zeitstempel>` erhalten; schlägt etwas fehl (falscher Schlüssel, beschädigte Datei), bleibt alles, wie es war. Das Backup muss von derselben oder einer älteren Bastion-Version stammen; fehlende Migrationen spielt `migrate` beim Start nach.

```bash
docker compose stop bastion
docker compose run --rm -T backup restore bastion-20261117T013000Z.dump.age < bastion-backup-key.txt
docker compose up -d
```

Auf einem neuen Server: Bastion mit der gesicherten `.env` einrichten (gleiches `APP_SECRET`), die Backup-Datei in das Backup-Verzeichnis kopieren, dann wie oben. Wenn alles passt, die alte Datenbank löschen (der Befehl steht in der Ausgabe der Wiederherstellung).

Die CI spielt bei jedem Commit einmal den kompletten Ablauf durch (Backup, Totalverlust, Wiederherstellung, Anmeldung): `tests/backup/run.sh`.

## Notfall-Backup

Verschlüsselte Offline-Kopie aller freigegebenen Tresore für den Ernstfall (Details: [docs/SECURITY.md](SECURITY.md), Abschnitt 4a).

1. *System → Notfall-Backup*: Notfallschlüssel einrichten. Das Schlüsselblatt zweimal ausdrucken und getrennt von der Passphrase verwahren.
2. *Einstellungen → Notfall-Backup*: Ein Tenant-Admin jedes Tenants gleicht den Fingerprint ab und gibt frei.
3. Backups manuell herunterladen oder unter *Automatischer Export → Ziel hinzufügen* ein Ziel wählen: **Windows-Freigabe / NAS** (z. B. `\\NAS\Backup`), **Nextcloud** oder **Hetzner Storage Box**, außerdem SFTP, WebDAV oder ein Ordner auf dem Server. Es genügen Adresse, Benutzer, Passwort und Ordner; Bastion prüft die Verbindung beim Speichern. Exportiert wird nach jeder Änderung (nach einer Ruhezeit) und täglich; ältere Versionen werden nach der eingestellten Anzahl gelöscht.
4. Im Ernstfall die Datei `bastion-notfall-werkzeug.html` (liegt jedem automatischen Export bei) offline im Browser öffnen, Backup-Datei wählen, Code vom Schlüsselblatt und Passphrase eingeben.

Nur für das Ziel *Ordner auf dem Bastion-Server* ist eine Einstellung in Docker nötig: Bastion schreibt nach `/backup` im Container. Standard ist das Docker-Volume `emergency-backup`; ein eigenes Verzeichnis (z. B. eine eingehängte NAS-Freigabe) über `EMERGENCY_BACKUP_PATH` in `.env` einbinden. Es muss für UID 1000 beschreibbar sein:

```bash
sudo chown 1000:1000 /mnt/nas/bastion-backup
```

## Rechtemodell

* **Tresorrechte** (Tenant-, Abteilungs- oder Ordnerebene, vererben sich nach unten):
  `vault.view` (nur Übersicht; Geheimnisse werden **nicht** übertragen, der Schlüssel dafür ebenfalls nicht) ⊂ `vault.reveal` ⊂ `vault.edit` ⊂ `vault.manage`
* **Administrative Rechte** (nur auf Tenant-Ebene): `tenant.admin`, `tenant.users.invite|confirm|manage`, `tenant.structure.manage`, `tenant.roles.manage`, `tenant.audit.read`, `tenant.settings.manage`
* **Ordner ohne Vererbung** (z. B. „Gehälter“): nur direkt Berechtigte und Tenant-Admins haben Zugriff.
* **Keine Rechteausweitung:** Niemand kann Rechte vergeben, die er selbst nicht besitzt. Manager können ihre Ordner bzw. Abteilungen delegieren.
* Eingebaute Rollen: Tenant-Administrator, Manager, Bearbeiter, Leser, Betrachter, Benutzerverwaltung, Auditor. Eigene Rollen lassen sich frei definieren.

## Browser-Erweiterung

Unter `extension/` liegt die Erweiterung für Chromium-Browser (Chrome, Edge, Brave, Opera; Manifest V3). Sie ist im Chrome Web Store veröffentlicht (nicht gelistet): <https://chromewebstore.google.com/detail/bastion/fkdcleihlodonenjchpdcjmgfnpadono>. In Bastion führt *Werkzeuge → Browser-Erweiterung* per Button dorthin und erklärt die Einrichtung.

Sicherheitsprinzipien:

* **Zero-Knowledge:** dieselben Krypto-Module wie der Web-Client (`web/src/lib/crypto`); Masterpasswort und Schlüssel verlassen das Gerät nie.
* **Eigene Sitzungsart:** Die Erweiterung meldet sich mit einem Bearer-Token an (keine Cookies). Solche Sitzungen dürfen nur ausdrücklich freigegebene, lesende Endpunkte aufrufen (`@AllowExtension()`), alles andere lehnt der Server mit `EXTENSION_NOT_ALLOWED` ab. Sie erscheinen unter *Mein Konto → Sitzungen* und lassen sich dort widerrufen.
* **Minimale Rechte:** Host-Zugriff nur auf die eingetragene Tresor-Adresse, kein dauerhaftes Content-Script. Ausgefüllt wird nur auf Klick oder per `Strg+Umschalt+L` (über `activeTab`), nur im obersten Frame, nur bei exakt gleichem Host wie im Eintrag (ohne Subdomains) und nur über HTTPS.
* **Speicher:** Token und entschlüsselte Schlüssel liegen ausschließlich in `chrome.storage.session` (Arbeitsspeicher, für Content-Scripts gesperrt). Sperre nach Inaktivität (Zeit aus den Systemeinstellungen), beim Sperren des Rechners und beim Browser-Neustart. Kopierte Werte werden nach 30 Sekunden aus der Zwischenablage gelöscht.

Lokal bauen:

```bash
cd extension && npm install && npm run build
```

Danach `extension/dist` in `chrome://extensions` mit „Entpackte Erweiterung laden“ einbinden (Entwicklermodus).

Firefox (ab 140): `npm run build:firefox` erzeugt das Paket für addons.mozilla.org und das Quellcode-Archiv für die Prüfung (Bauanleitung: `extension/BUILD-FIREFOX.md`). Zum Testen `extension/dist/manifest.json` unter `about:debugging` → „Temporäres Add-on laden“ einbinden.

