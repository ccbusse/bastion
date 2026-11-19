import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { get, post, put } from '../lib/api';
import { AAD, createLegacyTenantSigning, createTenantRecovery, openTenantAdminKeys, VaultKeys } from '../lib/crypto/account';
import { Bytes, randomBytes } from '../lib/crypto/encoding';
import { decryptJson, encryptJson, importAesKey, rsaUnwrap, rsaWrap } from '../lib/crypto/primitives';
import {
  FolderKeyPackage,
  folderKeyTrusted,
  openAnchor,
  recoveryVerifier,
  sealAnchor,
  signEndorsement,
  signFolderKey,
  TenantAnchor,
  verifyEndorsement,
} from '../lib/crypto/trust';
import { decryptItem, ItemKeys } from '../lib/items';
import type { DecryptedItem, DecryptedTrashItem, EncryptedItem, EncryptedTrashItem, SessionInfo, StructureInfo, UserRow } from '../lib/types';
import { reencryptFolderItems, type UnreadableItem } from '../lib/crypto/rotation';
import { runEmergencyMaintenance } from './emergency';
import { useUnlocked } from './session';

interface FolderKeyEntry {
  raw: Bytes;
  key: CryptoKey;
  /** Ordner mit eigenem Schlüssel für Geheimteile */
  secretKeyed: boolean;
  secretRaw?: Bytes;
  secretKey?: CryptoKey;
  /** Verpackte Form wie vom Server geliefert (erkennt Änderungen; Grundlage des eigenen Herkunftsnachweises) */
  wrappedKey: string;
  wrappedSecretKey: string | null;
}

/** Schlüsselpaket vom Server samt Angabe, ob der Ordner einen eigenen Geheim-Schlüssel hat. */
interface WrappedFolderKey extends FolderKeyPackage {
  secretKeyed: boolean;
}

/** Cache entschlüsselter Ordnerschlüssel (nur im Speicher, gebunden an die aktuellen Kontoschlüssel). */
const folderKeyCache = new WeakMap<VaultKeys, Map<string, FolderKeyEntry>>();

function cacheFor(keys: VaultKeys) {
  let m = folderKeyCache.get(keys);
  if (!m) folderKeyCache.set(keys, (m = new Map()));
  return m;
}

/** Ordner, deren Schlüssel beim letzten Laden nicht geprüft werden konnten (siehe loadFolderKeys). */
const untrustedFolders = new WeakMap<VaultKeys, Set<string>>();

export function untrustedFolderKeyCount(keys: VaultKeys) {
  return untrustedFolders.get(keys)?.size ?? 0;
}

/** Zuletzt geöffneter Vertrauensanker je Tenant (spart die Abfrage bei jedem Laden der Ordnerschlüssel). */
const anchorCache = new WeakMap<VaultKeys, Map<string, TenantAnchor>>();

async function anchorFor(info: SessionInfo, keys: VaultKeys): Promise<TenantAnchor | null> {
  if (!info.tenant) return null;
  return anchorCache.get(keys)?.get(info.tenant.id) ?? (await loadTrust(info, keys))?.anchor ?? null;
}

function rememberAnchor(info: SessionInfo, keys: VaultKeys, anchor: TenantAnchor) {
  let m = anchorCache.get(keys);
  if (!m) anchorCache.set(keys, (m = new Map()));
  m.set(info.tenant!.id, anchor);
}

// Dieser Browser merkt sich, dass die einmalige Übernahme alter Ordnerschlüssel für das Konto erfolgt ist. Setzt jemand
// den Vertrauensanker in der Datenbank auf einen früheren Stand zurück, öffnet sich das Übernahme-Fenster hier nicht erneut.
const migratedFlag = (info: SessionInfo) => `bastion.fka.${info.user.id}.${info.tenant?.id ?? ''}`;

function locallyMigrated(info: SessionInfo) {
  try {
    return localStorage.getItem(migratedFlag(info)) === '1';
  } catch {
    return false;
  }
}

function rememberMigrated(info: SessionInfo) {
  try {
    localStorage.setItem(migratedFlag(info), '1');
  } catch {
    // ohne Speicher gilt nur der Vermerk im Anker
  }
}

