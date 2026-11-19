/**
 * Vertrauenskette für öffentliche Schlüssel:
 *
 *   Tenant-Signaturschlüssel (ECDSA P-256) ──signiert──▶ (Tenant, Benutzer, SHA-256 des öffentlichen RSA-Schlüssels)
 *
 * Ein Tenant-Admin signiert („beglaubigt“) den Schlüssel eines Mitglieds erst nach dem Fingerprint-Abgleich.
 * Jeder Client hält die öffentlichen Tenant-Schlüssel als Vertrauensanker, verschlüsselt mit dem eigenen AccountKey
 * (AES-GCM: der Server kann ihn weder lesen noch fälschen) und verschlüsselt Schlüssel nur für beglaubigte Empfänger.
 * Gleiches Nachrichtenformat wie server/src/common/endorsement.ts.
 */
import { b64, Bytes, toHex, unb64, utf8 } from './encoding';
import { decryptJson, encryptJson, hkdf, importAesKey } from './primitives';

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface TenantAnchor {
  signingPublicKey: string;
  recoveryPublicKey: string;
  /**
   * 1 = Ordnerschlüssel werden nur noch mit gültigem Herkunftsnachweis verwendet. Fehlt der Vermerk, stammt der Anker aus
   * der Zeit davor: Der Browser bestätigt die bereits gehaltenen Schlüssel einmalig selbst und setzt ihn dann.
   */
  folderKeyAuth?: number;
}

const anchorAad = (tenantId: string) => `bastion:trust-anchor:v1:${tenantId}`;

