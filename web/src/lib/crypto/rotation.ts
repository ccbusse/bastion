import { AAD } from './account';
import { decryptJson, encryptJson } from './primitives';

/** Eintrag, der sich mit dem aktuellen Ordnerschlüssel nicht entschlüsseln lässt (Name nur, wenn die Übersicht lesbar ist). */
export interface UnreadableItem {
  id: string;
  name: string | null;
  updatedAt: string;
}

export interface RotatableItem {
  id: string;
  revision: number;
  overview: string;
  secret: string | null;
  updatedAt: string;
}

/**
 * Einträge eines Ordners für die Schlüsselerneuerung neu verschlüsseln. Nicht entschlüsselbare Einträge werden gemeldet
 * und unverändert zurückgegeben: Übernimmt der Aufrufer sie, sind sie nach der Erneuerung endgültig unlesbar
 * (der alte Schlüssel wird verworfen). Das darf nur nach ausdrücklicher Bestätigung geschehen.
 */
export async function reencryptFolderItems(
  old: { key: CryptoKey; secretKey?: CryptoKey | null },
  next: { overview: CryptoKey; secret: CryptoKey },
  items: RotatableItem[],
) {
  const unreadable: UnreadableItem[] = [];
  const out = await Promise.all(
    items.map(async (i) => {
      if (!i.secret) throw new Error('SECRET_UNAVAILABLE');
      let overview: unknown;
      try {
        overview = await decryptJson(old.key, i.overview, AAD.item(i.id, 'overview'));
      } catch {
        unreadable.push({ id: i.id, name: null, updatedAt: i.updatedAt });
        return { id: i.id, revision: i.revision, overview: i.overview, secret: i.secret };
      }
      let secret: unknown;
      try {
        secret = await decryptJson(old.secretKey ?? old.key, i.secret, AAD.item(i.id, 'secret'));
      } catch {
        const name = (overview as { name?: unknown } | null)?.name;
        unreadable.push({ id: i.id, name: typeof name === 'string' ? name : null, updatedAt: i.updatedAt });
        return { id: i.id, revision: i.revision, overview: i.overview, secret: i.secret };
      }
      return {
        id: i.id,
        revision: i.revision,
        overview: await encryptJson(next.overview, overview, AAD.item(i.id, 'overview')),
        secret: await encryptJson(next.secret, secret, AAD.item(i.id, 'secret')),
      };
    }),
  );
  return { items: out, unreadable };
}