/**
 * Ordnerschlüssel des aktiven Tenants laden. Verwendet wird ein Schlüssel nur mit gültigem Herkunftsnachweis: Sonst
 * könnte jemand mit Schreibzugriff auf die Datenbank einen eigenen Schlüssel unterschieben und alles mitlesen, was
 * danach in dem Ordner gespeichert wird. Schlüssel ohne Nachweis (aus der Zeit davor) gelten nur, bis der Browser sie
 * einmalig übernommen hat (attestLegacyFolderKeys).
 */
export async function loadFolderKeys(info: SessionInfo, keys: VaultKeys) {
  const cache = cacheFor(keys);
  const tenantId = info.tenant?.id;
  const wrapped = (await get<WrappedFolderKey[]>('/keys/folders')).filter((w) => w.tenantId === tenantId);
  const present = new Map(wrapped.map((w) => [w.folderId, w]));
  // Entfernte und geänderte Schlüssel neu laden
  for (const [id, e] of cache) {
    const w = present.get(id);
    if (!w || w.secretKeyed !== e.secretKeyed || w.wrappedKey !== e.wrappedKey || (w.wrappedSecretKey ?? null) !== e.wrappedSecretKey) cache.delete(id);
  }
  const fresh = wrapped.filter((w) => !cache.has(w.folderId));
  const untrusted = new Set<string>();
  if (fresh.length) {
    const anchor = await anchorFor(info, keys);
    const legacyAllowed = !!anchor && !anchor.folderKeyAuth && !locallyMigrated(info);
    await Promise.all(
      fresh.map(async (w) => {
        try {
          if (!(w.signature ? await folderKeyTrusted({ userId: info.user.id, publicKey: keys.publicKey }, anchor, w) : legacyAllowed)) {
            untrusted.add(w.folderId);
            return;
          }
          const raw = await rsaUnwrap(keys.privateKey, w.wrappedKey);
          const entry: FolderKeyEntry = { raw, key: await importAesKey(raw), secretKeyed: w.secretKeyed, wrappedKey: w.wrappedKey, wrappedSecretKey: w.wrappedSecretKey ?? null };
          if (w.wrappedSecretKey) {
            entry.secretRaw = await rsaUnwrap(keys.privateKey, w.wrappedSecretKey);
            entry.secretKey = await importAesKey(entry.secretRaw);
          }
          cache.set(w.folderId, entry);
        } catch {
          // ungültig verpackter Schlüssel – Ordner bleibt unlesbar
          untrusted.add(w.folderId);
        }
      }),
    );
  }
  untrustedFolders.set(keys, untrusted);
  return cache;
}

/**
 * Einmalige Übernahme der Ordnerschlüssel aus der Zeit vor dem Herkunftsnachweis: Der Browser bestätigt die bereits
 * gehaltenen Schlüssel mit einer eigenen Signatur und vermerkt das im Vertrauensanker (den nur er selbst erzeugen kann).
 * Danach gelten ausschließlich Schlüssel mit gültigem Nachweis.
 */
async function attestLegacyFolderKeys(info: SessionInfo, keys: VaultKeys, anchor: TenantAnchor): Promise<TenantAnchor> {
  if (anchor.folderKeyAuth) {
    rememberMigrated(info);
    return anchor;
  }
  // Anker ohne Vermerk, obwohl dieser Browser die Übernahme schon kennt: nichts erneut übernehmen
  if (locallyMigrated(info)) return anchor;
  const tenantId = info.tenant!.id;
  const me = info.user.id;
  const legacy = (await get<WrappedFolderKey[]>('/keys/folders')).filter((w) => w.tenantId === tenantId && !w.signature);
  const attestations = await Promise.all(
    legacy.map(async (w) => ({
      folderId: w.folderId,
      signature: await signFolderKey(keys.signKey, { tenantId, folderId: w.folderId, recipientId: me, signerId: me }, w.wrappedKey, w.wrappedSecretKey),
    })),
  );
  const next: TenantAnchor = { ...anchor, folderKeyAuth: 1 };
  await post('/keys/folders/attest', { attestations, anchor: await sealAnchor(keys.accountKeyRaw, tenantId, next) });
  rememberMigrated(info);
  rememberAnchor(info, keys, next);
  return next;
}

