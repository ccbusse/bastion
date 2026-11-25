# Bastion – Sicherheitskonzept

Dieses Dokument beschreibt die Sicherheitsarchitektur von Bastion und ordnet sie den Anforderungen des BSI zu
(TR-02102-1/-2, IT-Grundschutz-Bausteine ORP.4, CON.1, CON.10, APP.3.1, OPS.1.1.5, SYS.1.6).

## 1. Zero-Knowledge-Schlüsselhierarchie

```
Masterpasswort ─ Argon2id(Salt, 64 MiB, t=3, p=4) ─► MasterKey (256 Bit, nur im Browser)
   ├─ HKDF-SHA-256 "bastion:auth:v1" ─► AuthHash ──► Server: Argon2id(AuthHash) gespeichert
   └─ HKDF-SHA-256 "bastion:enc:v1"  ─► EncKey
         ├─ AES-256-GCM ─► AccountKey   ──┬─ AES-256-GCM ─► RSA-4096-Private-Key ─► Ordnerschlüssel
         │                                ├─ AES-256-GCM ─► Vertrauensanker (öffentliche Tenant-Schlüssel)
         │                                └─ RSA-OAEP(Tenant-Recovery-Public-Key) ─► Admin-Wiederherstellung
         └─ AES-256-GCM ─► PersonalKey  ─► persönlicher Tresor (nicht per Admin wiederherstellbar, siehe Notfall-Backup)

Je Ordner zwei zufällige AES-256-Schlüssel, RSA-OAEP-4096/SHA-256 je berechtigtem (beglaubigtem) Benutzer:
   Ordnerschlüssel  ─► overview  (alle mit vault.view)
   Geheim-Schlüssel ─► secret    (nur mit vault.reveal)
Eintrag: overview + secret, jeweils AES-256-GCM, AAD = "bastion:item:<id>:<teil>"
```

* **Der Server kennt keinen Klartext.** Er speichert nur Chiffretexte, öffentliche Schlüssel und einen doppelt gehashten Login-Wert.
* **Kontextbindung (AAD):** Ciphertexte sind an Eintrags-ID und Feldgruppe gebunden. Ein Vertauschen durch einen bösartigen Server fällt auf.
* **Trennung Übersicht/Geheimnis, auch kryptografisch:** Benutzer mit `vault.view` erhalten den Geheimteil nicht vom Server und besitzen auch den Schlüssel dafür nicht. Bestehende Ordner stellt der Browser eines Managers automatisch auf eigene Geheim-Schlüssel um (alle Geheimteile werden neu verschlüsselt).
* **Schlüssel nur im Arbeitsspeicher.** Sie werden nie persistiert. Auto-Lock nach Inaktivität (Standard 15 Min.), beim Neuladen ist der Tresor gesperrt.
* **Eigener Schlüssel geprüft:** Beim Entsperren prüft der Browser, dass der vom Server gelieferte eigene öffentliche Schlüssel zum (nur mit dem Masterpasswort entschlüsselbaren) privaten Schlüssel passt.

### Vertrauenskette für öffentliche Schlüssel

Schlüssel werden ausschließlich im Browser verschlüsselt, und zwar nur für Empfänger, deren öffentlicher Schlüssel **beglaubigt** ist:

* Jeder Tenant besitzt einen **Signaturschlüssel** (ECDSA P-256). Der private Teil ist wie der Recovery-Schlüssel mit dem AdminWrapKey geschützt, also nur Tenant-Admins mit Recovery-Zugang zugänglich.
* Ein Tenant-Admin beglaubigt einen Schlüssel erst nach dem **Fingerprint-Abgleich** über einen vertrauenswürdigen Kanal: Signatur über (Tenant, Benutzer, SHA-256 des öffentlichen Schlüssels). Der Fingerprint wird im Browser des Admins berechnet, nicht vom Server übernommen.
* Jeder Benutzer hält die öffentlichen Tenant-Schlüssel (Signatur und Recovery) als **Vertrauensanker**, AES-GCM-verschlüsselt mit seinem AccountKey. Der Server kann den Anker weder lesen noch unbemerkt austauschen. Festgelegt wird er bei der Einladung, beim Initialisieren des Tenants oder nachträglich – in beiden Fällen nur nach Eingabe des **Organisationscodes**.
* **Organisationscode:** die ersten 64 Bit des Fingerprints der Organisationsschlüssel, für alle Einladungen eines Tenants gleich (Tenant-Admins sehen ihn unter *Einstellungen* und beim Einladen). Die Administration gibt ihn auf einem anderen Weg als per E-Mail weiter. Der Browser prüft die vom Server gelieferten Organisationsschlüssel gegen den Code, **bevor** er ihnen vertraut und den eigenen AccountKey für die Wiederherstellung hinterlegt. Ein manipulierter Server bzw. eine manipulierte Datenbank kann keine eigenen Schlüssel mit demselben Code erzeugen.
* Vor jeder Weitergabe (Ordner-, Geheim- und Recovery-Schlüssel, neue Ordner, Hinterlegung des eigenen AccountKeys) prüft der Browser die Beglaubigung gegen den eigenen Anker. Meldet der Server andere Tenant-Schlüssel als den Anker, gibt der Browser nichts weiter und warnt.
* Dadurch erhält auch ein Angreifer mit **Schreibzugriff auf die Datenbank** keine Schlüssel: Er kann keine gültige Beglaubigung erzeugen.

