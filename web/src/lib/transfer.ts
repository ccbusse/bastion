import Papa from 'papaparse';
import { AAD } from './crypto/account';
import { decryptJson, deriveMasterKey, encryptJson, hkdf, importAesKey, KdfParams, newKdfParams } from './crypto/primitives';
import { ITEM_FIELDS } from './items';
import type { DecryptedItem, FieldValues, ItemType } from './types';

export interface ImportedItem {
  type: ItemType;
  name: string;
  values: FieldValues;
  group?: string;
  /** Ordnerpfade aus der Quelle ("Abteilung/Ordner/Unterordner"), z. B. Bitwarden-Collections */
  paths?: string[];
}

export type ImportFormat = 'bitwarden-json' | 'bitwarden-csv' | 'keepass-csv' | 'generic-csv' | 'bastion-encrypted';

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

// ---------- Bitwarden JSON ----------

interface BwItem {
  type: number;
  name: string;
  notes?: string | null;
  folderId?: string | null;
  login?: { username?: string; password?: string; totp?: string; uris?: { uri?: string }[] };
  card?: { cardholderName?: string; brand?: string; number?: string; expMonth?: string; expYear?: string; code?: string };
  identity?: Record<string, string | null>;
  sshKey?: { privateKey?: string; publicKey?: string };
  fields?: { name?: string; value?: string }[];
  collectionIds?: string[] | null;
}

function fromBitwardenJson(data: { items?: BwItem[]; folders?: { id: string; name: string }[]; collections?: { id: string; name: string }[] }): ImportedItem[] {
  const folders = new Map((data.folders ?? []).map((f) => [f.id, f.name]));
  const collections = new Map((data.collections ?? []).map((c) => [c.id, c.name]));
  return (data.items ?? []).map((i): ImportedItem => {
    const extra = (i.fields ?? []).map((f) => `${s(f.name)}: ${s(f.value)}`).join('\n');
    const notes = [s(i.notes), extra].filter(Boolean).join('\n\n');
    const group = i.folderId ? folders.get(i.folderId) : undefined;
    // Organisations-Export: Collections, persönlicher Export: Ordner
    const fromCollections = (i.collectionIds ?? []).map((id) => collections.get(id)).filter((n): n is string => !!n);
    return { ...fromBitwardenItem(i, notes, group), paths: fromCollections.length ? fromCollections : group ? [group] : [] };
  });
}

function fromBitwardenItem(i: BwItem, notes: string, group: string | undefined): ImportedItem {
  switch (i.type) {
    case 1:
      return {
        type: 'LOGIN',
        name: i.name,
        group,
        values: { username: s(i.login?.username), password: s(i.login?.password), totp: s(i.login?.totp), url: s(i.login?.uris?.[0]?.uri), notes },
      };
    case 3:
      return {
        type: 'CARD',
        name: i.name,
        group,
        values: {
          cardholder: s(i.card?.cardholderName),
          brand: s(i.card?.brand),
          number: s(i.card?.number),
          expiry: i.card?.expMonth ? `${s(i.card.expMonth).padStart(2, '0')}/${s(i.card.expYear).slice(-2)}` : '',
          cvv: s(i.card?.code),
          notes,
        },
      };
    case 5:
      return { type: 'SSH_KEY', name: i.name, group, values: { privateKey: s(i.sshKey?.privateKey), publicKey: s(i.sshKey?.publicKey), notes } };
    case 4: {
      const id = Object.entries(i.identity ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      return { type: 'NOTE', name: i.name, group, values: { notes: [id, notes].filter(Boolean).join('\n\n') } };
    }
    default:
      return { type: 'NOTE', name: i.name, group, values: { notes } };
  }
}

// ---------- CSV ----------

function fromCsv(text: string): { format: ImportFormat; items: ImportedItem[] } {
  const parsed = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
  const headers = (parsed.meta.fields ?? []).map((h) => h.toLowerCase());
  const rows = parsed.data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), s(v)])));

  if (headers.includes('login_password') || headers.includes('login_username')) {
    return {
      format: 'bitwarden-csv',
      items: rows.map((r): ImportedItem => {
        // Organisations-Export: "collections" (mehrere durch Komma getrennt), persönlicher Export: "folder"
        const paths = r.collections ? r.collections.split(',') : r.folder ? [r.folder] : [];
        const notes = [r.notes, r.fields].filter(Boolean).join('\n\n');
        return r.type === 'note'
          ? { type: 'NOTE', name: r.name, group: r.folder || undefined, paths, values: { notes } }
          : {
              type: 'LOGIN',
              name: r.name,
              group: r.folder || undefined,
              paths,
              values: { username: r.login_username, password: r.login_password, totp: r.login_totp, url: (r.login_uri ?? '').split(',')[0], notes },
            };
      }),
    };
  }
  if (headers.includes('title') && headers.includes('password')) {
    return {
      format: 'keepass-csv',
      items: rows.map((r): ImportedItem => ({
        type: 'LOGIN',
        name: r.title || r.url || 'Import',
        group: r.group || undefined,
        values: { username: r.username ?? r['user name'], password: r.password, url: r.url, totp: r.totp ?? '', notes: r.notes },
      })),
    };
  }
  if (headers.includes('password') && (headers.includes('name') || headers.includes('url'))) {
    return {
      format: 'generic-csv',
      items: rows.map((r): ImportedItem => ({
        type: 'LOGIN',
        name: r.name || r.url || 'Import',
        values: { username: r.username ?? r.login ?? '', password: r.password, url: r.url ?? '', notes: r.note ?? r.notes ?? '' },
      })),
    };
  }
  throw new Error('UNKNOWN_FORMAT');
}