/** Schlüsselpaket für einen Empfänger: Ordnerschlüssel (und ggf. Geheim-Schlüssel) verpackt, mit eigenem Herkunftsnachweis. */
async function wrapSigned(info: SessionInfo, keys: VaultKeys, folderId: string, recipientId: string, publicKey: string, raw: Bytes, secretRaw: Bytes | null) {
  const wrappedKey = await rsaWrap(publicKey, raw);
  const wrappedSecretKey = secretRaw ? await rsaWrap(publicKey, secretRaw) : undefined;
  const signature = await signFolderKey(keys.signKey, { tenantId: info.tenant!.id, folderId, recipientId, signerId: info.user.id }, wrappedKey, wrappedSecretKey);
  return { wrappedKey, ...(wrappedSecretKey ? { wrappedSecretKey } : {}), signature };
}

export function getFolderKey(keys: VaultKeys, folderId: string) {
  return cacheFor(keys).get(folderId);
}

/** Schlüssel zum Ver- und Entschlüsseln eines Eintrags am Zielort (persönlich oder Ordner). */
export function itemKeysFor(keys: VaultKeys, target: string | null): ItemKeys {
  if (!target || target === 'personal') return { overview: keys.personalKey, secret: keys.personalKey };
  const entry = getFolderKey(keys, target);
  if (!entry) throw new Error('FOLDER_KEY_MISSING');
  if (entry.secretKeyed && !entry.secretKey) throw new Error('SECRET_KEY_MISSING');
  return { overview: entry.key, secret: entry.secretKey ?? entry.key };
}

// ---------- Vertrauensanker ----------

export interface TrustState {
  /** Festgehaltene Tenant-Schlüssel (null = noch kein Anker) */
  anchor: TenantAnchor | null;
  /** Vom Server aktuell gemeldete Tenant-Schlüssel */
  server: { signingPublicKey: string | null; recoveryPublicKey: string | null };
  /** Server meldet andere Schlüssel als den festgehaltenen Anker */
  mismatch: boolean;
}

export async function loadTrust(info: SessionInfo, keys: VaultKeys): Promise<TrustState | null> {
  if (!info.tenant) return null;
  const res = await get<{ anchor: string | null; signingPublicKey: string | null; recoveryPublicKey: string | null }>('/keys/anchor');
  const server = { signingPublicKey: res.signingPublicKey, recoveryPublicKey: res.recoveryPublicKey };
  if (!res.anchor) return { anchor: null, server, mismatch: false };
  const anchor = await openAnchor(keys.accountKeyRaw, info.tenant.id, res.anchor).catch(() => null);
  // Nicht entschlüsselbarer Anker: manipuliert. Nicht ersetzen, sondern als Abweichung melden.
  if (!anchor) return { anchor: null, server, mismatch: true };
  rememberAnchor(info, keys, anchor);
  return { anchor, server, mismatch: anchor.signingPublicKey !== server.signingPublicKey || anchor.recoveryPublicKey !== server.recoveryPublicKey };
}

/** Vom Benutzer bestätigte Tenant-Schlüssel als Vertrauensanker festhalten. */
export async function pinTrust(info: SessionInfo, keys: VaultKeys, anchor: TenantAnchor) {
  await put('/keys/anchor', { data: await sealAnchor(keys.accountKeyRaw, info.tenant!.id, anchor) });
}

/** Öffentlicher Schlüssel eines Empfängers, nur wenn beglaubigt (eigener Schlüssel ist beim Entsperren geprüft). */
async function trustedKey(info: SessionInfo, keys: VaultKeys, anchor: TenantAnchor, r: { userId: string; publicKey: string | null; endorsement?: string | null }) {
  if (r.userId === info.user.id) return keys.publicKey;
  if (!r.publicKey) return null;
  return (await verifyEndorsement(anchor.signingPublicKey, info.tenant!.id, r.userId, r.publicKey, r.endorsement)) ? r.publicKey : null;
}

// ---------- Schlüsselpflege ----------

export interface MaintenanceResult {
  shared: number;
  needsAnchor: boolean;
  anchorMismatch: boolean;
  /** Ordner, deren Schlüssel ohne gültigen Herkunftsnachweis vorliegen und deshalb nicht verwendet werden */
  untrustedKeys: number;
  trust: TrustState | null;
}

/**
 * Hintergrundaufgaben nach dem Entsperren:
 * 1. Tenant-Schlüssel initialisieren (erster Tenant-Admin) bzw. Signaturschlüssel nachrüsten
 * 2. Vertrauensanker prüfen; ohne Anker wird nichts verteilt (der Benutzer bestätigt ihn in der Oberfläche)
 * 3. Eigenen AccountKey und Nachweis-Prüfwert für die Admin-Wiederherstellung hinterlegen
 * 4. Ordnerschlüssel aus der Zeit vor dem Herkunftsnachweis einmalig übernehmen
 * 5. Bestehende Ordner auf eigene Geheim-Schlüssel umstellen (Manager)
 * 6. Offene Schlüsselfreigaben an beglaubigte Berechtigte verteilen
 */
