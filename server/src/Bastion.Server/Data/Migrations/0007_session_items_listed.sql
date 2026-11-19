-- Erster vollständiger Abruf der Einträge je Sitzung wird protokolliert (Audit "items.listed"), weitere Abrufe derselben
-- Sitzung nicht: Ein Abzug des Tresors von einem neuen Gerät bzw. über die Browser-Erweiterung wird sichtbar,
-- ohne das Audit-Log bei jedem Neuladen zu füllen.
ALTER TABLE sessions ADD COLUMN items_listed_at timestamp with time zone;
