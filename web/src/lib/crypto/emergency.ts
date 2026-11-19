/**
 * Notfall-Backup (Kryptografie, gemeinsam für Web-Client und Offline-Werkzeug):
 *
 *   Notfallschlüssel: RSA-OAEP-4096 (SHA-256), im Browser des System-Admins erzeugt
 *   Schutz des privaten Teils (zwei Faktoren, beide nötig):
 *     Schlüsselblatt: 256 Bit Zufall (+ 16-Bit-Prüfsumme), als Code in Base32 (Crockford) ausgedruckt
 *     Passphrase:     Argon2id (256 MiB, t=4, p=4)
 *     K = HKDF-SHA-256(Schlüsselblatt ‖ Argon2id(Passphrase), "bastion:emergency-key:v1")
 *     protectedPrivateKey = AES-256-GCM(K, PKCS8), AAD = Schlüssel-ID
 *   Freigabe je Tenant: ECDSA-Signatur des Tenant-Signaturschlüssels über (Tenant, Schlüssel-ID, SHA-256 des SPKI)
 *   Backup-Datei: AES-256-GCM(zufälliger Schlüssel, gzip(JSON)), der Schlüssel RSA-OAEP-verschlüsselt für den Notfallschlüssel
 */
import { argon2id } from 'hash-wasm';
import { b64, Bytes, fromUtf8, randomBytes, toHex, unb64, utf8, wipe } from './encoding';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, fingerprint, generateRsaKeyPair, hkdf, importAesKey, importPrivateKey, rsaUnwrap } from './primitives';

export const EMERGENCY_KDF = { kdfMemory: 262144, kdfIterations: 4, kdfParallelism: 4 };
export const PASSPHRASE_MIN_LENGTH = 20;

export interface EmergencyKeyProtection {
  protectedPrivateKey: string;
  kdfSalt: string;
  kdfMemory: number;
  kdfIterations: number;
  kdfParallelism: number;
}

const privateKeyAad = (keyId: string) => `bastion:emergency-private-key:v1:${keyId}`;
const anchorAad = 'bastion:emergency-anchor:v1';
export const backupAad = (keyId: string, createdAt: string) => `bastion:emergency-backup:v1:${keyId}:${createdAt}`;

// ---------- Schlüsselblatt-Code (Base32 Crockford mit Prüfsumme) ----------

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Bytes {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('SHEET_CODE_INVALID');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function sheetChecksum(secret: Bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', secret)).subarray(0, 2);
}

/** 32 Byte Geheimnis → 55 Zeichen in 11 Gruppen à 5, z. B. "7K2QX-…" */
export async function formatSheetCode(secret: Bytes) {
  const data = new Uint8Array(34);
  data.set(secret);
  data.set(await sheetChecksum(secret), 32);
  return base32(data).match(/.{1,5}/g)!.join('-');
}

/** Eingegebenen Code normalisieren (Leer-/Bindestriche, Kleinbuchstaben, O→0, I/L→1) und Prüfsumme kontrollieren. */
export async function parseSheetCode(input: string): Promise<Bytes> {
  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== 55) throw new Error('SHEET_CODE_LENGTH');
  const data = unbase32(clean);
  const secret = data.slice(0, 32) as Bytes;
  const sum = await sheetChecksum(secret);
  if (data[32] !== sum[0] || data[33] !== sum[1]) throw new Error('SHEET_CODE_CHECKSUM');
  return secret;
}

// ---------- Schutz des privaten Schlüssels ----------

async function protectionKey(sheet: Bytes, passphrase: string, p: Omit<EmergencyKeyProtection, 'protectedPrivateKey'>) {
  const stretched = new Uint8Array(
    await argon2id({
      password: passphrase.normalize('NFKC'),
      salt: unb64(p.kdfSalt),
      parallelism: p.kdfParallelism,
      iterations: p.kdfIterations,
      memorySize: p.kdfMemory,
      hashLength: 32,
      outputType: 'binary',
    }),
  );
  const ikm = new Uint8Array(64);
  ikm.set(sheet);
  ikm.set(stretched, 32);
  try {
    const raw = await hkdf(ikm, 'bastion:emergency-key:v1');
    const key = await importAesKey(raw);
    raw.fill(0);
    return key;
  } finally {
    wipe(ikm, stretched);
  }
}