export async function runKeyMaintenance(info: SessionInfo, keys: VaultKeys): Promise<MaintenanceResult> {
  const result = await runTenantMaintenance(info, keys);
  // 7. Notfall-Backup: Schlüssel zusätzlich für den freigegebenen Notfallschlüssel verpacken
  await runEmergencyMaintenance(info, keys, result.trust).catch(() => undefined);
  return result;
}

async function runTenantMaintenance(info: SessionInfo, keys: VaultKeys): Promise<MaintenanceResult> {
  const none: MaintenanceResult = { shared: 0, needsAnchor: false, anchorMismatch: false, untrustedKeys: 0, trust: null };
  if (!info.tenant || info.user.status !== 'ACTIVE') return none;
  if (!info.keys.hasRecoveryVerifier) await put('/keys/recovery-verifier', { recoveryVerifier: await recoveryVerifier(keys.accountKeyRaw) }).catch(() => undefined);
  if (!info.tenant.keysInitialized) {
    if (!info.permissions.isTenantAdmin) return none;
    await post('/keys/tenant-init', await createTenantRecovery(info.tenant.id, info.user.id, keys));
  } else if (!info.tenant.signingInitialized && info.permissions.isTenantAdmin) {
    await initLegacySigning(info, keys).catch(() => undefined);
  }
  const trust = await loadTrust(info, keys);
  if (!trust?.anchor) return { ...none, needsAnchor: !!trust?.server.signingPublicKey && !trust.mismatch, anchorMismatch: !!trust?.mismatch, trust };
  if (!info.keys.hasRecoveryAccountKey) {
    await put('/keys/recovery-account', { recoveryAccountKey: await rsaWrap(trust.anchor.recoveryPublicKey, keys.accountKeyRaw) }).catch(() => undefined);
  }
  // Bei abweichenden Tenant-Schlüsseln (möglicher Manipulation) wird nichts ungeprüft übernommen
  const pinned = trust.anchor;
  if (!trust.mismatch) trust.anchor = await attestLegacyFolderKeys(info, keys, pinned).catch(() => pinned);
  await upgradeLegacyFolders(info, keys).catch(() => undefined);
  const shared = await distributePendingKeys(info, keys);
  await loadFolderKeys(info, keys).catch(() => undefined);
  return { shared, needsAnchor: false, anchorMismatch: trust.mismatch, untrustedKeys: untrustedFolderKeyCount(keys), trust };
}

/**
 * Tenants aus der Zeit vor der Beglaubigung: Signaturschlüssel erzeugen und einmalig alle bisherigen aktiven Mitglieder
 * beglaubigen (deren Schlüssel waren bereits vertraut). System-Admins müssen ausdrücklich beglaubigt werden.
 */
async function initLegacySigning(info: SessionInfo, keys: VaultKeys) {
  const tenantId = info.tenant!.id;
  const data = await get<{ recoveryPublicKey: string; protectedRecoveryPrivateKey: string; wrappedKey: string | null }>('/keys/tenant-recovery');
  if (!data.wrappedKey) return;
  const signing = await createLegacyTenantSigning(tenantId, keys, { ...data, wrappedKey: data.wrappedKey });
  const users = await get<UserRow[]>('/users');
  const members = users.filter((u) => u.status === 'ACTIVE' && u.publicKey && (u.systemRole !== 'SYSTEM_ADMIN' || u.id === info.user.id));
  const endorsements = await Promise.all(
    members.map(async (u) => ({ userId: u.id, signature: await signEndorsement(signing.signingKey, tenantId, u.id, u.id === info.user.id ? keys.publicKey : u.publicKey!) })),
  );
  await post('/keys/tenant-signing', {
    signingPublicKey: signing.signingPublicKey,
    protectedSigningPrivateKey: signing.protectedSigningPrivateKey,
    endorsements,
    trustAnchor: await sealAnchor(keys.accountKeyRaw, tenantId, { signingPublicKey: signing.signingPublicKey, recoveryPublicKey: data.recoveryPublicKey }),
  });
}