### Herkunftsnachweis für Ordnerschlüssel

Ordnerschlüssel werden mit dem öffentlichen Schlüssel des Empfängers verpackt. Den kennt jeder, auch ein Angreifer mit Schreibzugriff auf die Datenbank: Ohne weiteren Schutz könnte er einen **eigenen** Schlüssel für einen Ordner unterschieben (oder einen präparierten Ordner anlegen) und alles mitlesen, was Mitglieder danach dort speichern. Deshalb gilt:

* Wer einen Ordnerschlüssel weitergibt (Anlegen eines Ordners, Verteilung an neue Berechtigte, Erneuerung), **signiert** jedes Schlüsselpaket mit seinem Kontoschlüssel (RSA-PSS). Die Signatur bindet Tenant, Ordner, Empfänger, Absender und beide verpackten Schlüssel (Ordner- und Geheim-Schlüssel).
* Der Browser des Empfängers verwendet einen Schlüssel nur, wenn die Signatur stimmt **und** der Schlüssel des Absenders vom Tenant beglaubigt ist (Prüfung gegen den eigenen Vertrauensanker) – oder wenn er das Paket selbst signiert hat. Öffentlicher Schlüssel und Beglaubigung des Absenders liegen mit im Datensatz, damit die Prüfung auch nach dessen Ausscheiden möglich bleibt.
* Schlüssel ohne gültigen Nachweis werden nicht geladen; die Oberfläche warnt, der Ordner bleibt unlesbar, bis ein Manager den Schlüssel erneuert. Der Server prüft die Signatur zusätzlich beim Speichern, maßgeblich ist aber die Prüfung im Browser.
* Wird jemandem das Recht „Passwörter anzeigen“ entzogen, entfernt der Server den Geheim-Schlüssel aus dem Paket und behält dessen SHA-256-Wert, damit die Signatur über den verbleibenden Ordnerschlüssel prüfbar bleibt.
* **Übernahme bestehender Schlüssel:** Konten aus der Zeit vor dem Nachweis bestätigen ihre bereits gehaltenen Schlüssel beim nächsten Entsperren einmalig selbst und vermerken das im Vertrauensanker (den nur der Inhaber des AccountKeys erzeugen kann) sowie im Browser. Neue Konten verwenden von Anfang an nur Schlüssel mit Nachweis.
* Grenzen: siehe Abschnitt 9.

### Algorithmen (BSI TR-02102-1, Stand 2025)

| Zweck | Verfahren | Bewertung |
|---|---|---|
| Passwort-KDF | Argon2id, 64 MiB, 3 Iterationen, 4 Lanes, 128-Bit-Salt | RFC 9106 Empfehlung, von TR-02102-1 empfohlen |
| Schlüsselableitung | HKDF-SHA-256 | empfohlen |
| Symmetrisch | AES-256-GCM, 96-Bit-Zufalls-IV, 128-Bit-Tag | empfohlen |
| Asymmetrisch | RSA-OAEP, 4096 Bit, SHA-256 | empfohlen (≥ 3000 Bit) |
| Beglaubigung | ECDSA P-256 mit SHA-256 | empfohlen |
| Herkunftsnachweis Ordnerschlüssel | RSA-PSS, 4096 Bit, SHA-256, Salt 32 Byte | empfohlen; derselbe Kontoschlüssel wie für RSA-OAEP (siehe Abschnitt 9) |
| Server-Hash | Argon2id (19 MiB, t=2) über den 256-Bit-AuthHash | Schutz bei DB-Leak |
| Server-Geheimnisse | AES-256-GCM, Schlüssel per HKDF aus `APP_SECRET` | TOTP-Secrets, SMTP-Passwort |
| Audit-Kette | HMAC-SHA-256, Schlüssel per HKDF aus `APP_SECRET` | Manipulationserkennung |
| Transport | TLS 1.2/1.3 via Caddy, HSTS | TR-02102-2 |

## 2. Authentifizierung und Sitzungen (ORP.4)

