/**
 * Schlüsselhierarchie eines Kontos:
 *
 *   Masterpasswort ──Argon2id──▶ MasterKey ──HKDF──┬─▶ AuthHash (Login, an Server)
 *                                                  └─▶ EncKey  (bleibt im Browser)
 *   EncKey ──AES-GCM──▶ AccountKey   (zusätzlich RSA-verschlüsselt mit Tenant-Recovery-Key → Admin-Wiederherstellung)
 *   EncKey ──AES-GCM──▶ PersonalKey  (nur Masterpasswort → Admins haben keinen Zugriff auf den persönlichen Tresor)
 *   AccountKey ──AES-GCM──▶ RSA-Private-Key  → entschlüsselt Ordnerschlüssel
 */
import { Bytes, randomBytes, wipe } from './encoding';
import {
  decryptBytes,
  deriveLoginKeys,
  encryptBytes,
  generateRsaKeyPair,
  importAesKey,
  importPrivateKey,
  KdfParams,
  newKdfParams,
  rsaUnwrap,
  rsaWrap,
} from './primitives';
import { generateSigningKeyPair, importAccountSignKey, importSigningPrivateKey, recoveryProof, recoveryVerifier, sealAnchor, signEndorsement, TenantAnchor } from './trust';

export const AAD = {
  accountKey: 'bastion:account-key',
  personalKey: 'bastion:personal-key',
  privateKey: 'bastion:private-key',
  recoveryPrivateKey: (tenantId: string) => `bastion:recovery-private-key:${tenantId}`,
  signingPrivateKey: (tenantId: string) => `bastion:signing-private-key:${tenantId}`,
  item: (id: string, part: 'overview' | 'secret') => `bastion:item:${id}:${part}`,
  export: 'bastion:export:v1',
};

export interface VaultKeys {
  accountKeyRaw: Bytes;
  personalKeyRaw: Bytes;
  personalKey: CryptoKey;
  privateKey: CryptoKey;
  /** Derselbe RSA-Schlüssel zum Signieren (RSA-PSS): Herkunftsnachweis für weitergegebene Ordnerschlüssel */
  signKey: CryptoKey;
  publicKey: string;
}

export interface ProtectedKeys extends KdfParams {
  protectedAccountKey: string;
  protectedPersonalKey: string;
  protectedPrivateKey: string;
  publicKey: string;
}

/**
 * Neues Konto: erzeugt alle Schlüssel lokal und liefert das verschlüsselte Bundle für den Server.
 * `tenant`: Tenant-Schlüssel aus der Einladung; sie werden als Vertrauensanker festgehalten.
 */
export async function createAccount(password: string, tenant?: { id: string; recoveryPublicKey: string | null; signingPublicKey: string | null } | null) {
  const recoveryPublicKey = tenant?.recoveryPublicKey ?? null;
  const kdf = newKdfParams();
  const { authHash, encKey } = await deriveLoginKeys(password, kdf);
  const accountKeyRaw = randomBytes(32);
  const personalKeyRaw = randomBytes(32);
  const rsa = await generateRsaKeyPair();
  const accountKey = await importAesKey(accountKeyRaw);
  const bundle = {
    ...kdf,
    authHash,
    protectedAccountKey: await encryptBytes(encKey, accountKeyRaw, AAD.accountKey),
    protectedPersonalKey: await encryptBytes(encKey, personalKeyRaw, AAD.personalKey),
    publicKey: rsa.publicKey,
    protectedPrivateKey: await encryptBytes(accountKey, rsa.pkcs8, AAD.privateKey),
    recoveryAccountKey: recoveryPublicKey ? await rsaWrap(recoveryPublicKey, accountKeyRaw) : null,
    recoveryVerifier: await recoveryVerifier(accountKeyRaw),
    trustAnchor:
      tenant?.signingPublicKey && recoveryPublicKey
        ? // Neues Konto ohne Ordnerschlüssel: von Anfang an nur Schlüssel mit Herkunftsnachweis
          await sealAnchor(accountKeyRaw, tenant.id, { signingPublicKey: tenant.signingPublicKey, recoveryPublicKey, folderKeyAuth: 1 } satisfies TenantAnchor)
        : null,
  };
  const signKey = await importAccountSignKey(rsa.pkcs8);
  wipe(rsa.pkcs8);
  const keys: VaultKeys = {
    accountKeyRaw,
    personalKeyRaw,
    personalKey: await importAesKey(personalKeyRaw),
    privateKey: rsa.privateKey,
    signKey,
    publicKey: rsa.publicKey,
  };
  return { bundle, keys };
}

