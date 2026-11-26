import { get } from './api';
import { keysFromRaw, type VaultKeys } from './crypto/account';
import { b64, unb64, wipe } from './crypto/encoding';
import { decryptJson, encryptJson, importAesKey } from './crypto/primitives';
import type { SessionInfo } from './types';

/**
 * Entsperrter Tresor übersteht ein Neuladen des Tabs (F5).
 *
 * Die Kontoschlüssel liegen dafür verschlüsselt im sessionStorage dieses Tabs. Der Schlüssel dazu kommt vom Server
 * (GET /auth/session/reload-key), existiert nur dort und gehört zu genau dieser Sitzung. Die Ablage allein ist damit
 * wertlos: Abmelden, Ablauf oder Widerruf der Sitzung, Sperren und Schließen des Tabs verwerfen den Zugang. Ein neuer
 * Tab hat ein eigenes sessionStorage und muss neu entsperrt werden. Nach Ablauf der Sperrzeit ohne Aktivität wird
 * nichts wiederhergestellt.
 */

const STORE = 'bastion.unlocked';
const ACTIVITY = 'bastion.activity';

interface Stored {
  v: 1;
  sessionId: string;
  userId: string;
  data: string;
}

const aad = (info: SessionInfo) => `bastion:reload:v1:${info.session.id}:${info.user.id}`;

async function reloadKey() {
  const { key } = await get<{ key: string }>('/auth/session/reload-key');
  const raw = unb64(key);
  try {
    return await importAesKey(raw);
  } finally {
    wipe(raw);
  }
}

function read(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ohne sessionStorage sperrt ein Neuladen wie bisher
  }
}

export function clearUnlocked() {
  try {
    sessionStorage.removeItem(STORE);
    sessionStorage.removeItem(ACTIVITY);
  } catch {
    // nichts abgelegt
  }
}

let lastActivityWrite = 0;

/** Letzte Aktivität vermerken (gedrosselt), damit ein Neuladen nach Ablauf der Sperrzeit gesperrt bleibt. */
export function noteActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastActivityWrite < 15_000) return;
  lastActivityWrite = now;
  write(ACTIVITY, String(now));
}

export async function saveUnlocked(info: SessionInfo, keys: VaultKeys, stillCurrent: () => boolean) {
  const key = await reloadKey();
  const data = await encryptJson(key, { a: b64(keys.accountKeyRaw), p: b64(keys.personalKeyRaw) }, aad(info));
  // Inzwischen gesperrt oder andere Schlüssel gesetzt: nichts (mehr) ablegen
  if (!stillCurrent()) return;
  const stored: Stored = { v: 1, sessionId: info.session.id, userId: info.user.id, data };
  write(STORE, JSON.stringify(stored));
  noteActivity(true);
}

export async function restoreUnlocked(info: SessionInfo): Promise<VaultKeys | null> {
  const value = read(STORE);
  if (!value) return null;
  try {
    const stored = JSON.parse(value) as Stored;
    const last = Number(read(ACTIVITY) ?? 0);
    const minutes = info.session.autoLockMinutes ?? 15;
    if (stored.v !== 1 || stored.sessionId !== info.session.id || stored.userId !== info.user.id || Date.now() - last > minutes * 60_000) {
      clearUnlocked();
      return null;
    }
    const plain = await decryptJson<{ a: string; p: string }>(await reloadKey(), stored.data, aad(info));
    const keys = await keysFromRaw(unb64(plain.a), unb64(plain.p), info.keys);
    noteActivity(true);
    return keys;
  } catch {
    clearUnlocked();
    return null;
  }
}