/**
 * Alle Einträge einschließlich Papierkorb. Neuverschlüsselungen (Geheim-Schlüssel, Schlüsselerneuerung) müssen auch
 * gelöschte Einträge erfassen, sonst wären sie nach dem Wiederherstellen nicht mehr lesbar; der Server verlangt sie.
 */
async function allItemsWithTrash() {
  const [items, trash] = await Promise.all([get<EncryptedItem[]>('/items'), get<EncryptedTrashItem[]>('/items/trash')]);
  return [...items, ...trash];
}

/** Bestehende Ordner, die der Benutzer verwaltet, auf einen eigenen Geheim-Schlüssel umstellen. */
async function upgradeLegacyFolders(info: SessionInfo, keys: VaultKeys) {
  const [cache, structure] = await Promise.all([loadFolderKeys(info, keys), get<StructureInfo>('/structure')]);
  const manageable = structure.departments.flatMap((d) => d.folders).filter((f) => f.permissions.includes('vault.manage') && cache.get(f.id) && !cache.get(f.id)!.secretKeyed);
  if (!manageable.length) return;
  const items = await allItemsWithTrash();
  for (const f of manageable) {
    const entry = cache.get(f.id)!;
    const secretRaw = randomBytes(32);
    const secretKey = await importAesKey(secretRaw);
    try {
      const reencrypted = await Promise.all(
        items
          .filter((i) => i.folderId === f.id)
          .map(async (i) => {
            if (!i.secret) throw new Error('SECRET_UNAVAILABLE');
            const plain = await decryptJson(entry.key, i.secret, AAD.item(i.id, 'secret'));
            return { id: i.id, revision: i.revision, secret: await encryptJson(secretKey, plain, AAD.item(i.id, 'secret')) };
          }),
      );
      // Eigenes Paket: unveränderter Ordnerschlüssel, neuer Geheim-Schlüssel, eigener Herkunftsnachweis
      const wrappedSecretKey = await rsaWrap(keys.publicKey, secretRaw);
      const me = info.user.id;
      const signature = await signFolderKey(keys.signKey, { tenantId: info.tenant!.id, folderId: f.id, recipientId: me, signerId: me }, entry.wrappedKey, wrappedSecretKey);
      await post(`/folders/${f.id}/secret-key`, { wrappedSecretKey, signature, items: reencrypted });
      cache.delete(f.id);
    } catch {
      // Konflikt oder nicht lesbarer Eintrag: beim nächsten Entsperren erneut versuchen
    } finally {
      secretRaw.fill(0);
    }
  }
}

interface PendingRecipient {
  userId: string;
  publicKey: string | null;
  endorsement: string;
  needsKey: boolean;
  needsSecret: boolean;
}

export async function distributePendingKeys(info: SessionInfo, keys: VaultKeys): Promise<number> {
  if (!info.tenant) return 0;
  const trust = await loadTrust(info, keys);
  // Ohne festgehaltenen Anker lassen sich Empfänger nicht prüfen: dann nichts verteilen
  if (!trust?.anchor) return 0;
  const anchor = trust.anchor;
  const pending = await get<{
    folders: { folderId: string; recipients: PendingRecipient[] }[];
    recovery: { userId: string; publicKey: string | null; endorsement: string }[];
  }>('/keys/pending');
  let shared = 0;
  if (pending.folders.length) {
    const cache = await loadFolderKeys(info, keys);
    const grants: { folderId: string; userId: string; wrappedKey: string; wrappedSecretKey?: string; signature: string }[] = [];
    for (const f of pending.folders) {
      const entry = cache.get(f.folderId);
      if (!entry) continue;
      for (const r of f.recipients) {
        const pub = await trustedKey(info, keys, anchor, r);
        if (!pub) continue;
        const withSecret = r.needsSecret && !!entry.secretRaw;
        if (!r.needsKey && !withSecret) continue;
        // Immer das ganze Paket: Wer nur noch den Geheim-Schlüssel braucht, erhält beide neu verpackt (ein Nachweis deckt beide ab)
        grants.push({ folderId: f.folderId, userId: r.userId, ...(await wrapSigned(info, keys, f.folderId, r.userId, pub, entry.raw, withSecret ? entry.secretRaw! : null)) });
      }
    }
    if (grants.length) shared += (await post<{ created: number }>('/keys/folders', { grants })).created;
  }
  if (pending.recovery.length) {
    const data = await get<{ wrappedKey: string | null }>('/keys/tenant-recovery');
    if (data.wrappedKey) {
      const wrapKey = await rsaUnwrap(keys.privateKey, data.wrappedKey);
      const grants: { userId: string; wrappedKey: string }[] = [];
      for (const r of pending.recovery) {
        const pub = await trustedKey(info, keys, anchor, r);
        if (pub) grants.push({ userId: r.userId, wrappedKey: await rsaWrap(pub, wrapKey) });
      }
      wrapKey.fill(0);
      if (grants.length) shared += (await post<{ created: number }>('/keys/recovery', { grants })).created;
    }
  }
  // Neue Ordner sofort auch für das Notfall-Backup verpacken (nicht erst beim nächsten Entsperren)
  await runEmergencyMaintenance(info, keys, trust).catch(() => undefined);
  return shared;
}

