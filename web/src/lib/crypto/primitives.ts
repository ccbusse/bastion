/**
 * Kryptografische Primitive (BSI TR-02102-1 konform):
 * - Argon2id (RFC 9106) zur Schlüsselableitung aus dem Masterpasswort
 * - HKDF-SHA-256 zur Ableitung getrennter Schlüssel für Authentifizierung und Verschlüsselung
 * - AES-256-GCM mit 96-Bit-Zufalls-IV und Associated Data (Kontextbindung)
 * - RSA-OAEP-4096 mit SHA-256 für den Schlüsselaustausch
 */
import { argon2id } from 'hash-wasm';
import { b64, Bytes, fromUtf8, randomBytes, toHex, unb64, utf8 } from './encoding';

export interface KdfParams {
  kdfSalt: string;
  kdfMemory: number;
  kdfIterations: number;
  kdfParallelism: number;
}

/** RFC 9106, zweite empfohlene Option: 64 MiB, 3 Iterationen, 4 Lanes. */
export const DEFAULT_KDF = { kdfMemory: 65536, kdfIterations: 3, kdfParallelism: 4 };

export function newKdfParams(): KdfParams {
  return { kdfSalt: b64(randomBytes(16)), ...DEFAULT_KDF };
}

export async function deriveMasterKey(password: string, p: KdfParams): Promise<Bytes> {
  if (p.kdfMemory < 65536 || p.kdfIterations < 3) throw new Error('KDF_PARAMS_TOO_WEAK');
  const out = await argon2id({
    password: password.normalize('NFKC'),
    salt: unb64(p.kdfSalt),
    parallelism: p.kdfParallelism,
    iterations: p.kdfIterations,
    memorySize: p.kdfMemory,
    hashLength: 32,
    outputType: 'binary',
  });
  return new Uint8Array(out);
}

export async function hkdf(ikm: Bytes, info: string, length = 32): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(info) }, key, length * 8);
  return new Uint8Array(bits);
}

/** Leitet aus dem Masterpasswort den Login-Hash (an Server) und den Wrap-Schlüssel (bleibt lokal) ab. */
export async function deriveLoginKeys(password: string, p: KdfParams) {
  const master = await deriveMasterKey(password, p);
  try {
    const authHash = b64(await hkdf(master, 'bastion:auth:v1'));
    const encRaw = await hkdf(master, 'bastion:enc:v1');
    const encKey = await importAesKey(encRaw);
    encRaw.fill(0);
    return { authHash, encKey };
  } finally {
    master.fill(0);
  }
}

// ---------- AES-256-GCM ----------

export function importAesKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('INVALID_KEY_LENGTH');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBytes(key: CryptoKey, data: Bytes, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: 128 }, key, data);
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptBytes(key: CryptoKey, value: string, aad: string): Promise<Bytes> {
  const [v, iv, ct] = value.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('INVALID_CIPHERTEXT');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: utf8(aad), tagLength: 128 }, key, unb64(ct));
  return new Uint8Array(pt);
}

export async function encryptJson(key: CryptoKey, value: unknown, aad: string) {
  return encryptBytes(key, utf8(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(key: CryptoKey, value: string, aad: string): Promise<T> {
  return JSON.parse(fromUtf8(await decryptBytes(key, value, aad))) as T;
}

// ---------- RSA-OAEP-4096 ----------

const RSA_PARAMS: RsaHashedKeyGenParams = { name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

export async function generateRsaKeyPair() {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const privateKey = await importPrivateKey(pkcs8);
  return { publicKey: b64(spki), pkcs8, privateKey };
}

export function importPrivateKey(pkcs8: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
}

const publicKeyCache = new Map<string, Promise<CryptoKey>>();
function importPublicKey(spkiB64: string): Promise<CryptoKey> {
  let p = publicKeyCache.get(spkiB64);
  if (!p) {
    p = crypto.subtle.importKey('spki', unb64(spkiB64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    publicKeyCache.set(spkiB64, p);
  }
  return p;
}

export async function rsaWrap(publicKeyB64: string, data: Bytes): Promise<string> {
  const ct = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, await importPublicKey(publicKeyB64), data);
  return b64(new Uint8Array(ct));
}

export async function rsaUnwrap(privateKey: CryptoKey, value: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(value)));
}

/** Fingerprint: SHA-256 über SPKI, 128 Bit in 8 Gruppen à 4 Hex-Zeichen (identisch zur Serverberechnung). */
export async function fingerprint(publicKeyB64: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64(publicKeyB64)));
  return toHex(digest.subarray(0, 16)).toUpperCase().match(/.{4}/g)!.join('-');
}
