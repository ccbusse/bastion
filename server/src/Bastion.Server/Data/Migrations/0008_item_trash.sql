-- Papierkorb: Gelöschte Einträge bleiben (verschlüsselt) erhalten, bis sie endgültig gelöscht werden oder die Frist
-- TRASH_RETENTION_DAYS abläuft. Die Liste der Einträge (auch für die Browser-Erweiterung) blendet sie aus.
ALTER TABLE items ADD COLUMN deleted_at timestamp with time zone;
ALTER TABLE items ADD COLUMN deleted_by_id uuid;
CREATE INDEX ix_items_deleted_at ON items (deleted_at);