export function detectFormat(text: string): ImportFormat {
  const t = text.trim();
  if (t.startsWith('{')) {
    const data = JSON.parse(t);
    if (data.format === 'bastion-export') return 'bastion-encrypted';
    if (data.encrypted) throw new Error('ENCRYPTED_BITWARDEN_UNSUPPORTED');
    if (Array.isArray(data.items)) return 'bitwarden-json';
    throw new Error('UNKNOWN_FORMAT');
  }
  return fromCsv(t).format;
}

export function parsePlainImport(text: string): { format: ImportFormat; items: ImportedItem[] } {
  const t = text.trim();
  if (t.startsWith('{')) return { format: 'bitwarden-json', items: normalize(fromBitwardenJson(JSON.parse(t))) };
  const r = fromCsv(t);
  return { format: r.format, items: normalize(r.items) };
}

function normalize(items: ImportedItem[]): ImportedItem[] {
  return items
    .filter((i) => i.name || Object.values(i.values).some(Boolean))
    .map((i) => {
      const allowed = new Set(ITEM_FIELDS[i.type].map((f) => f.key));
      return { ...i, name: (i.name || 'Import').slice(0, 200), values: Object.fromEntries(Object.entries(i.values).filter(([k, v]) => allowed.has(k) && v)) };
    });
}

// ---------- Verschlüsselter Bastion-Export ----------

interface ExportFile {
  format: 'bastion-export';
  version: 1;
  createdAt: string;
  kdf: KdfParams;
  data: string;
}

async function exportKey(password: string, kdf: KdfParams) {
  const master = await deriveMasterKey(password, kdf);
  const raw = await hkdf(master, AAD.export);
  master.fill(0);
  const key = await importAesKey(raw);
  raw.fill(0);
  return key;
}

export async function buildEncryptedExport(password: string, items: DecryptedItem[], groupName: (i: DecryptedItem) => string): Promise<string> {
  const kdf = newKdfParams();
  const payload: ImportedItem[] = items
    .filter((i) => !i.error && i.secret)
    .map((i) => {
      const { name, last4, ...rest } = i.overview;
      void last4;
      return { type: i.type, name, group: groupName(i), values: { ...rest, ...i.secret } };
    });
  const file: ExportFile = { format: 'bastion-export', version: 1, createdAt: new Date().toISOString(), kdf, data: await encryptJson(await exportKey(password, kdf), payload, AAD.export) };
  return JSON.stringify(file, null, 2);
}

export async function openEncryptedExport(password: string, text: string): Promise<ImportedItem[]> {
  const file = JSON.parse(text) as ExportFile;
  if (file.format !== 'bastion-export' || file.version !== 1) throw new Error('UNKNOWN_FORMAT');
  try {
    return normalize(await decryptJson<ImportedItem[]>(await exportKey(password, file.kdf), file.data, AAD.export));
  } catch {
    throw new Error('WRONG_PASSWORD');
  }
}
