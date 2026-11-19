import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, Pencil, Play, Plus, Server, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, ConfirmModal, ErrorAlert, Field, formatDate, HelpLink, IconButton, Input, Spinner } from '../../components/ui';
import { get, post, put } from '../../lib/api';
import { TargetModal } from './TargetModal';
import { describeTarget, presetOf, simpleOf, type TargetType } from './targetPresets';


interface AutoSettings {
  enabled: boolean;
  debounceMinutes: number;
  dailyTime: string | null;
  timezone: string;
  alertMail: boolean;
}

export interface Target {
  id: string;
  name: string;
  type: TargetType;
  enabled: boolean;
  keep: number;
  config: Record<string, unknown>;
  secrets: Record<string, boolean>;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFile: string | null;
  lastError: string | null;
  failures: number;
}

interface AutoStatus {
  settings: AutoSettings;
  lastRunAt: string | null;
  pendingChanges: boolean;
  folderBase: string;
  targets: Target[];
}

interface RunResult {
  name: string;
  ok: boolean;
  deleted?: number;
  error?: string;
}


/** Automatischer Export: Zeitplan und Speicherziele. */
export function EmergencyAutoCard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['emergency-auto'], queryFn: () => get<AutoStatus>('/emergency/auto') });
  const [settings, setSettings] = useState<AutoSettings | null>(null);
  const [editing, setEditing] = useState<Target | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);
  useEffect(() => {
    if (status.data) setSettings(status.data.settings);
  }, [status.data]);
  const reload = () => Promise.all([qc.invalidateQueries({ queryKey: ['emergency-auto'] }), qc.invalidateQueries({ queryKey: ['emergency-status'] })]);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    setSaved(false);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const runNow = (targetId?: string) =>
    act(targetId ?? 'run', async () => {
      setResults((await post<{ results: RunResult[] }>('/emergency/auto/run', targetId ? { targetId } : {})).results);
      await reload();
    });

  if (status.isLoading || !settings) return <Spinner />;
  const d = status.data!;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <CloudUpload className="h-4 w-4 text-brand-500" /> {t('emergencyAuto.title')} <HelpLink article="emergency-auto" />
        </span>
      }
      actions={settings.enabled && d.targets.some((x) => x.enabled) ? <Badge color="green">{t('emergencyAuto.active')}</Badge> : <Badge color="gray">{t('emergencyAuto.inactive')}</Badge>}
    >
      <div className="space-y-6 text-sm text-slate-700">
        <p>{t('emergencyAuto.text')}</p>
        <ErrorAlert error={error ?? status.error} />

        {/* Zeitplan */}
        <div className="space-y-4 rounded-lg border border-slate-200 p-4">
          <Checkbox label={t('emergencyAuto.enabled')} checked={settings.enabled} onChange={(v) => setSettings({ ...settings, enabled: v })} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('emergencyAuto.debounce')} hint={t('emergencyAuto.debounceHint')}>
              <Input type="number" min={1} max={1440} value={settings.debounceMinutes} onChange={(e) => setSettings({ ...settings, debounceMinutes: Number(e.target.value) })} />
            </Field>
            <Field label={t('emergencyAuto.daily')} hint={t('emergencyAuto.dailyHint')}>
              <Input type="time" value={settings.dailyTime ?? ''} onChange={(e) => setSettings({ ...settings, dailyTime: e.target.value || null })} />
            </Field>
            <Field label={t('emergencyAuto.timezone')}>
              <Input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} />
            </Field>
          </div>
          <Checkbox label={t('emergencyAuto.alertMail')} hint={t('emergencyAuto.alertMailHint')} checked={settings.alertMail} onChange={(v) => setSettings({ ...settings, alertMail: v })} />
          {saved && <Alert kind="success">{t('common.saved')}</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              loading={busy === 'settings'}
              onClick={() =>
                act('settings', async () => {
                  await put('/emergency/auto/settings', settings);
                  await reload();
                  setSaved(true);
                })
              }
            >
              {t('common.save')}
            </Button>
            <span className="text-xs text-slate-500">
              {d.lastRunAt ? t('emergencyAuto.lastRun', { date: formatDate(d.lastRunAt, i18n.language) }) : t('emergencyAuto.neverRun')}
              {d.pendingChanges && ` · ${t('emergencyAuto.pending')}`}
            </span>
          </div>
        </div>

        {/* Ziele */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-slate-900">{t('emergencyAuto.targets')}</h3>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={<Play className="h-4 w-4" />} disabled={!d.targets.some((x) => x.enabled)} loading={busy === 'run'} onClick={() => void runNow()}>
                {t('emergencyAuto.runAll')}
              </Button>
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
                {t('emergencyAuto.addTarget')}
              </Button>
            </div>
          </div>
          {results && (
            <Alert kind={results.every((r) => r.ok) ? 'success' : 'warning'} title={t('emergencyAuto.runResult')}>
              <ul className="space-y-1">
                {results.map((r) => (
                  <li key={r.name}>
                    {r.ok ? '✓' : '✗'} {r.name}: {r.ok ? t('emergencyAuto.runOk', { deleted: r.deleted ?? 0 }) : r.error}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {!d.targets.length ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-slate-500">{t('emergencyAuto.noTargets')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {d.targets.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Server className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-900">
                      {x.name} <span className="font-normal text-slate-500">· {t(`emergencyAuto.preset.${presetOf(x.type, x.config)}`)}</span>
                    </p>
                    <p className="truncate text-xs text-slate-500">{describeTarget(presetOf(x.type, x.config), simpleOf(presetOf(x.type, x.config), x.config), d.folderBase)}</p>
                    {x.lastError ? (
                      <p className="text-xs text-red-600">
                        {t('emergencyAuto.lastError', { count: x.failures })}: {x.lastError}
                      </p>
                    ) : x.lastSuccessAt ? (
                      <p className="text-xs text-emerald-700">{t('emergencyAuto.lastSuccess', { date: formatDate(x.lastSuccessAt, i18n.language) })}</p>
                    ) : null}
                  </div>
                  {!x.enabled && <Badge color="gray">{t('emergencyAuto.disabled')}</Badge>}
                  {x.enabled && x.failures > 0 && <Badge color="red">{t('emergencyAuto.failing')}</Badge>}
                  <div className="flex gap-1">
                    <IconButton label={t('emergencyAuto.runOne')} onClick={() => void runNow(x.id)} disabled={busy === x.id}>
                      <Play className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={t('common.edit')} onClick={() => setEditing(x)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={t('common.delete')} onClick={() => setDeleting(x)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-500">{t('emergencyAuto.offlineHint')}</p>
        </div>
      </div>
      {editing && <TargetModal target={editing === 'new' ? null : editing} folderBase={d.folderBase} onClose={() => setEditing(null)} onSaved={reload} />}
      <ConfirmModal
        open={!!deleting}
        danger
        onClose={() => setDeleting(null)}
        title={t('emergencyAuto.deleteTitle')}
        loading={busy === 'delete'}
        onConfirm={() =>
          act('delete', async () => {
            await post(`/emergency/auto/targets/${deleting!.id}/delete`);
            setDeleting(null);
            await reload();
          })
        }
      >
        {t('emergencyAuto.deleteText', { name: deleting?.name })}
      </ConfirmModal>
    </Card>
  );
}
