import { get, post } from '../lib/api';
import type { VaultKeys } from '../lib/crypto/account';
import { emergencyAnchorMatches, signApproval, verifyApproval } from '../lib/crypto/emergency';
import { rsaWrap } from '../lib/crypto/primitives';
import type { SessionInfo } from '../lib/types';
import { loadFolderKeys, openSigningKey, TrustState } from './vault';

interface EmergencyTasks {
  key: { id: string; publicKey: string } | null;
  approval: { tenantId: string; signature: string } | null;
  anchor: string | null;
  folders: { folderId: string; secretKeyed: boolean }[];
  personal: boolean;
}

/**
 * Notfall-Backup: Ordnerschlüssel und den eigenen persönlichen Schlüssel zusätzlich für den Notfallschlüssel verpacken.
 * Verpackt wird nur, wenn der vom Server gemeldete Notfallschlüssel kryptografisch bestätigt ist:
 *  - Ordner (und persönlicher Tresor regulärer Benutzer): Freigabe-Signatur des Tenants, geprüft gegen den eigenen Vertrauensanker
 *  - persönlicher Tresor von System-Admins: eigene, mit dem AccountKey versiegelte Bestätigung
 * Ein Server, der einen fremden Schlüssel unterschiebt, erhält dadurch nichts.
 */
export async function runEmergencyMaintenance(info: SessionInfo, keys: VaultKeys, trust: TrustState | null) {
  if (info.user.status !== 'ACTIVE') return { folders: 0, personal: false };
  const tasks = await get<EmergencyTasks>('/emergency/tasks');
  if (!tasks.key || (!tasks.folders.length && !tasks.personal)) return { folders: 0, personal: false };
  const { id: keyId, publicKey } = tasks.key;

  const viaTenant =
    !!tasks.approval &&
    !!trust?.anchor &&
    !trust.mismatch &&
    tasks.approval.tenantId === info.tenant?.id &&
    (await verifyApproval(trust.anchor.signingPublicKey, tasks.approval.tenantId, keyId, publicKey, tasks.approval.signature));
  const viaAnchor = !!tasks.anchor && (await emergencyAnchorMatches(keys.accountKeyRaw, tasks.anchor, keyId, publicKey));

  const folders: { folderId: string; wrappedKey: string; wrappedSecretKey?: string }[] = [];
  if (viaTenant && tasks.folders.length) {
    const cache = await loadFolderKeys(info, keys);
    for (const f of tasks.folders) {
      const entry = cache.get(f.folderId);
      if (!entry || (f.secretKeyed && !entry.secretRaw)) continue;
      folders.push({
        folderId: f.folderId,
        wrappedKey: await rsaWrap(publicKey, entry.raw),
        ...(f.secretKeyed && entry.secretRaw ? { wrappedSecretKey: await rsaWrap(publicKey, entry.secretRaw) } : {}),
      });
    }
  }
  const isSystemAdmin = info.user.systemRole === 'SYSTEM_ADMIN';
  const personalAllowed = tasks.personal && (isSystemAdmin ? viaAnchor : viaTenant);
  const personal = personalAllowed ? await rsaWrap(publicKey, keys.personalKeyRaw) : undefined;
  if (!folders.length && !personal) return { folders: 0, personal: false };
  return post<{ folders: number; personal: boolean }>('/emergency/wraps', { keyId, folders, personal });
}

/** Notfallschlüssel für den eigenen Tenant freigeben (Tenant-Admin mit Signaturschlüssel, nach Fingerprint-Abgleich). */
export async function approveEmergencyKey(info: SessionInfo, keys: VaultKeys, key: { id: string; publicKey: string }) {
  const signingKey = await openSigningKey(info, keys);
  if (!signingKey) throw new Error('NO_SIGNING_ACCESS');
  await post('/emergency/tenant/approve', { keyId: key.id, signature: await signApproval(signingKey, info.tenant!.id, key.id, key.publicKey) });
}
