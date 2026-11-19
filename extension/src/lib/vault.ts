import { unlockWithEncKey, type ProtectedKeys, type VaultKeys } from '../../../web/src/lib/crypto/account';
import { b64, unb64 } from '../../../web/src/lib/crypto/encoding';
import { importAccountSignKey } from '../../../web/src/lib/crypto/trust';
import { decryptBytes, deriveLoginKeys, importAesKey, importPrivateKey, rsaUnwrap, type KdfParams } from '../../../web/src/lib/crypto/primitives';
import { decryptItem, type ItemKeys } from '../../../web/src/lib/items';
import type { DecryptedItem, EncryptedItem, SessionInfo, StructureInfo } from '../../../web/src/lib/types';
import { ApiError, api, normalizeVaultUrl } from './api';
import { clearSession, getSession, getSettings, removeSession, setSession, setSettings } from './storage';

export type VaultState = 'setup' | 'login' | 'mfa' | 'locked' | 'unlocked';

const LOCK_ALARM = 'bastion-auto-lock';

/** Zustand der Erweiterung, ohne den Server zu fragen. */
export async function currentState(): Promise<VaultState> {
  const [{ vaultUrl }, s] = await Promise.all([getSettings(), getSession()]);
  if (!vaultUrl) return 'setup';
  if (!s.token) return 'login';
  if (s.mfaPending) return 'mfa';
  return s.accountKeyRaw && s.personalKeyRaw ? 'unlocked' : 'locked';
}

/** Tresor-Adresse prüfen, Host-Zugriff nur für diese Adresse anfordern und speichern. */
export async function connectVault(input: string) {
  const origin = normalizeVaultUrl(input);
  // Muss aus einer Benutzeraktion heraus aufgerufen werden (Klick im Popup)
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) throw new ApiError(0, 'PERMISSION_DENIED');
  const status = await api<{ setupRequired?: boolean; version?: string }>('/auth/status', 'GET', undefined, { base: origin, auth: false });
  if (typeof status.version !== 'string') throw new ApiError(0, 'NOT_BASTION');
  const { vaultUrl: previous } = await getSettings();
  if (previous && previous !== origin) {
    await logout();
    // Zugriff auf den alten Tresor wieder abgeben
    await chrome.permissions.remove({ origins: [`${previous}/*`] }).catch(() => false);
  }
  await setSettings({ vaultUrl: origin });
  if (previous && previous !== origin) await chrome.storage.local.remove('scope');
  return { origin, version: status.version, setupRequired: !!status.setupRequired };
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `Bastion-Erweiterung · ${browser}${os ? ` · ${os}` : ''}`;
}

/**
 * Anmeldung: Masterpasswort wird lokal mit Argon2id abgeleitet; an den Server geht nur der Auth-Hash.
 * Der EncKey bleibt beim Aufrufer im Speicher, bis der zweite Faktor bestätigt ist.
 */
export async function login(email: string, password: string): Promise<{ mfaRequired: boolean; encKey: CryptoKey }> {
  const normalized = email.trim().toLowerCase();
  const kdf = await api<KdfParams>('/auth/prelogin', 'POST', { email: normalized }, { auth: false });
  const { authHash, encKey } = await deriveLoginKeys(password, kdf);
  const res = await api<{ mfaRequired: boolean; token: string | null }>('/auth/login', 'POST', { email: normalized, authHash, deviceLabel: deviceLabel() }, { auth: false });
  if (!res.token) throw new ApiError(0, 'UNKNOWN');
  await setSettings({ email: normalized });
  await setSession({ token: res.token, mfaPending: res.mfaRequired });
  if (!res.mfaRequired) await completeUnlock(encKey);
  return { mfaRequired: res.mfaRequired, encKey };
}

export async function verifyMfa(code: string, encKey: CryptoKey) {
  const res = await api<{ token: string | null }>('/auth/login/mfa', 'POST', { code: code.trim() });
  if (!res.token) throw new ApiError(0, 'UNKNOWN');
  await setSession({ token: res.token, mfaPending: false });
  await completeUnlock(encKey);
}

export async function sessionInfo() {
  try {
    return await api<SessionInfo>('/auth/session');
  } catch (e) {
    // Abgelaufene oder widerrufene Sitzung: neu anmelden
    if (e instanceof ApiError && e.status === 401) await clearSession();
    throw e;
  }
}

/** Schlüssel nach erfolgreicher Anmeldung oder Entsperrung im Sitzungsspeicher ablegen. */
async function completeUnlock(encKey: CryptoKey) {
  const info = await sessionInfo();
  const keys = await unlockWithEncKey(encKey, info.keys as ProtectedKeys);
  await setSession({ accountKeyRaw: b64(keys.accountKeyRaw), personalKeyRaw: b64(keys.personalKeyRaw), autoLockMinutes: info.session.autoLockMinutes });
  keys.accountKeyRaw.fill(0);
  keys.personalKeyRaw.fill(0);
  await touch();
  return info;
}