* **Masterpasswort-Richtlinie:** mindestens 12 Zeichen. Zeichenvielfalt abhängig von der Länge (12+: 4 Klassen, 16+: 3, 20+: 2), zxcvbn-Score ≥ 3, kein Bezug zu Name oder E-Mail, Abgleich mit HaveIBeenPwned per k-Anonymity. Durch Zero-Knowledge wird die Richtlinie im Client geprüft. Der Server erzwingt Mindestparameter für die KDF.
* **HaveIBeenPwned:** Nur die ersten 5 Zeichen des SHA-1-Hashes verlassen den Browser, und zwar im Body einer POST-Anfrage an den eigenen Proxy. So gelangen sie nicht in Zugriffsprotokolle des Reverse-Proxys.
* **Ersteinrichtung:** Einmal-Initialpasswort (Log oder ENV), danach Pflicht zum eigenen Masterpasswort. Vor Abschluss der Einrichtung wird bei jedem Neustart ein neues Initialpasswort erzeugt.
* **MFA:** TOTP (RFC 6238) mit 10 Einmal-Wiederherstellungscodes (gehasht). Ein Code ist nur einmal gültig (letzter Zeitschritt wird gespeichert), Wiederherstellungscodes werden atomar entwertet. Pflicht je Tenant bzw. für System-Admins konfigurierbar. Der Server erzwingt die Pflicht, nicht nur die UI. Einrichten und Abschalten verlangen das Masterpasswort (eine übernommene Sitzung kann keinen eigenen zweiten Faktor setzen); der Inhaber erhält jeweils eine Mail.
* **Brute-Force-Schutz:**
  * Passwortschritt: Sperre je Konto **und** IP-Adresse nach 5 Fehlversuchen (15 Min., steigend bis 24 h), zusätzlich IP-basiertes Rate-Limiting (60/Min.; bewusst so hoch, dass sich ein ganzes Büro hinter einer gemeinsamen Adresse anmelden kann). Bewusst nicht je Konto allein, sonst könnte jeder fremde Konten sperren. Online-Raten bleibt aussichtslos, da jeder Versuch eine Argon2id-Ableitung mit 64 MiB im Client erfordert. Die Zähler liegen in der Datenbank (Tabelle `login_throttle`, Schlüssel nur als HMAC, keine E-Mail- oder IP-Adressen im Klartext): Sperren überstehen einen Neustart und gelten für alle Instanzen.
  * Zweiter Faktor und erneute Passwortprüfung: Sperre je Konto nach 5 Fehlversuchen (15 Min. bis 24 h). Jeder Versuch wird **vor** der Prüfung atomar in der Datenbank verbucht, parallele Anfragen können die Grenze nicht umgehen.
  * Gleiche Antwortzeiten, gleiche Sperrlogik für unbekannte Adressen und Fake-KDF-Parameter verhindern User-Enumeration.
  * **Schutz vor Überlastung:** Der Server berechnet höchstens 16 Passwort-Hashes gleichzeitig (je 19 MiB), weitere Anfragen warten. Der öffentlich erreichbare HaveIBeenPwned-Proxy hält höchstens 256 Antworten zwischen und begrenzt deren Größe.
