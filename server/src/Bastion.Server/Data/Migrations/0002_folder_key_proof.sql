-- Herkunftsnachweis für Ordnerschlüssel: Der Absender signiert jedes Schlüsselpaket (RSA-PSS mit seinem beglaubigten
-- Kontoschlüssel). Der Browser des Empfängers prüft die Signatur, bevor er den Schlüssel verwendet. So kann jemand mit
-- Schreibzugriff auf die Datenbank keinen eigenen Ordnerschlüssel unterschieben.
ALTER TABLE folder_keys ADD signer_id uuid;
ALTER TABLE folder_keys ADD signer_public_key text;
ALTER TABLE folder_keys ADD signer_endorsement text;
ALTER TABLE folder_keys ADD signature text;
ALTER TABLE folder_keys ADD stripped_secret_hash text;