async function sha256Hex(data: Bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

export async function generateSigningKeyPair() {
  const pair = await crypto.subtle.generateKey(EC, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const privateKey = await importSigningPrivateKey(pkcs8);
  return { publicKey: b64(spki), pkcs8, privateKey };
}

export function importSigningPrivateKey(pkcs8: Bytes) {
  return crypto.subtle.importKey('pkcs8', pkcs8, EC, false, ['sign']);
}

const verifyKeyCache = new Map<string, Promise<CryptoKey>>();
function importVerifyKey(spkiB64: string) {
  let p = verifyKeyCache.get(spkiB64);
  if (!p) verifyKeyCache.set(spkiB64, (p = crypto.subtle.importKey('spki', unb64(spkiB64), EC, false, ['verify'])));
  return p;
}

async function endorsementMessage(tenantId: string, userId: string, publicKeyB64: string) {
  return utf8(`bastion:endorse:v1|${tenantId}|${userId}|${await sha256Hex(unb64(publicKeyB64))}`);
}

export async function signEndorsement(signingKey: CryptoKey, tenantId: string, userId: string, publicKeyB64: string) {
  return b64(new Uint8Array(await crypto.subtle.sign(SIGN, signingKey, await endorsementMessage(tenantId, userId, publicKeyB64))));
}

export async function verifyEndorsement(signingPublicKeyB64: string, tenantId: string, userId: string, publicKeyB64: string, signatureB64: string | null | undefined) {
  if (!signatureB64) return false;
  try {
    return await crypto.subtle.verify(SIGN, await importVerifyKey(signingPublicKeyB64), unb64(signatureB64), await endorsementMessage(tenantId, userId, publicKeyB64));
  } catch {
    return false;
  }
}

/** Vertrauensanker mit dem AccountKey versiegeln (Server kann ihn weder lesen noch austauschen). */
export async function sealAnchor(accountKeyRaw: Bytes, tenantId: string, anchor: TenantAnchor) {
  return encryptJson(
    await importAesKey(accountKeyRaw),
    { signingPublicKey: anchor.signingPublicKey, recoveryPublicKey: anchor.recoveryPublicKey, ...(anchor.folderKeyAuth ? { folderKeyAuth: 1 } : {}) },
    anchorAad(tenantId),
  );
}

export async function openAnchor(accountKeyRaw: Bytes, tenantId: string, sealed: string): Promise<TenantAnchor> {
  return decryptJson<TenantAnchor>(await importAesKey(accountKeyRaw), sealed, anchorAad(tenantId));
}

/** Fingerprint der Tenant-Schlüssel (für den Abgleich zwischen Admin und Mitglied). */
export async function tenantFingerprint(anchor: TenantAnchor) {
  const hex = await sha256Hex(utf8(`${anchor.signingPublicKey}|${anchor.recoveryPublicKey}`));
  return hex.slice(0, 32).toUpperCase().match(/.{4}/g)!.join('-');
}

/**
 * Organisationscode: die ersten 64 Bit des Fingerprints der Organisationsschlüssel (für alle Einladungen eines Tenants gleich).
 * Die Administration gibt ihn neuen Mitgliedern auf einem anderen Weg weiter (Telefon, persönlich, Intranet). Bevor der Browser
 * den vom Server gelieferten Schlüsseln erstmals vertraut, muss er dazu passen: Ein manipulierter Server bzw. eine manipulierte
 * Datenbank kann keine eigenen Schlüssel mit demselben Code erzeugen (64 Bit, zweites Urbild).
 */
export async function organizationCode(anchor: TenantAnchor) {
  return (await tenantFingerprint(anchor)).split('-').slice(0, 4).join('-');
}

/** Organisationscode aus einem bereits berechneten Fingerprint (Anzeige). */
export const organizationCodeOf = (tenantFp: string) => tenantFp.split('-').slice(0, 4).join('-');

const normalizeCode = (s: string) => s.toUpperCase().replace(/[^0-9A-F]/g, '');

export async function organizationCodeMatches(anchor: TenantAnchor, input: string) {
  const expected = normalizeCode(await organizationCode(anchor));
  return expected.length === 16 && normalizeCode(input) === expected;
}

// ---------- Herkunftsnachweis für Ordnerschlüssel ----------
//
// Ordnerschlüssel werden mit dem öffentlichen RSA-Schlüssel des Empfängers verpackt. Den kennt jeder, auch ein Angreifer
// mit Schreibzugriff auf die Datenbank: Ohne weiteren Schutz könnte er einen eigenen Schlüssel unterschieben und alles
// mitlesen, was das Opfer danach in diesem Ordner speichert. Deshalb signiert der Absender jedes Paket mit seinem
// Kontoschlüssel (RSA-PSS). Der Empfänger verwendet einen Schlüssel nur, wenn die Signatur stimmt und der Schlüssel des
// Absenders vom Tenant beglaubigt ist (Prüfung gegen den eigenen Vertrauensanker) – oder wenn er das Paket selbst signiert hat.
// Gleiches Nachrichtenformat wie FolderKeyProof im Server.

const PSS = { name: 'RSA-PSS', hash: 'SHA-256' } as const;
const PSS_SIGN = { name: 'RSA-PSS', saltLength: 32 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Signierschlüssel des Kontos: derselbe RSA-Schlüssel wie für den Schlüsselaustausch, nur zum Signieren importiert. */
export function importAccountSignKey(pkcs8: Bytes) {
  return crypto.subtle.importKey('pkcs8', pkcs8, PSS, false, ['sign']);
}

const proofKeyCache = new Map<string, Promise<CryptoKey>>();
function importProofKey(spkiB64: string) {
  let p = proofKeyCache.get(spkiB64);
  if (!p) proofKeyCache.set(spkiB64, (p = crypto.subtle.importKey('spki', unb64(spkiB64), PSS, false, ['verify'])));
  return p;
}

export interface FolderKeyBinding {
  tenantId: string;
  folderId: string;
  recipientId: string;
  signerId: string;
}

/** SHA-256 (hex) eines verpackten Schlüssels. */
export const wrappedKeyHash = (wrappedB64: string) => sha256Hex(unb64(wrappedB64));

function folderKeyMessage(b: FolderKeyBinding, keyHash: string, secretHash: string | null) {
  // Nur wohlgeformte Werte: Die Felder sind durch "|" getrennt und dürfen sich nicht gegeneinander verschieben lassen
  if (![b.tenantId, b.folderId, b.recipientId, b.signerId].every((v) => UUID.test(v))) throw new Error('INVALID_BINDING');
  if (!SHA256_HEX.test(keyHash) || (secretHash !== null && !SHA256_HEX.test(secretHash))) throw new Error('INVALID_BINDING');
  return utf8(`bastion:folder-key:v1|${b.tenantId}|${b.folderId}|${b.recipientId}|${b.signerId}|${keyHash}|${secretHash ?? '-'}`);
}

/** Herkunftsnachweis für ein Schlüsselpaket (Ordnerschlüssel und ggf. Geheim-Schlüssel) erstellen. */
export async function signFolderKey(signKey: CryptoKey, b: FolderKeyBinding, wrappedKey: string, wrappedSecretKey: string | null | undefined) {
  const message = folderKeyMessage(b, await wrappedKeyHash(wrappedKey), wrappedSecretKey ? await wrappedKeyHash(wrappedSecretKey) : null);
  return b64(new Uint8Array(await crypto.subtle.sign(PSS_SIGN, signKey, message)));
}

/**
 * Herkunftsnachweis prüfen. `secretHash`: SHA-256 des verpackten Geheim-Schlüssels bzw. – wurde er nachträglich
 * entfernt – der vom Server aufbewahrte Wert; null, wenn keiner signiert wurde.
 */
export async function verifyFolderKey(signerPublicKeyB64: string, b: FolderKeyBinding, keyHash: string, secretHash: string | null, signatureB64: string | null | undefined) {
  if (!signatureB64) return false;
  try {
    return await crypto.subtle.verify(PSS_SIGN, await importProofKey(signerPublicKeyB64), unb64(signatureB64), folderKeyMessage(b, keyHash, secretHash));
  } catch {
    return false;
  }
}

/** Schlüsselpaket, wie es der Server ausliefert (GET /keys/folders). */
export interface FolderKeyPackage {
  tenantId: string;
  folderId: string;
  wrappedKey: string;
  wrappedSecretKey: string | null;
  /** Herkunftsnachweis des Absenders; fehlt bei Schlüsseln aus der Zeit davor */
  signature: string | null;
  signer: { userId: string; publicKey: string | null; endorsement: string | null } | null;
  /** SHA-256 eines signierten, später entfernten Geheim-Schlüssels (Recht „Passwörter anzeigen“ entzogen) */
  strippedSecretHash: string | null;
}

/**
 * Darf der Empfänger dieses Schlüsselpaket verwenden? Ja, wenn die Signatur des Absenders über Tenant, Ordner, Empfänger
 * und beide Pakete stimmt und der Schlüssel des Absenders vom Tenant beglaubigt ist (Prüfung gegen den eigenen
 * Vertrauensanker) – oder wenn der Empfänger das Paket selbst signiert hat (selbst angelegter Ordner, eigene Erneuerung,
 * einmalige Übernahme alter Schlüssel). Alles, was der Server liefert, gilt dabei als nicht vertrauenswürdig.
 */
export async function folderKeyTrusted(self: { userId: string; publicKey: string }, anchor: TenantAnchor | null, w: FolderKeyPackage) {
  if (!w.signature || !w.signer) return false;
  let signerKey = self.publicKey;
  if (w.signer.userId !== self.userId) {
    if (!anchor || !w.signer.publicKey) return false;
    if (!(await verifyEndorsement(anchor.signingPublicKey, w.tenantId, w.signer.userId, w.signer.publicKey, w.signer.endorsement))) return false;
    signerKey = w.signer.publicKey;
  }
  try {
    const secretHash = w.wrappedSecretKey ? await wrappedKeyHash(w.wrappedSecretKey) : (w.strippedSecretHash ?? null);
    const binding = { tenantId: w.tenantId, folderId: w.folderId, recipientId: self.userId, signerId: w.signer.userId };
    return await verifyFolderKey(signerKey, binding, await wrappedKeyHash(w.wrappedKey), secretHash, w.signature);
  } catch {
    return false;
  }
}

// ---------- Nachweis für die Admin-Wiederherstellung ----------

const PROOF_INFO = 'bastion:recovery-proof:v1';

/** Nachweis, dass jemand den AccountKey kennt (bei der Wiederherstellung an den Server gesendet). */
export async function recoveryProof(accountKeyRaw: Bytes) {
  return b64(await hkdf(accountKeyRaw, PROOF_INFO));
}

/** Prüfwert, den der Server speichert: SHA-256 des Nachweises (hex). */
export async function recoveryVerifier(accountKeyRaw: Bytes) {
  return sha256Hex(await hkdf(accountKeyRaw, PROOF_INFO));
}