* **Sitzungen:** serverseitig, Token 256 Bit, in der DB nur als HMAC. Cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`. Leerlauf-Timeout 30 Min., absolute Laufzeit 12 h. Widerruf einzelner Sitzungen möglich. Bei Passwortwechsel, Deaktivierung oder Wiederherstellung werden alle anderen Sitzungen beendet.
* **Eingeschränkte Konten** (Bestätigung ausstehend, Passwortwechsel- oder MFA-Pflicht) erreichen serverseitig nur die dafür nötigen Endpunkte.
* **Erneute Passworteingabe für kritische Aktionen:** Eine übernommene Sitzung allein reicht nicht. Tenants löschen, Tenants beitreten (auch beim Anlegen), Tenant- und System-Admins einladen, Systemeinstellungen (u. a. 2FA-Pflicht für System-Admins), SMTP sowie Notfall-Backup-Ziele und deren Zeitplan anlegen, ändern, testen oder löschen erlaubt der Server nur innerhalb von 5 Minuten nach einer erneuten Eingabe des Masterpassworts **in derselben Sitzung** (sonst `403 REAUTH_REQUIRED`; der Web-Client fragt das Passwort dann ab). Notfallschlüssel, Export, Löschen des Notfallschlüssels, 2FA-Reset, 2FA abschalten und neue Wiederherstellungscodes verlangen das Passwort weiterhin bei jeder einzelnen Anfrage.
* **Benachrichtigungen an den Kontoinhaber:** Anmeldung aus einem bisher unbekannten Browser (kein gültiges Gerätecookie; nicht bei der ersten Anmeldung), Anmeldung mit einem Wiederherstellungscode, Passwortwechsel, 2FA abgeschaltet, neue Wiederherstellungscodes, viele Fehlversuche, Zurücksetzen durch einen Admin, jede Anmeldung über die Browser-Erweiterung (sie hat kein Gerätecookie).
* **Benachrichtigungen an die anderen System-Admins:** neuer System-Admin eingeladen, Tenant gelöscht, 2FA-Pflicht für System-Admins abgeschaltet, SMTP geändert, Notfall-Backup-Ziel angelegt, geändert oder gelöscht.

## 3. Benutzer-Lebenszyklus

1. **Einladung:** Token 256 Bit, 72 h gültig, einmalig verwendbar. Es steht im URL-Fragment und wird nur im Body von POST-Anfragen übertragen, gelangt also nicht in Server-Logs oder Referrer.
2. **Annahme:** Der Benutzer gibt den Organisationscode ein (Prüfung der Organisationsschlüssel im Browser), erzeugt alle Schlüssel lokal, legt den Vertrauensanker fest und sieht seinen Schlüssel-Fingerprint sowie den Fingerprint der Organisationsschlüssel. Bei initialisiertem Tenant wird der AccountKey für die Wiederherstellung hinterlegt.
3. **Bestätigung und Beglaubigung:** Der Admin gleicht den **Fingerprint des öffentlichen Schlüssels** (SHA-256, 128 Bit) und den Fingerprint der Organisationsschlüssel über einen vertrauenswürdigen Kanal ab. Bestätigt ein Tenant-Admin, beglaubigt er den Schlüssel im selben Schritt. Bestätigt jemand ohne Signaturschlüssel (Benutzerverwaltung, System-Admin), muss ein Tenant-Admin den Schlüssel noch beglaubigen. Erst dann erhält das Konto Schlüssel.
4. **Deaktivierung/Löschung:** Sitzungen, Ordnerschlüssel und Recovery-Grants werden entfernt.

## 4. Admin-Wiederherstellung

* Pro Tenant existiert ein RSA-4096-Recovery-Schlüsselpaar, erzeugt im Browser des ersten Tenant-Admins. Der private Teil liegt AES-verschlüsselt vor. Der dafür nötige Schlüssel ist für jeden (beglaubigten) Tenant-Admin einzeln per RSA verschlüsselt.
* Beim Zurücksetzen entschlüsselt der Admin **im Browser** den AccountKey des Benutzers und verpackt ihn mit einem temporären Passwort neu. Der Benutzer muss bei der nächsten Anmeldung ein eigenes Passwort setzen.
* **Nachweis:** Der Admin muss dem Server beweisen, dass er den AccountKey tatsächlich entschlüsselt hat (HKDF-Ableitung, deren SHA-256 der Benutzer hinterlegt hat). Ein Tenant-Admin ohne Recovery-Zugang kann so kein Konto übernehmen und keinen persönlichen Tresor löschen.
* **Persönliche Tresore sind ausgenommen:** Der PersonalKey hängt ausschließlich am Masterpasswort und wird bei einer Wiederherstellung verworfen.
* Jede Wiederherstellung wird protokolliert, der Benutzer wird per E-Mail informiert.
* Masterpasswörter von System-Admins sind nicht wiederherstellbar. Empfehlung: mindestens zwei System-Admins einrichten.

## 4a. Notfall-Backup

Für den Notfall lässt sich eine verschlüsselte Offline-Kopie aller freigegebenen Tresore erzeugen. Zero-Knowledge bleibt dabei erhalten: Der Server entschlüsselt nichts.

```
Notfallschlüssel (RSA-OAEP-4096), erzeugt im Browser eines System-Admins
  privater Teil: AES-256-GCM(K, PKCS8), K = HKDF-SHA-256(Schlüsselblatt ‖ Argon2id(Passphrase, 256 MiB, t=4, p=4))
     Schlüsselblatt: 256 Bit Zufall + 16-Bit-Prüfsumme, Base32 (Crockford), nur ausgedruckt, nie gespeichert
Freigabe je Tenant: ECDSA-Signatur des Tenant-Signaturschlüssels über (Tenant, Schlüssel-ID, SHA-256 des SPKI)
Schlüsselpakete:    RSA-OAEP(Notfallschlüssel, Ordner- bzw. Geheim-Schlüssel), RSA-OAEP(Notfallschlüssel, PersonalKey)
Backup-Datei:       AES-256-GCM(zufälliger Schlüssel, gzip(JSON)), AAD = Schlüssel-ID + Zeitpunkt,
                    zufälliger Schlüssel RSA-OAEP-verschlüsselt für den Notfallschlüssel
