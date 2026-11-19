import { get, post } from './api';
import type { VaultKeys } from './crypto/account';
import { uuid } from './crypto/encoding';
import { encryptItem, ItemKeys, splitFields } from './items';
import type { ImportedItem } from './transfer';
import type { SessionInfo, StructureInfo } from './types';
import { createFolderKeys, itemKeysFor, loadFolderKeys } from '../state/vault';

/**
 * Import mit Ordnerstruktur:
 * Der erste Pfadteil wird zur Abteilung, jeder weitere ("/") zu einem Unterordner.
 * Einträge mit nur einem Pfadteil landen im Ordner "Allgemein" der Abteilung,
 * Einträge ohne Pfad in der Abteilung "Unsortiert" / Ordner "Unsortiert".
 * Liegt ein Eintrag in mehreren Pfaden, wird er in jeden Ordner kopiert.
 * Vorhandene Abteilungen und Ordner (gleicher Name auf gleicher Ebene) werden weiterverwendet.
 */

const SEP = '\u0000';
const MAX_NAME = 100;

export interface PlanFolder {
  key: string;
  dept: string;
  segments: string[];
  parentKey: string | null;
  existingId?: string;
  /** Einträge, die direkt in diesem Ordner landen */
  count: number;
}

export interface PlanDepartment {
  name: string;
  existingId?: string;
}

export interface ImportPlan {
  departments: PlanDepartment[];
  /** Eltern vor Kindern, innerhalb einer Ebene alphabetisch */
  folders: PlanFolder[];
  placements: { item: ImportedItem; folderKey: string }[];
  unsorted: number;
  multiPath: number;
}

export interface PlanNames {
  general: string;
  unsorted: string;
}

function clean(name: string) {
  return name.trim().slice(0, MAX_NAME);
}

/** Zerlegt einen Pfad in Abteilung und Ordnersegmente. */
function resolvePath(path: string | null, names: PlanNames): { dept: string; segments: string[] } {
  const parts = (path ?? '').split('/').map(clean).filter(Boolean);
  if (!parts.length) return { dept: names.unsorted, segments: [names.unsorted] };
  if (parts.length === 1) return { dept: parts[0], segments: [names.general] };
  return { dept: parts[0], segments: parts.slice(1) };
}

const folderKey = (dept: string, segments: string[]) => [dept, ...segments].join(SEP);

export function hasPaths(items: ImportedItem[]) {
  return items.some((i) => i.paths?.some((p) => p.trim()));
}

export function buildImportPlan(items: ImportedItem[], structure: StructureInfo | undefined, names: PlanNames): ImportPlan {
  const deptByName = new Map((structure?.departments ?? []).map((d) => [d.name, d]));
  const folders = new Map<string, PlanFolder>();
  const departments = new Map<string, PlanDepartment>();
  const placements: ImportPlan['placements'] = [];
  let unsorted = 0;
  let multiPath = 0;

  const ensureFolder = (dept: string, segments: string[]): PlanFolder => {
    const key = folderKey(dept, segments);
    const known = folders.get(key);
    if (known) return known;
    if (!departments.has(dept)) departments.set(dept, { name: dept, existingId: deptByName.get(dept)?.id });
    const parent = segments.length > 1 ? ensureFolder(dept, segments.slice(0, -1)) : null;
    const existingDept = deptByName.get(dept);
    const existing =
      existingDept && (!parent || parent.existingId)
        ? existingDept.folders.find((f) => f.name === segments[segments.length - 1] && (f.parentId ?? null) === (parent?.existingId ?? null))
        : undefined;
    const folder: PlanFolder = { key, dept, segments, parentKey: parent?.key ?? null, existingId: existing?.id, count: 0 };
    folders.set(key, folder);
    return folder;
  };

  for (const item of items) {
    const paths = [...new Set((item.paths ?? []).map((p) => p.trim()).filter(Boolean))];
    if (!paths.length) unsorted++;
    if (paths.length > 1) multiPath++;
    const targets = new Set((paths.length ? paths : [null]).map((p) => {
      const { dept, segments } = resolvePath(p, names);
      return ensureFolder(dept, segments);
    }));
    for (const f of targets) {
      f.count++;
      placements.push({ item, folderKey: f.key });
    }
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const ordered = [...folders.values()].sort((a, b) => {
    if (a.dept !== b.dept) return collator.compare(a.dept, b.dept);
    // Tiefensuche: segmentweise vergleichen, kürzerer Pfad (Elternordner) zuerst
    for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
      const c = collator.compare(a.segments[i], b.segments[i]);
      if (c) return c;
    }
    return a.segments.length - b.segments.length;
  });
  return {
    departments: [...departments.values()].sort((a, b) => collator.compare(a.name, b.name)),
    folders: ordered,
    placements,
    unsorted,
    multiPath,
  };
}

