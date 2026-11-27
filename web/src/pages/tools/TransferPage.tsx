import { useQueryClient } from '@tanstack/react-query';
import { Building2, Download, Folder, Upload, User } from 'lucide-react';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, cx, ErrorAlert, Field, FileDrop, PageHeader, PasswordInput, Select } from '../../components/ui';
import { MasterPasswordFields } from '../../components/MasterPasswordFields';
import { post } from '../../lib/api';
import { uuid } from '../../lib/crypto/encoding';
import { buildImportPlan, hasPaths, ImportPlan, ImportProgress, runStructuredImport } from '../../lib/import-plan';
import { encryptItem, splitFields } from '../../lib/items';
import { buildEncryptedExport, detectFormat, ImportedItem, ImportFormat, openEncryptedExport, parsePlainImport } from '../../lib/transfer';
import { useCan, useUnlocked } from '../../state/session';
import { itemKeysFor, loadFolderKeys, useStructure, useVaultItems } from '../../state/vault';
import { useWritableTargets } from '../vault/ItemEditor';

/** Vorschau der Ordnerstruktur, die beim Import angelegt bzw. weiterverwendet wird. */
function PlanPreview({ plan }: { plan: ImportPlan }) {
  const { t } = useTranslation();
  const newDepts = plan.departments.filter((d) => !d.existingId).length;
  const newFolders = plan.folders.filter((f) => !f.existingId).length;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {[
          [t('transfer.plan.departments'), plan.departments.length, newDepts],
          [t('transfer.plan.folders'), plan.folders.length, newFolders],
          [t('transfer.plan.items'), plan.placements.length, null],
        ].map(([label, total, fresh]) => (
          <div key={String(label)} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-lg font-semibold text-slate-800">{total}</p>
            {fresh !== null && <p className="text-xs text-slate-500">{t('transfer.plan.new', { count: Number(fresh) })}</p>}
          </div>
        ))}
      </div>
      {(plan.unsorted > 0 || plan.multiPath > 0) && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600">
          {plan.unsorted > 0 && <li>{t('transfer.plan.unsortedHint', { count: plan.unsorted, dept: t('transfer.unsortedName') })}</li>}
          {plan.multiPath > 0 && <li>{t('transfer.plan.multiHint', { count: plan.multiPath })}</li>}
        </ul>
      )}
      <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
        {plan.departments.map((d) => (
          <div key={d.name} className="border-b border-slate-100 last:border-0">
            <div className="flex items-center gap-2 bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-800">
              <Building2 className="h-4 w-4 text-brand-500" />
              <span className="truncate">{d.name}</span>
              {!d.existingId && <Badge color="green">{t('transfer.plan.newBadge')}</Badge>}
            </div>
            <ul>
              {plan.folders
                .filter((f) => f.dept === d.name)
                .map((f) => (
                  <li key={f.key} className="flex items-center gap-2 py-1 pr-3 text-sm text-slate-700" style={{ paddingLeft: `${0.75 + f.segments.length * 1.1}rem` }}>
                    <Folder className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="mr-auto truncate">{f.segments[f.segments.length - 1]}</span>
                    {!f.existingId && <Badge color="green">{t('transfer.plan.newBadge')}</Badge>}
                    {f.count > 0 && <span className="shrink-0 text-xs tabular-nums text-slate-500">{t('structure.items', { count: f.count })}</span>}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModeOption({ checked, onSelect, title, hint, disabled }: { checked: boolean; onSelect: () => void; title: string; hint: string; disabled?: boolean }) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
        checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <input type="radio" className="mt-1 accent-brand-900" checked={checked} onChange={onSelect} disabled={disabled} />
      <span>
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

function ImportCard() {
  const { t } = useTranslation();
  const { keys, info } = useUnlocked();
  const can = useCan();
  const qc = useQueryClient();
  const targets = useWritableTargets();
  const structure = useStructure();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState<ImportFormat | null>(null);
  const [password, setPassword] = useState('');
  const [parsed, setParsed] = useState<ImportedItem[] | null>(null);
  const [target, setTarget] = useState('personal');
  const [mode, setMode] = useState<'structure' | 'single'>('structure');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ imported: number; createdDepartments: number; createdFolders: number } | null>(null);

  const canStructure = !!info.tenant && can('tenant.structure.manage');
  const withPaths = !!parsed && hasPaths(parsed);
  const structured = withPaths && canStructure && mode === 'structure';
  const plan = useMemo(
    () => (parsed && structured ? buildImportPlan(parsed, structure.data, { general: t('transfer.generalName'), unsorted: t('transfer.unsortedName') }) : null),
    [parsed, structured, structure.data, t],
  );

  const onFile = async (file: File) => {
    setError(null);
    setParsed(null);
    setResult(null);
    setFormat(null);
    if (file.size > 20 * 1024 * 1024) return setError(new Error('FILE_TOO_LARGE'));
    const content = await file.text();
    setFileName(file.name);
    setText(content);
    try {
      const f = detectFormat(content);
      setFormat(f);
      if (f !== 'bastion-encrypted') setParsed(parsePlainImport(content).items);
    } catch (err) {
      setError(err);
    }
  };

  const decrypt = async () => {
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      setParsed(await openEncryptedExport(password, text));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (r: { imported: number; createdDepartments: number; createdFolders: number }) => {
    setResult(r);
    setParsed(null);
    setText(null);
    setFileName('');
    setFormat(null);
    await Promise.all(['structure', 'items'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };

  const runStructured = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const r = await runStructuredImport(plan, info, keys, setProgress);
      await finish(r);
    } catch (err) {
      setError(err);
      // Teilweise angelegte Struktur sichtbar machen; ein erneuter Import verwendet sie weiter
      await qc.invalidateQueries({ queryKey: ['structure'] });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const runImport = async () => {
    if (!parsed?.length) return;
    setBusy(true);
    setError(null);
    try {
      if (target !== 'personal') await loadFolderKeys(info, keys);
      const itemKeys = itemKeysFor(keys, target);
      let created = 0;
      for (let i = 0; i < parsed.length; i += 500) {
        const batch = await Promise.all(
          parsed.slice(i, i + 500).map(async (it) => {
            const id = uuid();
            const { overview, secret } = splitFields(it.type, it.name, it.values);
            return { id, type: it.type, folderId: target === 'personal' ? null : target, ...(await encryptItem(itemKeys, id, overview, secret)) };
          }),
        );
        created += (await post<{ created: number }>('/items/bulk', { items: batch })).created;
      }
      await finish({ imported: created, createdDepartments: 0, createdFolders: 0 });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const progressLabel = progress
    ? t(progress.phase === 'structure' ? 'transfer.progressStructure' : 'transfer.progressItems', { done: progress.done, total: progress.total })
    : null;

  return (
    <Card title={t('transfer.importTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('transfer.importDescription')}</p>
        <ErrorAlert error={error} />
        {result !== null && (
          <Alert kind="success">
            {t('transfer.imported', { count: result.imported })}
            {(result.createdDepartments > 0 || result.createdFolders > 0) &&
              ' ' + t('transfer.createdStructure', { departments: result.createdDepartments, folders: result.createdFolders })}
          </Alert>
        )}
        <FileDrop
          accept=".json,.csv,text/csv,application/json"
          onFile={onFile}
          disabled={busy}
          fileName={fileName || undefined}
          detail={format ? `${t(`transfer.format.${format}`)}${parsed ? ` · ${t('transfer.found', { count: parsed.length })}` : ''}` : undefined}
        />
        {format === 'bastion-encrypted' && !parsed && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={t('transfer.exportPassword')}>
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </div>
            <Button onClick={decrypt} loading={busy}>
              {t('transfer.decrypt')}
            </Button>
          </div>
        )}
        {parsed && !parsed.length && <Alert kind="warning">{t('transfer.nothingFound')}</Alert>}
        {parsed && parsed.length > 0 && (
          <>
            {withPaths && (
              <div className="space-y-2">
                <ModeOption
                  checked={structured}
                  onSelect={() => setMode('structure')}
                  disabled={!canStructure || busy}
                  title={t('transfer.modeStructure')}
                  hint={canStructure ? t('transfer.modeStructureHint') : t('transfer.modeStructureNoPermission')}
                />
                <ModeOption checked={!structured} onSelect={() => setMode('single')} disabled={busy} title={t('transfer.modeSingle')} hint={t('transfer.modeSingleHint')} />
              </div>
            )}
            {plan ? (
              <PlanPreview plan={plan} />
            ) : (
              <Field label={t('transfer.target')}>
                <Select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
                  {targets.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={plan ? runStructured : runImport} loading={busy} icon={<Upload className="h-4 w-4" />}>
                {plan ? t('transfer.importCount', { count: plan.placements.length }) : t('transfer.importCount', { count: parsed.length })}
              </Button>
              {progressLabel && <span className="text-sm text-slate-500">{progressLabel}</span>}
            </div>
            <p className="text-xs text-slate-500">{t('transfer.deleteSourceHint')}</p>
          </>
        )}
      </div>
    </Card>
  );
}

/** Checkbox mit drittem Zustand „teilweise ausgewählt“ für die Baumauswahl im Export. */
function TreeCheckbox({
  checked,
  indeterminate,
  onChange,
  children,
  count,
  depth = 0,
  strong,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  children: ReactNode;
  count: number;
  depth?: number;
  strong?: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <label
      className={cx('flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-sm hover:bg-slate-50', strong ? 'font-medium text-slate-800' : 'text-slate-700')}
      style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
    >
      <input ref={ref} type="checkbox" className="h-4 w-4 shrink-0 rounded border-slate-300 accent-brand-900" checked={checked} onChange={onChange} />
      {children}
      <span className="ml-auto shrink-0 text-xs tabular-nums text-slate-500">{t('structure.items', { count })}</span>
    </label>
  );
}

function ExportCard() {
  const { t } = useTranslation();
  const items = useVaultItems();
  const structure = useStructure();
  // Standard: nur der persönliche Tresor; Unternehmensordner werden bewusst einzeln dazugewählt
  const [personal, setPersonal] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const folderNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of structure.data?.departments ?? []) for (const f of d.folders) m.set(f.id, `${d.name} / ${f.path}`);
    return m;
  }, [structure.data]);

  const exportable = useMemo(() => (items.data ?? []).filter((i) => !i.error && i.secret), [items.data]);
  const personalCount = exportable.filter((i) => i.personal).length;

  // Baum aus Abteilungen und Ordnern; nur Ordner, die selbst oder in Unterordnern exportierbare Einträge haben.
  // ids eines Ordners: er selbst und alle sichtbaren Unterordner (ein Haken wählt den ganzen Zweig).
  const tree = useMemo(() => {
    const own = new Map<string, number>();
    for (const i of exportable) if (!i.personal && i.folderId) own.set(i.folderId, (own.get(i.folderId) ?? 0) + 1);
    return (structure.data?.departments ?? [])
      .map((d) => {
        const children = new Map<string | null, string[]>();
        for (const f of d.folders) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.id]);
        const subtree = new Map<string, string[]>();
        const total = new Map<string, number>();
        const walk = (id: string): string[] => {
          const ids = [id, ...(children.get(id) ?? []).flatMap(walk)];
          subtree.set(id, ids);
          total.set(id, ids.reduce((n, x) => n + (own.get(x) ?? 0), 0));
          return ids;
        };
        for (const f of d.folders) if (!f.parentId || !d.folders.some((x) => x.id === f.parentId)) walk(f.id);
        const folders = d.folders.filter((f) => (total.get(f.id) ?? 0) > 0);
        const visible = new Set(folders.map((f) => f.id));
        return {
          id: d.id,
          name: d.name,
          folders: folders.map((f) => ({ id: f.id, name: f.name, depth: f.depth, ids: (subtree.get(f.id) ?? [f.id]).filter((x) => visible.has(x)), count: total.get(f.id) ?? 0 })),
          ids: folders.map((f) => f.id),
          count: folders.reduce((n, f) => n + (own.get(f.id) ?? 0), 0),
        };
      })
      .filter((d) => d.count > 0);
  }, [exportable, structure.data]);

  const nodeState = (ids: string[]) => {
    const n = ids.filter((id) => picked.has(id)).length;
    return { checked: ids.length > 0 && n === ids.length, indeterminate: n > 0 && n < ids.length };
  };
  const toggle = (ids: string[]) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  const selectAll = (on: boolean) => {
    setPersonal(on);
    setPicked(new Set(on ? tree.flatMap((d) => d.ids) : []));
  };

  const selection = exportable.filter((i) => (i.personal ? personal : picked.has(i.folderId!)));

  const run = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const json = await buildEncryptedExport(password, selection, (i) => (i.personal ? 'personal' : (folderNames.get(i.folderId!) ?? '')));
      // Export von Unternehmenseinträgen im Audit-Log festhalten, bevor die Datei entsteht
      const company = selection.filter((i) => !i.personal);
      if (company.length) {
        await post('/items/export-event', { count: company.length, folders: [...new Set(company.map((i) => i.folderId!))] });
      }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bastion-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('transfer.exportTitle')}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('transfer.exportDescription')}</p>
        <ErrorAlert error={error} />
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <p className="mr-auto text-sm font-medium text-slate-700">{t('transfer.exportSelection')}</p>
            <Button variant="ghost" size="sm" onClick={() => selectAll(true)}>
              {t('transfer.selectAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => selectAll(false)}>
              {t('transfer.selectNone')}
            </Button>
          </div>
          <div className="max-h-96 overflow-y-auto rounded-md border border-slate-200">
            {personalCount > 0 && (
              <div className="border-b border-slate-100 last:border-0">
                <TreeCheckbox checked={personal} onChange={() => setPersonal((v) => !v)} count={personalCount} strong>
                  <User className="h-4 w-4 shrink-0 text-brand-500" />
                  <span className="truncate">{t('nav.personal')}</span>
                </TreeCheckbox>
              </div>
            )}
            {tree.map((d) => (
              <div key={d.id} className="border-b border-slate-100 last:border-0">
                <TreeCheckbox {...nodeState(d.ids)} onChange={() => toggle(d.ids)} count={d.count} strong>
                  <Building2 className="h-4 w-4 shrink-0 text-brand-500" />
                  <span className="truncate">{d.name}</span>
                </TreeCheckbox>
                {d.folders.map((f) => (
                  <TreeCheckbox key={f.id} {...nodeState(f.ids)} onChange={() => toggle(f.ids)} count={f.count} depth={f.depth + 1}>
                    <Folder className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{f.name}</span>
                  </TreeCheckbox>
                ))}
              </div>
            ))}
            {!personalCount && !tree.length && <p className="px-3 py-2 text-sm text-slate-500">{t('transfer.nothingToExport')}</p>}
          </div>
          {tree.length > 0 && <p className="text-xs text-slate-500">{t('transfer.includeFoldersHint')}</p>}
        </div>
        <MasterPasswordFields onChange={setPassword} label={t('transfer.exportPassword')} />
        <Button onClick={run} loading={busy} disabled={!password || !selection.length} icon={<Download className="h-4 w-4" />}>
          {t('transfer.export', { count: selection.length })}
        </Button>
      </div>
    </Card>
  );
}

export function TransferPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={embedded ? 'space-y-6' : 'mx-auto max-w-3xl space-y-6 p-6'}>
      {embedded ? <p className="text-sm text-slate-600">{t('transfer.description')}</p> : <PageHeader title={t('transfer.title')} description={t('transfer.description')} help="import-export" />}
      <ImportCard />
      <ExportCard />
    </div>
  );
}