```

* **Zwei Faktoren:** Zum Entschlüsseln werden immer Schlüsselblatt **und** Passphrase benötigt. Der Server speichert nur den damit verschlüsselten privaten Schlüssel; ohne beide ist er wertlos. Geht einer der Faktoren verloren, sind alle Backups unbrauchbar.
* **Freigabe durch den Tenant:** Ein Tenant-Admin gleicht den Fingerprint ab und signiert den Notfallschlüssel mit dem Tenant-Signaturschlüssel. Browser verpacken Schlüssel nur, wenn diese Signatur gegen ihren eigenen Vertrauensanker gültig ist. Ein Server, der einen eigenen Schlüssel unterschiebt, erhält dadurch nichts.
* **Persönliche Tresore:** Mit der Freigabe eines Tenants verpackt der Browser jedes Mitglieds beim nächsten Entsperren automatisch auch seinen PersonalKey für den Notfallschlüssel, ohne gesonderte Zustimmung. Die Mitglieder sehen dazu einen Hinweis im persönlichen Tresor und unter *Mein Konto*. System-Admins nehmen ihren persönlichen Tresor nach eigener Bestätigung des Fingerprints auf (Bestätigung mit dem AccountKey versiegelt). Bei einer Admin-Wiederherstellung wird das Schlüsselpaket des alten PersonalKeys verworfen.
* **Rückzug:** Zieht ein Tenant-Admin die Freigabe zurück, werden alle Schlüsselpakete des Tenants gelöscht. Bereits exportierte Dateien bleiben unverändert lesbar.
* **Export:** nur durch System-Admins mit erneuter Eingabe des Masterpassworts; jede Einrichtung, Freigabe und jeder Export wird im Audit-Log protokolliert. Die Datei verrät ohne Notfallschlüssel auch keine Metadaten (Tenant-, Ordnernamen, E-Mail-Adressen).
* **Automatischer Export:** Der Server überträgt die fertige, verschlüsselte Datei an konfigurierte Ziele (Windows-Freigabe/NAS, Nextcloud bzw. WebDAV, SFTP inkl. Hetzner Storage Box, Ordner auf dem Server). Zugangsdaten der Ziele liegen mit `APP_SECRET` verschlüsselt in der Datenbank und werden nie an den Browser zurückgegeben. Windows-Freigaben werden über `smbclient` mit mindestens SMB2 angesprochen; die Zugangsdaten liegen dabei nur kurzzeitig in einer Datei mit Rechten 0600 in `/tmp`. Bei SFTP merkt sich Bastion die Server-Kennung beim Einrichten (Trust on First Use, wie OpenSSH); weicht sie später ab, schlägt der Export fehl, bis ein System-Admin die neue Kennung ausdrücklich übernimmt. Scheitert das Löschen alter Versionen (z. B. wegen eines Löschschutzes auf dem Ziel), gilt der Export trotzdem als erfolgreich. Jeder Lauf wird protokolliert, nach drei Fehlschlägen in Folge erhalten die System-Admins eine E-Mail.
* **Notfall-Werkzeug:** eine einzelne HTML-Datei, die offline in jedem aktuellen Browser läuft (CSP ohne Netzwerkzugriff) und dieselben Krypto-Module verwendet.
* **Grenzen:** Die Datei ist nicht signiert; wer den öffentlichen Notfallschlüssel kennt, könnte eine gefälschte Backup-Datei erzeugen. Aussagekräftig ist daher nur eine Datei, die aus Bastion selbst exportiert und offline verwahrt wurde. Ordner kommen erst ins Backup, wenn sich nach der Freigabe ein Schlüsselhalter mit Verwaltungsrecht anmeldet, persönliche Tresore erst nach der nächsten Anmeldung des Benutzers.

## 5. Autorisierung

* Jede Anfrage wird serverseitig gegen effektive Rechte geprüft. Die UI blendet nur zusätzlich aus.
* Vererbung Tenant → Abteilung → Ordner, abschaltbar je Ordner. Die Vererbung eines Ordners ändern nur Tenant-Admins und Manager dieses Ordners.
* **Keine Rechteausweitung:** Nur Tenant-Admins vergeben `tenant.admin`. Rollenverwalter vergeben nur Tenant-Rechte, die sie selbst besitzen. Tresorrechte vergibt jeder, auch ein Rollenverwalter, nur in Bereichen, in denen er diese Rechte selbst besitzt. Werden die Rechte einer Rolle geändert, prüft der Server das für jede bestehende Zuweisung.
* Ordner mit Einträgen löscht nur, wer den Ordner selbst verwalten darf. Gesperrte Ordner bleiben auch für Abteilungs-Manager unantastbar.
* Der letzte aktive Tenant-Admin kann nicht entfernt werden.
* Unternehmenseinträge können nicht in persönliche Tresore verschoben werden.
* System-Admins haben grundsätzlich **keinen** Zugriff auf Tenant-Tresore, sie verwalten nur Tenants und Tenant-Admins. Ausnahme ist das von Tenant-Admins freigegebene Notfall-Backup (Abschnitt 4a), das nur mit Schlüsselblatt und Passphrase lesbar ist.
* **Ausnahme: Mitgliedschaft.** Ein System-Admin kann Tenant-Admin eines oder mehrerer Tenants werden (beim Anlegen oder nachträglich). Nachträglich geht das standardmäßig nur mit **Zustimmung eines Tenant-Admins** (Tenant-Einstellung *Beitritt von System-Admins nur mit Zustimmung*, für neue und bestehende Tenants eingeschaltet): Der System-Admin stellt eine Anfrage, alle Tenant-Admins erhalten eine Mail, ein Tenant-Admin nimmt sie unter *Einstellungen* an (mit erneuter Passworteingabe) oder lehnt sie ab. Unbeantwortet verfällt sie nach 7 Tagen. Abschalten kann die Einstellung nur ein Tenant-Admin (die anderen werden informiert), nicht die Systemverwaltung. Hat der Tenant keinen aktiven Tenant-Admin, tritt der System-Admin direkt bei, denn sonst könnte niemand zustimmen. Anfrage, Rückzug, Zustimmung, Ablehnung und Beitritt werden protokolliert (`tenant.sysadmin_join_*`, `tenant.sysadmin_joined`). Schlüssel erhält er erst, wenn ein Tenant-Admin seinen Schlüssel nach Fingerprint-Abgleich **ausdrücklich beglaubigt**. Die Tenant-Admins sehen ihn dazu unter *Benutzer → Beglaubigung ausstehend*. Beim Verlassen des Tenants wird die Beglaubigung entfernt.
* **Schutz der System-Admin-Konten:** Tenant-Admins können System-Admin-Konten weder sperren, löschen, entsperren noch deren Masterpasswort oder 2FA zurücksetzen. Das verhindert eine Übernahme des Systemzugangs aus einem Tenant heraus.
* Beim Löschen eines Tenants werden Mitglieds-System-Admins nur gelöst, nicht gelöscht. Für Mitglieder gilt zusätzlich die 2FA-Richtlinie des Tenants.

## 6. Web-Sicherheit (APP.3.1, CON.10)

* Strikte **Content-Security-Policy:** `default-src 'self'`, ohne `unsafe-inline` und ohne `unsafe-eval`. Einzige Ausnahme ist `wasm-unsafe-eval`, das Argon2 als WebAssembly benötigt.
* `frame-ancestors 'none'`, HSTS (2 Jahre), `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, restriktive `Permissions-Policy`.
* **CSRF:** SameSite=Strict, Pflicht-Header `X-Requested-With` und Origin-Prüfung für alle zustandsändernden Anfragen.
* Eingabevalidierung aller Endpunkte (typisierte Request-Klassen mit Validierungsattributen), ORM mit parametrisierten Queries (Entity Framework Core), `Cache-Control: no-store` für die API.
* Links in Einträgen werden nur als `http(s)` geöffnet (`noopener noreferrer`). Die Zwischenablage wird nach 30 s geleert.
* **Browser-Erweiterung:** Ausfüllen nur nach Klick oder Tastenkürzel, nur im obersten Frame, nur auf HTTPS-Seiten und nur bei **exakt gleichem Host** wie im Eintrag hinterlegt (ein führendes `www.` zählt nicht). Subdomains werden bewusst nicht ausgefüllt.

