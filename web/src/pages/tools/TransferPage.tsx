import { useQueryClient } from '@tanstack/react-query';
import { Building2, Download, Folder, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, cx, ErrorAlert, Field, FileDrop, PageHeader, PasswordInput, Select } from '../../components/ui';
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

function ExportCard() {
  const { t } = useTranslation();
  const items = useVaultItems();
  const structure = useStructure();
  const [includeFolders, setIncludeFolders] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const folderNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of structure.data?.departments ?? []) for (const f of d.folders) m.set(f.id, `${d.name} / ${f.path}`);
    return m;
  }, [structure.data]);
  const selection = (items.data ?? []).filter((i) => !i.error && i.secret && (i.personal || includeFolders));

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
        <Checkbox label={t('transfer.includeFolders')} hint={t('transfer.includeFoldersHint')} checked={includeFolders} onChange={setIncludeFolders} />
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