export class WrongPasswordError extends Error {
  constructor() {
    super('WRONG_PASSWORD');
  }
}

/** Entsperren mit bereits abgeleitetem EncKey (z. B. direkt nach dem Login). */
export async function unlockWithEncKey(encKey: CryptoKey, p: ProtectedKeys): Promise<VaultKeys> {
  let accountKeyRaw: Bytes;
  try {
    accountKeyRaw = await decryptBytes(encKey, p.protectedAccountKey, AAD.accountKey);
  } catch {
    throw new WrongPasswordError();
  }
  const personalKeyRaw = await decryptBytes(encKey, p.protectedPersonalKey, AAD.personalKey);
  const pkcs8 = await decryptBytes(await importAesKey(accountKeyRaw), p.protectedPrivateKey, AAD.privateKey);
  const privateKey = await importPrivateKey(pkcs8);
  const signKey = await importAccountSignKey(pkcs8);
  wipe(pkcs8);
  await assertKeyPair(p.publicKey, privateKey);
  return { accountKeyRaw, personalKeyRaw, personalKey: await importAesKey(personalKeyRaw), privateKey, signKey, publicKey: p.publicKey };
}

/**
 * Der eigene öffentliche Schlüssel kommt vom Server. Er muss zum privaten Schlüssel passen, der nur mit dem
 * Masterpasswort entschlüsselbar ist, sonst könnte ein manipulierter Server einen fremden Schlüssel unterschieben.
 */
async function assertKeyPair(publicKey: string, privateKey: CryptoKey) {
  const probe = randomBytes(32);
  const back = await rsaUnwrap(privateKey, await rsaWrap(publicKey, probe)).catch(() => null);
  if (!back || back.length !== probe.length || back.some((b, i) => b !== probe[i])) throw new Error('PUBLIC_KEY_MISMATCH');
}

export async function unlock(password: string, p: ProtectedKeys): Promise<VaultKeys> {
  const { encKey } = await deriveLoginKeys(password, p);
  return unlockWithEncKey(encKey, p);
}

/** Neue Verschlüsselung von AccountKey und PersonalKey für ein neues Masterpasswort. */
export async function rewrapForPassword(password: string, accountKeyRaw: Bytes, personalKeyRaw: Bytes) {
  const kdf = newKdfParams();
  const { authHash, encKey } = await deriveLoginKeys(password, kdf);
  return {
    ...kdf,
    authHash,
    protectedAccountKey: await encryptBytes(encKey, accountKeyRaw, AAD.accountKey),
    protectedPersonalKey: await encryptBytes(encKey, personalKeyRaw, AAD.personalKey),
  };
}

// ---------- Tenant-Recovery ----------

/** Signaturschlüssel des Tenants erzeugen und mit dem AdminWrapKey schützen. */
async function createTenantSigning(tenantId: string, adminWrapKeyRaw: Bytes) {
  const ec = await generateSigningKeyPair();
  const protectedSigningPrivateKey = await encryptBytes(await importAesKey(adminWrapKeyRaw), ec.pkcs8, AAD.signingPrivateKey(tenantId));
  wipe(ec.pkcs8);
  return { signingPublicKey: ec.publicKey, protectedSigningPrivateKey, signingKey: ec.privateKey };
}

/**
 * Erstinitialisierung des Tenants durch den ersten Tenant-Admin: Recovery- und Signaturschlüssel,
 * Beglaubigung des eigenen Schlüssels und eigener Vertrauensanker.
 */