/** Schlüssel für einen neuen Ordner erzeugen und für alle beglaubigten Empfänger verschlüsseln. */
export async function createFolderKeys(
  info: SessionInfo,
  keys: VaultKeys,
  /** Kennung des neuen Ordners (vom Client vergeben): Die Herkunftsnachweise sind an sie gebunden */
  folderId: string,
  recipients: { userId: string; publicKey: string | null; reveal: boolean; endorsement: string | null }[],
) {
  const trust = await loadTrust(info, keys);
  if (!trust?.anchor) throw new Error('ANCHOR_REQUIRED');
  const raw = randomBytes(32);
  const secretRaw = randomBytes(32);
  const wrapped: { userId: string; wrappedKey: string; wrappedSecretKey?: string; signature: string }[] = [];
  for (const r of recipients) {
    const pub = await trustedKey(info, keys, trust.anchor, r);
    if (!pub) continue;
    wrapped.push({ userId: r.userId, ...(await wrapSigned(info, keys, folderId, r.userId, pub, raw, r.reveal ? secretRaw : null)) });
  }
  const itemKeys: ItemKeys = { overview: await importAesKey(raw), secret: await importAesKey(secretRaw) };
  raw.fill(0);
  secretRaw.fill(0);
  return { wrapped, itemKeys };
}

/**
 * Die Erneuerung wurde abgebrochen, weil sich Einträge nicht entschlüsseln lassen. Sie würden sonst unverändert übernommen
 * und wären danach endgültig unlesbar (der alte Schlüssel wird verworfen). Fortsetzen nur nach ausdrücklicher Bestätigung.
 */
export type { UnreadableItem };

export class UnreadableItemsError extends Error {
  constructor(readonly items: UnreadableItem[]) {
    super('UNREADABLE_ITEMS');
  }
}

/**
 * Ordnerschlüssel erneuern (Rotation), z. B. nachdem jemandem der Zugriff entzogen wurde: neue Ordner- und Geheim-Schlüssel,
 * alle Einträge neu verschlüsselt, Schlüssel nur an aktuell berechtigte und beglaubigte Empfänger. Danach ist ein früher
 * abgegriffener Schlüssel für alle gespeicherten Chiffretexte wertlos.
 */
export async function rotateFolderKey(info: SessionInfo, keys: VaultKeys, folderId: string, opts: { keepUnreadable?: boolean } = {}) {
  const trust = await loadTrust(info, keys);
  if (!trust?.anchor) throw new Error('ANCHOR_REQUIRED');
  const cache = await loadFolderKeys(info, keys);
  const entry = cache.get(folderId);
  if (!entry) throw new Error('FOLDER_KEY_MISSING');
  if (entry.secretKeyed && !entry.secretKey) throw new Error('SECRET_KEY_MISSING');
  const [recipients, all] = await Promise.all([
    get<{ userId: string; publicKey: string | null; reveal: boolean; endorsement: string | null }[]>(`/folders/${folderId}/key-recipients`),
    allItemsWithTrash(),
  ]);
  const raw = randomBytes(32);
  const secretRaw = randomBytes(32);
  try {
    const next: ItemKeys = { overview: await importAesKey(raw), secret: await importAesKey(secretRaw) };
    const { items, unreadable } = await reencryptFolderItems(entry, next, all.filter((i) => i.folderId === folderId));
    if (unreadable.length > 0 && !opts.keepUnreadable) throw new UnreadableItemsError(unreadable);
    const wrapped: { userId: string; wrappedKey: string; wrappedSecretKey?: string; signature: string }[] = [];
    for (const r of recipients) {
      const pub = await trustedKey(info, keys, trust.anchor, r);
      if (!pub) continue;
      wrapped.push({ userId: r.userId, ...(await wrapSigned(info, keys, folderId, r.userId, pub, raw, r.reveal || r.userId === info.user.id ? secretRaw : null)) });
    }
    await post(`/folders/${folderId}/rotate-key`, { keys: wrapped, items, keptUnreadable: unreadable.length > 0 ? unreadable.map((u) => u.id) : undefined });
    cache.delete(folderId);
  } finally {
    raw.fill(0);
    secretRaw.fill(0);
  }
  // Neue Notfall-Schlüsselpakete erstellen (die alten wurden verworfen)
  await runEmergencyMaintenance(info, keys, trust).catch(() => undefined);
}