/** Neuen Notfallschlüssel erzeugen und mit Schlüsselblatt + Passphrase schützen. */
export async function createEmergencyKey(passphrase: string) {
  const id = crypto.randomUUID();
  const rsa = await generateRsaKeyPair();
  const sheet = randomBytes(32);
  const kdf = { kdfSalt: b64(randomBytes(16)), ...EMERGENCY_KDF };
  try {
    const key = await protectionKey(sheet, passphrase, kdf);
    const protectedPrivateKey = await encryptBytes(key, rsa.pkcs8, privateKeyAad(id));
    return {
      id,
      publicKey: rsa.publicKey,
      fingerprint: await fingerprint(rsa.publicKey),
      sheetCode: await formatSheetCode(sheet),
      protection: { protectedPrivateKey, ...kdf } satisfies EmergencyKeyProtection,
    };
  } finally {
    wipe(rsa.pkcs8, sheet);
  }
}

export class EmergencyUnlockError extends Error {
  constructor() {
    super('EMERGENCY_UNLOCK_FAILED');
  }
}

/** Privaten Notfallschlüssel mit Schlüsselblatt-Code und Passphrase öffnen. */
export async function openEmergencyKey(keyId: string, protection: EmergencyKeyProtection, sheetCode: string, passphrase: string) {
  const sheet = await parseSheetCode(sheetCode);
  try {
    const key = await protectionKey(sheet, passphrase, protection);
    let pkcs8: Bytes;
    try {
      pkcs8 = await decryptBytes(key, protection.protectedPrivateKey, privateKeyAad(keyId));
    } catch {
      throw new EmergencyUnlockError();
    }
    const privateKey = await importPrivateKey(pkcs8);
    wipe(pkcs8);
    return privateKey;
  } finally {
    wipe(sheet);
  }
}

// ---------- Freigabe je Tenant ----------

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function approvalMessage(tenantId: string, keyId: string, publicKeyB64: string) {
  const hash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', unb64(publicKeyB64))));
  return utf8(`bastion:emergency-approve:v1|${tenantId}|${keyId}|${hash}`);
}

export async function signApproval(signingKey: CryptoKey, tenantId: string, keyId: string, publicKeyB64: string) {
  return b64(new Uint8Array(await crypto.subtle.sign(SIGN, signingKey, await approvalMessage(tenantId, keyId, publicKeyB64))));
}

export async function verifyApproval(signingPublicKeyB64: string, tenantId: string, keyId: string, publicKeyB64: string, signatureB64: string) {
  try {
    const key = await crypto.subtle.importKey('spki', unb64(signingPublicKeyB64), EC, false, ['verify']);
    return await crypto.subtle.verify(SIGN, key, unb64(signatureB64), await approvalMessage(tenantId, keyId, publicKeyB64));
  } catch {
    return false;
  }
}

// ---------- Bestätigung durch System-Admins ----------

/** Bestätigten Notfallschlüssel mit dem eigenen AccountKey versiegeln (der Server kann ihn weder lesen noch fälschen). */
export async function sealEmergencyAnchor(accountKeyRaw: Bytes, keyId: string, publicKey: string) {
  return encryptJson(await importAesKey(accountKeyRaw), { keyId, publicKey }, anchorAad);
}

export async function emergencyAnchorMatches(accountKeyRaw: Bytes, sealed: string, keyId: string, publicKey: string) {
  try {
    const a = await decryptJson<{ keyId: string; publicKey: string }>(await importAesKey(accountKeyRaw), sealed, anchorAad);
    return a.keyId === keyId && a.publicKey === publicKey;
  } catch {
    return false;
  }
}

// ---------- Backup-Datei ----------

export interface BackupFile {
  format: 'bastion-emergency-backup';
  version: 1;
  createdAt: string;
  keyId: string;
  fingerprint: string;
  stats: { tenants: number; folders: number; users: number; items: number };
  keyProtection: EmergencyKeyProtection & { publicKey: string };
  envelope: { wrappedKey: string; iv: string; ciphertext: string };
}

export interface BackupPayload {
  createdAt: string;
  bastionVersion: string;
  tenants: { id: string; name: string; slug: string }[];
  departments: { id: string; tenantId: string; name: string }[];
  folders: {
    id: string;
    tenantId: string;
    departmentId: string;
    parentId: string | null;
    name: string;
    secretKeyed: boolean;
    key: { wrappedKey: string; wrappedSecretKey: string | null } | null;
  }[];
  users: { id: string; email: string; name: string; tenantId: string | null; systemAdmin: boolean; wrappedKey: string }[];
  items: { id: string; type: string; folderId: string | null; ownerId: string | null; overview: string; secret: string; createdAt: string; updatedAt: string }[];
}

export function parseBackupFile(text: string): BackupFile {
  let data: BackupFile;
  try {
    data = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error('BACKUP_FILE_INVALID');
  }
  if (data?.format !== 'bastion-emergency-backup' || !data.envelope || !data.keyProtection) throw new Error('BACKUP_FILE_INVALID');
  if (data.version !== 1) throw new Error('BACKUP_VERSION_UNSUPPORTED');
  return data;
}

