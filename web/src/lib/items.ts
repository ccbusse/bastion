import { AAD } from './crypto/account';
import { decryptJson, encryptJson } from './crypto/primitives';
import type { DecryptedItem, EncryptedItem, FieldValues, ItemType } from './types';

export type FieldKind = 'text' | 'password' | 'url' | 'textarea' | 'totp' | 'secretText' | 'secretArea';

export interface FieldDef {
  key: string;
  part: 'overview' | 'secret';
  kind: FieldKind;
  /** Wert wird standardmäßig verborgen */
  sensitive?: boolean;
  mono?: boolean;
}

export const ITEM_TYPES: ItemType[] = ['LOGIN', 'NOTE', 'CARD', 'BANK_ACCOUNT', 'SSH_KEY', 'API_KEY'];

/** Feldaufteilung: "overview" sieht jeder mit Leserecht, "secret" nur mit dem Recht "Passwörter anzeigen". */
export const ITEM_FIELDS: Record<ItemType, FieldDef[]> = {
  LOGIN: [
    { key: 'username', part: 'overview', kind: 'text' },
    { key: 'url', part: 'overview', kind: 'url' },
    { key: 'password', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'totp', part: 'secret', kind: 'totp', sensitive: true, mono: true },
    { key: 'notes', part: 'secret', kind: 'textarea' },
  ],
  NOTE: [{ key: 'notes', part: 'secret', kind: 'textarea' }],
  CARD: [
    { key: 'cardholder', part: 'overview', kind: 'text' },
    { key: 'brand', part: 'overview', kind: 'text' },
    { key: 'number', part: 'secret', kind: 'secretText', sensitive: true, mono: true },
    { key: 'expiry', part: 'secret', kind: 'text', mono: true },
    { key: 'cvv', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'pin', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'notes', part: 'secret', kind: 'textarea' },
  ],
  BANK_ACCOUNT: [
    { key: 'accountHolder', part: 'overview', kind: 'text' },
    { key: 'bankName', part: 'overview', kind: 'text' },
    { key: 'iban', part: 'secret', kind: 'secretText', mono: true },
    { key: 'bic', part: 'secret', kind: 'text', mono: true },
    { key: 'onlineBankingId', part: 'secret', kind: 'text' },
    { key: 'pin', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'notes', part: 'secret', kind: 'textarea' },
  ],
  SSH_KEY: [
    { key: 'host', part: 'overview', kind: 'text' },
    { key: 'publicKey', part: 'overview', kind: 'textarea', mono: true },
    { key: 'privateKey', part: 'secret', kind: 'secretArea', sensitive: true, mono: true },
    { key: 'passphrase', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'notes', part: 'secret', kind: 'textarea' },
  ],
  API_KEY: [
    { key: 'service', part: 'overview', kind: 'text' },
    { key: 'url', part: 'overview', kind: 'url' },
    { key: 'keyId', part: 'overview', kind: 'text', mono: true },
    { key: 'apiKey', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'apiSecret', part: 'secret', kind: 'password', sensitive: true, mono: true },
    { key: 'notes', part: 'secret', kind: 'textarea' },
  ],
};

export function splitFields(type: ItemType, name: string, values: FieldValues) {
  const overview: FieldValues = { name };
  const secret: FieldValues = {};
  for (const f of ITEM_FIELDS[type]) {
    const v = (values[f.key] ?? '').trim() === '' ? '' : values[f.key];
    if (!v) continue;
    (f.part === 'overview' ? overview : secret)[f.key] = v;
  }
  // Abgeleitete Übersichtsdaten (z. B. letzte 4 Ziffern) für die Listenansicht
  if (type === 'CARD' && secret.number) overview.last4 = secret.number.replace(/\D/g, '').slice(-4);
  return { overview, secret };
}

/** Schlüssel eines Eintrags: Übersicht mit dem Ordnerschlüssel, Geheimteil mit dem Geheim-Schlüssel (persönlich: beide gleich). */
export interface ItemKeys {
  overview: CryptoKey;
  secret: CryptoKey;
}

export async function encryptItem(keys: ItemKeys, id: string, overview: FieldValues, secret: FieldValues) {
  return {
    overview: await encryptJson(keys.overview, overview, AAD.item(id, 'overview')),
    secret: await encryptJson(keys.secret, secret, AAD.item(id, 'secret')),
  };
}

export async function decryptItem(keys: ItemKeys | undefined, item: EncryptedItem): Promise<DecryptedItem> {
  if (!keys) return { ...item, overview: { name: '' }, secret: null, error: true };
  try {
    const overview = await decryptJson<FieldValues & { name: string }>(keys.overview, item.overview, AAD.item(item.id, 'overview'));
    const secret = item.secret ? await decryptJson<FieldValues>(keys.secret, item.secret, AAD.item(item.id, 'secret')) : null;
    return { ...item, overview, secret };
  } catch {
    return { ...item, overview: { name: '' }, secret: null, error: true };
  }
}

export function itemSubtitle(item: DecryptedItem): string {
  const o = item.overview;
  switch (item.type) {
    case 'LOGIN':
      return o.username || hostOf(o.url) || '';
    case 'CARD':
      return [o.brand, o.last4 ? `•••• ${o.last4}` : ''].filter(Boolean).join(' ');
    case 'BANK_ACCOUNT':
      return o.bankName || o.accountHolder || '';
    case 'SSH_KEY':
      return o.host || '';
    case 'API_KEY':
      return o.service || hostOf(o.url) || '';
    default:
      return '';
  }
}

export function hostOf(url?: string) {
  if (!url) return '';
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

/** Nur http(s)-Links öffnen (kein javascript: o. ä.). */
export function safeHref(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