/** Signaturschlüssel des Tenants öffnen (nur Tenant-Admins mit Recovery-Zugang). */
export async function openSigningKey(info: SessionInfo, keys: VaultKeys) {
  if (!info.tenant?.signingInitialized || !info.permissions.isTenantAdmin) return null;
  const data = await get<{ protectedRecoveryPrivateKey: string; protectedSigningPrivateKey: string | null; wrappedKey: string | null }>('/keys/tenant-recovery');
  if (!data.wrappedKey || !data.protectedSigningPrivateKey) return null;
  return (await openTenantAdminKeys(info.tenant.id, keys, { ...data, wrappedKey: data.wrappedKey })).signingKey;
}

/** Öffentlichen Schlüssel eines Mitglieds beglaubigen (nach Fingerprint-Abgleich). */
export async function endorseUser(info: SessionInfo, keys: VaultKeys, user: { id: string; publicKey: string }) {
  const signingKey = await openSigningKey(info, keys);
  if (!signingKey) throw new Error('NO_SIGNING_ACCESS');
  await post(`/users/${user.id}/endorse`, { signature: await signEndorsement(signingKey, info.tenant!.id, user.id, user.publicKey) });
}

export function useStructure() {
  const { info } = useUnlocked();
  return useQuery({ queryKey: ['structure'], queryFn: () => get<StructureInfo>('/structure'), enabled: !!info.tenant });
}

/** Alle zugänglichen Einträge, im Browser entschlüsselt. */
export function useVaultItems() {
  const { info, keys } = useUnlocked();
  return useQuery({
    queryKey: ['items'],
    queryFn: async (): Promise<DecryptedItem[]> => {
      const [cache, items] = await Promise.all([loadFolderKeys(info, keys), get<EncryptedItem[]>('/items')]);
      const out = await Promise.all(
        items.map((i) => {
          if (i.personal) return decryptItem({ overview: keys.personalKey, secret: keys.personalKey }, i);
          const e = cache.get(i.folderId!);
          return decryptItem(e ? { overview: e.key, secret: e.secretKey ?? e.key } : undefined, i);
        }),
      );
      return out.sort((a, b) => (a.overview.name || '').localeCompare(b.overview.name || '', undefined, { sensitivity: 'base' }));
    },
  });
}

/** Papierkorb, im Browser entschlüsselt (neueste Löschung zuerst). */
export function useTrashItems() {
  const { info, keys } = useUnlocked();
  return useQuery({
    queryKey: ['trash'],
    queryFn: async (): Promise<DecryptedTrashItem[]> => {
      const [cache, items] = await Promise.all([loadFolderKeys(info, keys), get<EncryptedTrashItem[]>('/items/trash')]);
      const out = await Promise.all(
        items.map(async (i) => {
          let itemKeys: ItemKeys | undefined;
          if (i.personal) itemKeys = { overview: keys.personalKey, secret: keys.personalKey };
          else {
            const e = cache.get(i.folderId!);
            itemKeys = e ? { overview: e.key, secret: e.secretKey ?? e.key } : undefined;
          }
          return { ...(await decryptItem(itemKeys, i)), deletedAt: i.deletedAt, purgeAt: i.purgeAt };
        }),
      );
      return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    },
  });
}

export function useRefreshVault() {
  const qc = useQueryClient();
  const { info, keys } = useUnlocked();
  return useCallback(
    async (opts: { distribute?: boolean } = {}) => {
      if (opts.distribute) await distributePendingKeys(info, keys).catch(() => 0);
      await Promise.all([qc.invalidateQueries({ queryKey: ['structure'] }), qc.invalidateQueries({ queryKey: ['items'] })]);
    },
    [qc, info, keys],
  );
}