## 7. Protokollierung (OPS.1.1.5)

* Sicherheitsrelevante Ereignisse werden protokolliert: Anmeldungen und Fehlversuche, MFA, Einladungen, Bestätigungen, Beglaubigungen, Rollenänderungen, Schlüsselverteilung, Wiederherstellung, Einträge, „Passwort angezeigt/kopiert“.
* **Manipulationsschutz:** Jeder Eintrag enthält einen HMAC über alle Felder und den Wert seines Vorgängers (Hash-Kette, Schlüssel aus `APP_SECRET`). Ohne `APP_SECRET` lässt sich die Kette nach einer Änderung nicht neu berechnen. Zusätzlich verhindert ein PostgreSQL-Trigger `UPDATE`, `DELETE` und `TRUNCATE`, und das Datenbankkonto der Anwendung darf das Audit-Log nur ergänzen (siehe 8). Die Integrität lässt sich unter *System → Audit-Log* prüfen. Einträge aus der Zeit vor der HMAC-Umstellung werden als „ältere Einträge“ ausgewiesen; ihre Anzahl ist einmalig festgehalten und mit `APP_SECRET` signiert, mehr davon gelten als Manipulation.
* **Externer Anker:** Der Kettenkopf (letzter Eintrag und Hash) steht stündlich im Server-Log und in jeder Notfall-Backup-Datei. Mit einem solchen früheren Kettenkopf als Anker prüft *System → Audit-Log*, dass die Kette bis dorthin unverändert ist; so fällt auch das Entfernen von Einträgen am Ende oder eine Neuberechnung der Kette auf.
* **Abruf des Tresors:** Der erste vollständige Abruf der Einträge je Sitzung wird serverseitig als `items.listed` protokolliert (Anzahl, Client Web bzw. Erweiterung). So wird sichtbar, wann ein neues Gerät den Tresor geladen hat; weitere Abrufe derselben Sitzung füllen das Log nicht.
* **Grenze bei Zero-Knowledge:** „Passwort angezeigt/kopiert“ und Exporte (`items.exported`) meldet der Browser selbst. Aussagekräftig ist das nur bei unverändertem Web-Client; wer `reveal` besitzt, erhält die Geheimteile ohnehin.
* Das Log enthält keine Geheimnisse und keine Klartextinhalte.
* **Kein Füllen ohne Anmeldung:** Fehlversuche mit unbekannten oder inaktiven Adressen werden je IP-Adresse höchstens 20-mal pro Stunde protokolliert (der letzte Eintrag trägt den Vermerk `furtherSuppressed`). Fehlversuche für bestehende Konten sind durch die Sperren je Konto ohnehin begrenzt.

## 8. Container- und Datenbank-Härtung (SYS.1.6)

