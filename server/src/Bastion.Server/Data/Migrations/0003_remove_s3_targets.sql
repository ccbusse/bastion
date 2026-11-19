-- Cloud-Speicher (S3) ist als Exportziel des Notfall-Backups entfallen: vorhandene S3-Ziele samt ihrer Zugangsdaten entfernen.
-- Bereits dorthin exportierte Backup-Dateien bleiben beim Anbieter unverändert liegen.
DELETE FROM emergency_targets WHERE type = 'S3';