async function gunzip(data: Bytes): Promise<Bytes> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function openBackupPayload(file: BackupFile, privateKey: CryptoKey): Promise<BackupPayload> {
  const dek = await rsaUnwrap(privateKey, file.envelope.wrappedKey);
  try {
    const key = await importAesKey(dek);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(file.envelope.iv), additionalData: utf8(backupAad(file.keyId, file.createdAt)), tagLength: 128 },
      key,
      unb64(file.envelope.ciphertext),
    );
    return JSON.parse(fromUtf8(await gunzip(new Uint8Array(pt)))) as BackupPayload;
  } finally {
    wipe(dek);
  }
}

export interface RestoredItem {
  id: string;
  type: string;
  tenant: string | null;
  /** "Abteilung / Ordner / Unterordner" bzw. "Persönlich: Name <E-Mail>" */
  location: string;
  overview: Record<string, string>;
  secret: Record<string, string> | null;
  updatedAt: string;
}

/** Alle Einträge entschlüsseln. Nicht entschlüsselbare Einträge werden gezählt, nicht verworfen. */
export async function decryptBackupItems(payload: BackupPayload, privateKey: CryptoKey) {
  const tenants = new Map(payload.tenants.map((t) => [t.id, t.name]));
  const departments = new Map(payload.departments.map((d) => [d.id, d.name]));
  const folders = new Map(payload.folders.map((f) => [f.id, f]));
  const folderPath = (id: string) => {
    const parts: string[] = [];
    let f = folders.get(id);
    for (let guard = 0; f && guard < 64; guard++) {
      parts.unshift(f.name);
      f = f.parentId ? folders.get(f.parentId) : undefined;
    }
    const top = folders.get(id);
    return [top ? departments.get(top.departmentId) : '', ...parts].filter(Boolean).join(' / ');
  };

  const folderKeys = new Map<string, { overview: CryptoKey; secret: CryptoKey }>();
  for (const f of payload.folders) {
    if (!f.key) continue;
    try {
      const raw = await rsaUnwrap(privateKey, f.key.wrappedKey);
      const overview = await importAesKey(raw);
      raw.fill(0);
      let secret = overview;
      if (f.key.wrappedSecretKey) {
        const sraw = await rsaUnwrap(privateKey, f.key.wrappedSecretKey);
        secret = await importAesKey(sraw);
        sraw.fill(0);
      }
      folderKeys.set(f.id, { overview, secret });
    } catch {
      // Paket beschädigt: Einträge des Ordners bleiben unlesbar
    }
  }
  const users = new Map(payload.users.map((u) => [u.id, u]));
  const personalKeys = new Map<string, CryptoKey>();
  for (const u of payload.users) {
    try {
      const raw = await rsaUnwrap(privateKey, u.wrappedKey);
      personalKeys.set(u.id, await importAesKey(raw));
      raw.fill(0);
    } catch {
      // ignorieren
    }
  }

  const items: RestoredItem[] = [];
  let failed = 0;
  for (const i of payload.items) {
    let keys: { overview: CryptoKey; secret: CryptoKey } | undefined;
    let tenant: string | null = null;
    let location = '';
    if (i.folderId) {
      keys = folderKeys.get(i.folderId);
      const f = folders.get(i.folderId);
      tenant = f ? (tenants.get(f.tenantId) ?? null) : null;
      location = folderPath(i.folderId);
    } else if (i.ownerId) {
      const k = personalKeys.get(i.ownerId);
      keys = k ? { overview: k, secret: k } : undefined;
      const u = users.get(i.ownerId);
      tenant = u?.tenantId ? (tenants.get(u.tenantId) ?? null) : null;
      location = `Persönlich: ${u?.name ? `${u.name} <${u.email}>` : (u?.email ?? i.ownerId)}`;
    }
    if (!keys) {
      failed++;
      continue;
    }
    try {
      const overview = await decryptJson<Record<string, string>>(keys.overview, i.overview, `bastion:item:${i.id}:overview`);
      let secret: Record<string, string> | null = null;
      try {
        secret = await decryptJson<Record<string, string>>(keys.secret, i.secret, `bastion:item:${i.id}:secret`);
      } catch {
        secret = null;
      }
      items.push({ id: i.id, type: i.type, tenant, location, overview, secret, updatedAt: i.updatedAt });
    } catch {
      failed++;
    }
  }
  items.sort((a, b) => (a.tenant ?? '').localeCompare(b.tenant ?? '') || a.location.localeCompare(b.location) || (a.overview.name ?? '').localeCompare(b.overview.name ?? ''));
  return { items, failed };
}
