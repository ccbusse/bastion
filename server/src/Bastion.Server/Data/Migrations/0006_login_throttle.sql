-- Zähler der Login-Drossel (F-05): bisher im Arbeitsspeicher, jetzt in der Datenbank, damit Sperren einen Neustart
-- überstehen und für alle Instanzen gelten. Schlüssel sind HMAC-Werte (keine E-Mail- oder IP-Adressen im Klartext).
CREATE TABLE login_throttle (
    key text NOT NULL,
    failed integer NOT NULL,
    window_start timestamp with time zone NOT NULL,
    touched timestamp with time zone NOT NULL,
    blocked_until timestamp with time zone,
    CONSTRAINT pk_login_throttle PRIMARY KEY (key)
);

CREATE INDEX ix_login_throttle_touched ON login_throttle (touched);