export async function createTenantRecovery(tenantId: string, userId: string, keys: VaultKeys) {
  const rsa = await generateRsaKeyPair();
  const adminWrapKeyRaw = randomBytes(32);
  const signing = await createTenantSigning(tenantId, adminWrapKeyRaw);
  const result = {
    recoveryPublicKey: rsa.publicKey,
    protectedRecoveryPrivateKey: await encryptBytes(await importAesKey(adminWrapKeyRaw), rsa.pkcs8, AAD.recoveryPrivateKey(tenantId)),
    wrappedKey: await rsaWrap(keys.publicKey, adminWrapKeyRaw),
    recoveryAccountKey: await rsaWrap(rsa.publicKey, keys.accountKeyRaw),
    signingPublicKey: signing.signingPublicKey,
    protectedSigningPrivateKey: signing.protectedSigningPrivateKey,
    endorsement: await signEndorsement(signing.signingKey, tenantId, userId, keys.publicKey),
    trustAnchor: await sealAnchor(keys.accountKeyRaw, tenantId, { signingPublicKey: signing.signingPublicKey, recoveryPublicKey: rsa.publicKey }),
  };
  wipe(rsa.pkcs8, adminWrapKeyRaw);
  return result;
}

export interface TenantAdminData {
  protectedRecoveryPrivateKey: string;
  protectedSigningPrivateKey?: string | null;
  wrappedKey: string;
}

/** Recovery- und (falls vorhanden) Signaturschlüssel des Tenants mit dem eigenen AdminWrapKey öffnen. */
export async function openTenantAdminKeys(tenantId: string, keys: VaultKeys, data: TenantAdminData) {
  const wrapKey = await rsaUnwrap(keys.privateKey, data.wrappedKey);
  try {
    const aes = await importAesKey(wrapKey);
    const pkcs8 = await decryptBytes(aes, data.protectedRecoveryPrivateKey, AAD.recoveryPrivateKey(tenantId));
    const recoveryKey = await importPrivateKey(pkcs8);
    wipe(pkcs8);
    let signingKey: CryptoKey | null = null;
    if (data.protectedSigningPrivateKey) {
      const ecPkcs8 = await decryptBytes(aes, data.protectedSigningPrivateKey, AAD.signingPrivateKey(tenantId));
      signingKey = await importSigningPrivateKey(ecPkcs8);
      wipe(ecPkcs8);
    }
    return { recoveryKey, signingKey, aes };
  } finally {
    wipe(wrapKey);
  }
}

/** Nachrüsten des Signaturschlüssels (Tenants aus der Zeit vor der Beglaubigung). */
export async function createLegacyTenantSigning(tenantId: string, keys: VaultKeys, data: TenantAdminData) {
  const wrapKey = await rsaUnwrap(keys.privateKey, data.wrappedKey);
  try {
    return await createTenantSigning(tenantId, wrapKey);
  } finally {
    wipe(wrapKey);
  }
}

/**
 * Pflicht-Passwortwechsel nach einer Admin-Wiederherstellung: Der PersonalKey stammt aus dem Browser des Admins
 * (siehe recoverUser) und wird daher durch einen neuen ersetzt. Der persönliche Tresor ist zu diesem Zeitpunkt leer.
 */
export async function rewrapAfterRecovery(password: string, accountKeyRaw: Bytes) {
  const personalKeyRaw = randomBytes(32);
  return { payload: await rewrapForPassword(password, accountKeyRaw, personalKeyRaw), personalKeyRaw };
}

/** Admin-Wiederherstellung: AccountKey des Benutzers entschlüsseln und mit temporärem Passwort neu verpacken. */
export async function recoverUser(recoveryPrivateKey: CryptoKey, recoveryAccountKey: string, tempPassword: string) {
  const accountKeyRaw = await rsaUnwrap(recoveryPrivateKey, recoveryAccountKey);
  // Persönlicher Tresor ist nicht wiederherstellbar. Dieser Schlüssel ist nur vorläufig: Der Benutzer ersetzt ihn
  // beim Pflicht-Passwortwechsel (rewrapAfterRecovery), damit der Admin ihn nicht kennt.
  const newPersonalKey = randomBytes(32);
  const result = { ...(await rewrapForPassword(tempPassword, accountKeyRaw, newPersonalKey)), recoveryProof: await recoveryProof(accountKeyRaw) };
  wipe(accountKeyRaw, newPersonalKey);
  return result;
}