/** Entsperren einer noch gültigen Sitzung nur mit dem Masterpasswort (kein zweiter Faktor nötig). */
export async function unlock(password: string) {
  const info = await sessionInfo();
  const { encKey } = await deriveLoginKeys(password, info.keys);
  return completeUnlock(encKey);
}

/** Kontoschlüssel aus dem Sitzungsspeicher wiederherstellen. */
export async function loadKeys(info: SessionInfo): Promise<VaultKeys | null> {
  const s = await getSession();
  if (!s.accountKeyRaw || !s.personalKeyRaw) return null;
  const accountKeyRaw = unb64(s.accountKeyRaw);
  const personalKeyRaw = unb64(s.personalKeyRaw);
  const pkcs8 = await decryptBytes(await importAesKey(accountKeyRaw), info.keys.protectedPrivateKey, 'bastion:private-key');
  const privateKey = await importPrivateKey(pkcs8);
  // Die Erweiterung liest nur und gibt keine Schlüssel weiter; der Signierschlüssel gehört lediglich zum gemeinsamen Schlüsselsatz
  const signKey = await importAccountSignKey(pkcs8);
  pkcs8.fill(0);
  return { accountKeyRaw, personalKeyRaw, personalKey: await importAesKey(personalKeyRaw), privateKey, signKey, publicKey: info.keys.publicKey };
}

export interface VaultItem extends DecryptedItem {
  location: string;
}

/** Alle zugänglichen Einträge laden und lokal entschlüsseln. */
export async function loadVault(info: SessionInfo, keys: VaultKeys, personalLabel: string): Promise<VaultItem[]> {
  return (await loadVaultData(info, keys, personalLabel)).items;
}

/** Einträge und die sichtbare Struktur (Abteilungen, Ordnerbaum) für die Bereichsauswahl. */
export async function loadVaultData(info: SessionInfo, keys: VaultKeys, personalLabel: string): Promise<{ items: VaultItem[]; structure: StructureInfo }> {
  const [items, wrapped, structure] = await Promise.all([
    api<EncryptedItem[]>('/items'),
    api<{ folderId: string; wrappedKey: string; wrappedSecretKey: string | null }[]>('/keys/folders'),
    info.tenant ? api<StructureInfo>('/structure') : Promise.resolve({ departments: [] } as StructureInfo),
  ]);
  // Übersicht mit dem Ordnerschlüssel, Geheimteil mit dem eigenen Geheim-Schlüssel (ältere Ordner: Ordnerschlüssel)
  const folderKeys = new Map<string, ItemKeys>();
  await Promise.all(
    wrapped.map(async (w) => {
      try {
        const raw = await rsaUnwrap(keys.privateKey, w.wrappedKey);
        const overview = await importAesKey(raw);
        raw.fill(0);
        let secret = overview;
        if (w.wrappedSecretKey) {
          const secretRaw = await rsaUnwrap(keys.privateKey, w.wrappedSecretKey);
          secret = await importAesKey(secretRaw);
          secretRaw.fill(0);
        }
        folderKeys.set(w.folderId, { overview, secret });
      } catch {
        // ungültig verpackter Schlüssel: Ordner bleibt unlesbar
      }
    }),
  );
  const labels = new Map<string, string>();
  for (const d of structure.departments) for (const f of d.folders) labels.set(f.id, `${d.name} / ${f.path}`);
  const out = await Promise.all(
    items.map(async (i) => ({
      ...(await decryptItem(i.personal ? { overview: keys.personalKey, secret: keys.personalKey } : folderKeys.get(i.folderId!), i)),
      location: i.personal ? personalLabel : (labels.get(i.folderId!) ?? ''),
    })),
  );
  const sorted = out.filter((i) => !i.error).sort((a, b) => (a.overview.name || '').localeCompare(b.overview.name || '', undefined, { sensitivity: 'base' }));
  return { items: sorted, structure };
}

/** Zugriff auf Unternehmenseinträge protokollieren (Audit-Log), wie in der Web-App. */
export function logEvent(item: DecryptedItem, field: string) {
  if (item.personal) return Promise.resolve();
  return api(`/items/${item.id}/events`, 'POST', { event: 'copy', field: field.slice(0, 40) }).catch(() => undefined);
}

/** Aktivität verlängert die automatische Sperre. */
export async function touch() {
  const s = await getSession();
  if (!s.accountKeyRaw) return;
  const minutes = Math.max(1, s.autoLockMinutes ?? 15);
  const lockAt = Date.now() + minutes * 60_000;
  await setSession({ lockAt });
  await chrome.alarms.create(LOCK_ALARM, { when: lockAt });
}

/** Sperren: Schlüssel verwerfen, Sitzung bleibt bestehen (Entsperren nur mit Masterpasswort). */
export async function lock() {
  await removeSession(['accountKeyRaw', 'personalKeyRaw', 'lockAt']);
  await chrome.alarms.clear(LOCK_ALARM);
}

export async function logout() {
  await api('/auth/logout', 'POST', {}).catch(() => undefined);
  await clearSession();
  await chrome.alarms.clear(LOCK_ALARM);
}

export { LOCK_ALARM };