* Multi-Stage-Build: Der Server (C#, .NET 10) wird „self-contained“ veröffentlicht und läuft auf `debian:trixie-slim` (glibc) ohne SDK, Compiler oder Paketmanager für Node. Die App läuft als unprivilegierter Benutzer `bastion` (uid 1000), die Anwendungsdateien gehören root; die Diagnose-Schnittstelle von .NET ist abgeschaltet.
* PostgreSQL in der Debian-Variante (`postgres:17-trixie`, glibc statt musl), mindestens 17.12.
* Reverse-Proxy: eigenes Image, Caddy aus dem Quellcode gebaut (Abhängigkeiten in `caddy/go.mod`, von Dependabot aktualisiert) auf Debian, läuft ohne Root-Rechte und ohne Capabilities (Ports 80/443 per `sysctl net.ipv4.ip_unprivileged_port_start=0` im Netz-Namensraum des Containers).
* Basis-Images sind per Digest fixiert (Dockerfiles, compose.yml).
* **Veröffentlichte Images (Lieferkette):** Der Workflow *Release* baut `bastion`, `bastion-caddy` und `bastion-backup` nur aus Commits mit grüner CI, prüft sie mit Trivy, veröffentlicht sie mit SBOM und Build-Herkunft (SLSA-Provenance) in `ghcr.io` und signiert sie mit cosign (keyless, Zertifikat an Workflow und Tag gebunden). Betreiber prüfen die Signatur vor der Installation (docs/OPERATIONS.de.md, Installation).
* `read_only`-Root-Dateisystem, `cap_drop: ALL`, `no-new-privileges`, tmpfs nur für `/tmp`.
* Obergrenzen für Arbeitsspeicher und Prozesszahl je Container (`mem_limit`, `pids_limit`; Arbeitsspeicher von Anwendung und Datenbank über `.env` anpassbar): Ein überlasteter Dienst reißt nicht den ganzen Host mit.
* Die Datenbank hängt ausschließlich am internen Netz `backend` (kein Internet, kein Port nach außen), SCRAM-SHA-256.
* **Ausgehende Verbindungen zu konfigurierbaren Zielen** (Exportziele WebDAV, SFTP, SMB sowie SMTP): keine Verbindung zu Loopback, Link-Local (u. a. Cloud-Metadaten), Multicast oder den Docker-Netzen des Containers. Der Name wird bei jedem Verbindungsaufbau einmal aufgelöst und geprüft; verbunden wird genau zu der geprüften Adresse (Schutz gegen DNS-Rebinding). HTTP-Weiterleitungen werden nicht verfolgt.
* **Getrennte Datenbankkonten:** Migrationen laufen im einmaligen Dienst `migrate` mit dem Eigentümer-Konto. Die Anwendung nutzt das Konto `bastion_app`: nur Lesen und Schreiben von Daten, keine Tabellen-Eigentümerschaft (kann also keine Trigger abschalten), Audit-Log nur anhängen, kein Zugriff auf die Migrationstabelle. Das Eigentümer-Passwort gelangt nicht in den Anwendungsprozess.
* `APP_SECRET` wird beim Start geprüft: Platzhalter aus `.env.example` und gleichförmige Werte werden abgelehnt.
* Healthchecks, `tini` als Init-Prozess.
* **Datenbank-Backup (CON.3, OPS.1.2.2):** Der Dienst `backup` sichert täglich mit `pg_dump` und verschlüsselt mit age (X25519, ChaCha20-Poly1305, authentifiziert) für öffentliche Schlüssel aus `BACKUP_AGE_RECIPIENTS`. Der private Schlüssel liegt nicht auf dem Server: Wer Server oder Backup-Ziel übernimmt, kann die Backups nicht lesen. Ohne öffentlichen Schlüssel wird nicht gesichert (kein Rückfall auf Klartext). Aufbewahrung nach Anzahl, damit ausgefallene Backups nie zum Löschen aller Sicherungen führen; Healthcheck `unhealthy`, wenn das letzte Backup älter als 26 Stunden ist. Der Dienst nutzt das Eigentümer-Konto der Datenbank (wie `migrate`), hängt nur am internen Netz, läuft als uid 1000 ohne Capabilities mit schreibgeschütztem Dateisystem. Die Wiederherstellung spielt in eine neue Datenbank ein und tauscht erst nach Erfolg; die bisherige bleibt erhalten, Rechte des App-Kontos setzt `migrate` neu. Nach einer Wiederherstellung endet die Audit-Kette am Stand des Backups: Spätere Kettenköpfe aus dem Log passen dann erwartungsgemäß nicht mehr. Die CI spielt Backup, Totalverlust und Wiederherstellung bei jedem Commit durch (`tests/backup/run.sh`).

## 9. Bekannte Grenzen und Roadmap

| Thema | Status / Empfehlung |
|---|---|
| **Schlüsselrotation nach Rechteentzug** | Umgesetzt: Wird jemandem ein Ordnerschlüssel entzogen (Rechte entfernt, Konto deaktiviert oder gelöscht), markiert der Server den Ordner. Ein Manager erneuert unter *Struktur* per Knopfdruck die Schlüssel: Sein Browser verschlüsselt alle Einträge neu und verteilt die Schlüssel an die aktuell Berechtigten. Ein behaltener alter Schlüssel ist danach wertlos. Was eine Person bereits gesehen oder kopiert hat, bleibt bekannt: kritische Passwörter zusätzlich ändern. Lassen sich Einträge nicht entschlüsseln, bricht die Erneuerung ohne Änderung ab und nennt sie; nur nach ausdrücklicher Bestätigung werden sie unverändert übernommen (danach endgültig unlesbar), vermerkt im Audit-Log (`folder.key_rotated`, `keptUnreadable`). |
| **Erstes Festlegen des Vertrauensankers** | Abgesichert durch den Organisationscode (Abschnitt 1): Der Browser vertraut Organisationsschlüsseln erst, wenn sie zum Code passen, den die Administration auf einem anderen Weg weitergibt. Voraussetzung ist, dass der Code tatsächlich außerhalb von Bastion übermittelt wird. Bei der einmaligen Umstellung bestehender Tenants auf Signaturschlüssel werden die bisherigen aktiven Mitglieder (ohne System-Admins) automatisch beglaubigt. |
| **Herkunftsnachweis für Ordnerschlüssel** | Umgesetzt (Abschnitt 1). Verbleibende Grenzen: (1) Der Nachweis belegt, dass der Absender ein vom Tenant beglaubigtes Mitglied ist, nicht dass er den Ordner verwalten darf; ein beglaubigtes Mitglied mit zusätzlichem Schreibzugriff auf die Datenbank könnte weiterhin einen Schlüssel unterschieben. Beglaubigungen laufen nicht ab, das gilt also auch für ausgeschiedene Mitglieder. (2) Wer die Datenbank beschreiben kann, kann ein Paket durch ein früheres, gültig signiertes desselben Ordners ersetzen (Schlüssel vor einer Erneuerung) oder den Vertrauensanker eines Kontos aus der Zeit vor dem Nachweis auf den alten Stand zurücksetzen; ein Browser, der das Konto bereits kannte, übernimmt dann nichts erneut, ein neuer Browser schon. (3) Die Browser-Erweiterung prüft den Nachweis nicht. Sie liest nur und speichert nichts, ein untergeschobener Schlüssel verschafft dort keinen Zugang zu Geheimnissen. (4) Signiert wird mit demselben RSA-Schlüssel, der auch dem Schlüsselaustausch dient (RSA-OAEP und RSA-PSS). Das vermeidet eine erneute Beglaubigung aller Konten; BSI TR-02102-1 empfiehlt getrennte Schlüssel je Zweck – eigene Signaturschlüssel je Konto stehen auf der Roadmap. |
| **Integrität des Web-Clients** | Wie bei jeder Web-App liefert der Server den Client-Code aus. Wer den Server bzw. das Image kontrolliert, kann manipulierten Code ausliefern. Betreiber prüfen die Signatur der Images (Abschnitt 8, docs/OPERATIONS.de.md) und schützen den Host vor Manipulation. |
| **WebAuthn / Passkeys** | Roadmap als zusätzlicher Faktor. |
| **SSO (SAML/OIDC)** | Roadmap. Mit Zero-Knowledge nur in Kombination mit Masterpasswort oder Key Connector sinnvoll. |
| **Papierkorb / Versionshistorie** | Papierkorb umgesetzt (2.3.0): Gelöschte Einträge bleiben verschlüsselt erhalten, bis sie aus dem Papierkorb endgültig gelöscht werden oder `TRASH_RETENTION_DAYS` (Standard 30) abläuft; Wiederherstellen und endgültiges Löschen mit denselben Rechten wie das Löschen, alles im Audit-Log (`item.deleted`, `item.restored`, `item.purged`, `items.purged_expired`). Die Schlüsselerneuerung verschlüsselt auch den Papierkorb neu. Gelöschte Einträge stehen nicht im Notfall-Backup, wohl aber im Datenbank-Backup. Versionshistorie: Roadmap. |
| **Penetrationstest** | Vor dem Produktivbetrieb wird ein externer Penetrationstest empfohlen. |

### Offene Punkte aus dem Sicherheitsaudit vom 2026-11-10

Umgesetzt in 2.0.0: Herkunftsnachweis für Ordnerschlüssel, Schutz vor Überlastung, Entfernen des Exportziels Cloud-Speicher (S3). Umgesetzt in 2.1.0: automatisches, verschlüsseltes Datenbank-Backup mit getesteter Wiederherstellung (Abschnitt 8); Festplattenverschlüsselung auf dem Host steht als Vorgabe in der Betriebsanleitung (docs/OPERATIONS.de.md, Produktion). Noch offen:

| Punkt | Problem | Vorschlag |
|---|---|---|
| **Versionsnummer öffentlich** | `GET /api/auth/status` und `/api/health` nennen die genaue Version ohne Anmeldung. Erleichtert gezielte Angriffe auf bekannte Schwachstellen. | Nur angemeldeten Benutzern anzeigen. Die Browser-Erweiterung prüft beim Verbinden, dass `version` ein Text ist: Das Feld muss bleiben (z. B. fester Wert). |
| **Getrennte Signaturschlüssel je Konto** | Der Herkunftsnachweis nutzt denselben RSA-Schlüssel wie der Schlüsselaustausch (siehe Zeile „Herkunftsnachweis“ oben). | Eigener Signaturschlüssel je Konto, mit Beglaubigung durch den Tenant. |

**Bewusste Entscheidungen (keine offenen Punkte):** Zwei-Faktor-Anmeldung bleibt freiwillig, auch für Administratoren. Der Notfallschlüssel bleibt ein Generalschlüssel: Wer Schlüsselblatt und Passphrase hält, kann alle freigegebenen Tresore lesen, einschließlich persönlicher.
