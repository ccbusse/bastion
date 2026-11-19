-- Einführung für neue Benutzer: Kurztour gesehen/übersprungen, Checkliste "Erste Schritte" ausgeblendet.
ALTER TABLE users ADD COLUMN tour_completed_at timestamp with time zone;
ALTER TABLE users ADD COLUMN checklist_hidden_at timestamp with time zone;
-- Wer Bastion schon benutzt hat, bekommt die Tour für Neue nicht nachträglich (starten lässt sie sich jederzeit unter "Hilfe").
UPDATE users SET tour_completed_at = now() WHERE last_login_at IS NOT NULL;
