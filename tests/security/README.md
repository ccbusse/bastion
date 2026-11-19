# Sicherheits-Regressionstests

Automatisierte Prüfungen aus dem Security Assessment. Sie laufen gegen eine frische, isolierte
Testinstanz und decken ab:

| Datei | Inhalt |
|---|---|
| `audit.test.mjs` | Audit-Kette mit externem Anker (F-09), Protokollierung von Exporten (F-08), erster Abruf der Einträge je Sitzung (items.listed) |
| `auth.test.mjs` | Anmeldung, CSRF, Sessions, Token der Browser-Erweiterung, Fehlerbehandlung |
| `authz.test.mjs` | Mandantentrennung und Rollen (Betrachter, Bearbeiter, Benutzer- und Rollenverwaltung, Manager, System-Admin) |
| `mfa.test.mjs` | Zweiter Faktor: Replay, Sperre, Wiederherstellungscodes, MFA-Pflicht für System-Admins (F-06) |
| `login-protection.test.mjs` | Login-Sperre, Gerätecookie, kontoweites Limit, Zähler in der Datenbank über einen Neustart hinweg (F-05) |
| `organization-code.test.mjs` | Organisationscode gegen untergeschobene Organisationsschlüssel (F-12) |
| `recovery.test.mjs` | Admin-Wiederherstellung und neuer persönlicher Schlüssel (F-01) |
| `rotation.test.mjs` | Ordnerschlüssel erneuern nach Rechteentzug: alter Schlüssel wertlos, Berechtigte lesen weiter, nicht lesbare Einträge werden gemeldet und nur bestätigt übernommen |
| `targets.test.mjs` | Exportziele und SMTP: Bindung der Zugangsdaten (F-02), keine internen Ziele (F-03), nur verschlüsselte Anmeldung (F-10) |
| `notifications.test.mjs` | Benachrichtigungen bei Eingriffen von System-Admins (F-07), Einladungs-Kollisionen (F-04) |
| `reauth.test.mjs` | Erneute Passworteingabe für kritische System-Admin-Aktionen, Hinweise an andere System-Admins und an Kontoinhaber (neues Gerät, Browser-Erweiterung), 2FA einrichten nur mit Masterpasswort |
| `join-approval.test.mjs` | Beitritt von System-Admins nur mit Zustimmung eines Tenant-Admins: Anfrage, Zustimmung (mit erneuter Passworteingabe), Ablehnung, Rückzug, Verfall, Einstellung |
| `trash.test.mjs` | Papierkorb: Löschen verschiebt nur, Wiederherstellen und endgültiges Löschen nur mit Bearbeitungsrecht, Mandantentrennung, Schlüsselerneuerung schließt den Papierkorb ein, automatisches Leeren nach Ablauf der Frist |
| `onboarding.test.mjs` | Erste Schritte: nur die Schritte der eigenen Rolle, abgeleitet aus dem tatsächlichen Zustand; Tour-/Checklisten-Merker nur für das eigene Konto; Stand des Datenbank-Backups nur für System-Admins und dessen Bewertung |

Der Testclient bestätigt die Sitzung wie der Web-Client automatisch mit dem Masterpasswort, wenn der Server `403 REAUTH_REQUIRED`
meldet; `{ reauth: false }` schaltet das für einzelne Anfragen ab.

Der Testclient verwendet dieselben Krypto-Module wie der Web-Client (gebündelt über `vite.crypto.config.mjs`).

## Ausführen

```bash
cd web && npm ci && cd ..
docker build -t bastion:latest .   # oder BUILD=1 beim Aufruf unten
bash tests/security/run.sh
```

`run.sh` startet ein eigenes Compose-Projekt (`bastion-sectest-ci`) mit zufälligen Secrets, legt Testdaten an
(`seed.mjs`), führt die Tests aus und entfernt die Instanz danach samt Volumes. `KEEP=1` lässt sie zur Fehlersuche stehen.

**Hinweis:** `compose.test.yml` macht die App ohne Reverse-Proxy auf `127.0.0.1:13000` erreichbar und schaltet Secure-Cookies ab.
Sie ist ausschließlich für diese Tests gedacht.
