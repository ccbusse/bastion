-- Erneute Bestätigung mit dem Masterpasswort je Sitzung: kritische Aktionen (Tenant löschen, System-Admins einladen,
-- Exportziele, SMTP …) sind nur kurz nach einer solchen Bestätigung erlaubt.
ALTER TABLE sessions ADD COLUMN reauth_at timestamp with time zone;