export type ImportProgress = { phase: 'structure'; done: number; total: number } | { phase: 'items'; done: number; total: number };

export class ImportError extends Error {
  constructor(
    code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/** Legt fehlende Abteilungen/Ordner an und importiert die Einträge verschlüsselt. */
export async function runStructuredImport(plan: ImportPlan, info: SessionInfo, keys: VaultKeys, onProgress: (p: ImportProgress) => void) {
  const deptIds = new Map<string, string>();
  let createdDepartments = 0;
  let createdFolders = 0;
  const newDepts = plan.departments.filter((d) => !d.existingId);
  const newFolders = plan.folders.filter((f) => !f.existingId);
  const total = newDepts.length + newFolders.length;
  let done = 0;
  onProgress({ phase: 'structure', done, total });

  for (const d of plan.departments) {
    if (d.existingId) {
      deptIds.set(d.name, d.existingId);
      continue;
    }
    const created = await post<{ id: string }>('/departments', { name: d.name, description: '' });
    deptIds.set(d.name, created.id);
    createdDepartments++;
    onProgress({ phase: 'structure', done: ++done, total });
  }

  // Ordnerschlüssel: vorhandene aus dem Cache, neue lokal erzeugt
  await loadFolderKeys(info, keys);
  const folderIds = new Map<string, string>();
  const folderKeys = new Map<string, ItemKeys>();
  for (const f of plan.folders) {
    const label = `${f.dept} / ${f.segments.join(' / ')}`;
    if (f.existingId) {
      folderIds.set(f.key, f.existingId);
      if (f.count > 0) {
        try {
          folderKeys.set(f.key, itemKeysFor(keys, f.existingId));
        } catch {
          throw new ImportError('IMPORT_FOLDER_NO_KEY', label);
        }
      }
      continue;
    }
    const departmentId = deptIds.get(f.dept)!;
    const parentId = f.parentKey ? folderIds.get(f.parentKey)! : null;
    const query = new URLSearchParams({ inherit: 'true', ...(parentId ? { parentId } : {}) });
    const recipients = await get<{ userId: string; publicKey: string | null; reveal: boolean; endorsement: string | null }[]>(`/departments/${departmentId}/recipients?${query}`);
    if (!recipients.some((r) => r.userId === info.user.id && r.reveal)) throw new ImportError('IMPORT_FOLDER_NO_ACCESS', label);
    const id = uuid();
    const { wrapped, itemKeys } = await createFolderKeys(info, keys, id, recipients);
    const created = await post<{ id: string }>('/folders', {
      id,
      departmentId,
      parentId,
      name: f.segments[f.segments.length - 1],
      description: '',
      inheritPermissions: true,
      keys: wrapped,
    });
    folderIds.set(f.key, created.id);
    folderKeys.set(f.key, itemKeys);
    createdFolders++;
    onProgress({ phase: 'structure', done: ++done, total });
  }

  let imported = 0;
  const items = plan.placements;
  onProgress({ phase: 'items', done: 0, total: items.length });
  for (let i = 0; i < items.length; i += 500) {
    const batch = await Promise.all(
      items.slice(i, i + 500).map(async ({ item, folderKey: fk }) => {
        const id = uuid();
        const { overview, secret } = splitFields(item.type, item.name, item.values);
        return { id, type: item.type, folderId: folderIds.get(fk)!, ...(await encryptItem(folderKeys.get(fk)!, id, overview, secret)) };
      }),
    );
    imported += (await post<{ created: number }>('/items/bulk', { items: batch })).created;
    onProgress({ phase: 'items', done: Math.min(i + 500, items.length), total: items.length });
  }
  return { imported, createdDepartments, createdFolders };
}
