/**
 * Ablage der Erweiterung.
 * - storage.local (dauerhaft): nur unkritische Einstellungen (Tresor-URL, zuletzt genutzte E-Mail,
 *   gewählter Suchbereich als Kennungen von Abteilung/Ordner – keine Namen oder Inhalte)
 * - storage.session (nur im Arbeitsspeicher, beim Browser-Neustart gelöscht, für Content-Scripts gesperrt):
 *   Sitzungs-Token, entschlüsselte Kontoschlüssel sowie Suchbegriff und zuletzt geöffneter Eintrag des Popups
 */

/** Suchbereich im Popup: dept "" = alle, "personal" = persönlicher Tresor, sonst Abteilungs-ID; folder "" = alle Ordner */
export interface SearchScope {
  tenantId: string | null;
  dept: string;
  folder: string;
}

export interface Settings {
  vaultUrl?: string;
  email?: string;
  scope?: SearchScope;
}

export interface SessionState {
  token?: string;
  /** Sitzung wartet auf den zweiten Faktor */
  mfaPending?: boolean;
  /** Entschlüsselte Schlüssel (Base64), nur solange entsperrt */
  accountKeyRaw?: string;
  personalKeyRaw?: string;
  /** Zeitpunkt der automatischen Sperre (ms) */
  lockAt?: number;
  /** Sperrzeit aus den Systemeinstellungen (Minuten) */
  autoLockMinutes?: number;
  /** Suchbegriff im Popup (bleibt bis zum Löschen der Suche oder zum Browser-Neustart) */
  popupQuery?: string;
  /** ID des zuletzt geöffneten Eintrags (bis „Zurück“) */
  popupSelected?: string;
}

export async function getSettings(): Promise<Settings> {
  return (await chrome.storage.local.get(['vaultUrl', 'email', 'scope'])) as Settings;
}

export function setSettings(s: Partial<Settings>) {
  return chrome.storage.local.set(s);
}

export async function getSession(): Promise<SessionState> {
  return (await chrome.storage.session.get(null)) as SessionState;
}

export function setSession(s: Partial<SessionState>) {
  return chrome.storage.session.set(s);
}

export function removeSession(keys: (keyof SessionState)[]) {
  return chrome.storage.session.remove(keys);
}

export function clearSession() {
  return chrome.storage.session.clear();
}

/** Sitzungsspeicher nur für Erweiterungsseiten und Service Worker freigeben, nie für Content-Scripts. */
export function restrictSessionStorage() {
  return chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}
