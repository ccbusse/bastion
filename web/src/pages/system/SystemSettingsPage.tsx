import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, DatabaseBackup } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, Checkbox, cx, ErrorAlert, Field, formatDate, HelpLink, Input, PageHeader } from '../../components/ui';
import { get, put } from '../../lib/api';
import { useSession } from '../../state/session';
import { ReportPage } from '../tools/ReportPage';
import { TransferPage } from '../tools/TransferPage';
import { SmtpPage } from './SmtpPage';

interface Settings {
  requireMfaForSystemAdmins: boolean;
  autoLockMinutes: number;
  extensionAutoLockMinutes: number;
}

const TABS = ['general', 'smtp', 'transfer', 'report'] as const;
type Tab = (typeof TABS)[number];

/** Systemeinstellungen mit Bereichen; der aktive Bereich steht in der URL (?tab=…). */
export function SystemSettingsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((x) => x === params.get('tab')) ?? 'general';
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader title={t('systemSettings.title')} description={t('systemSettings.description')} help="system-setup" />
      {/* Grundlinie als Inset-Schatten, damit der Unterstrich des aktiven Reiters nicht über den Rand ragt (sonst erscheint eine Scrollleiste) */}
      <div className="scrollbar-none flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-slate-200)]" role="tablist">
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            onClick={() => setParams(x === 'general' ? {} : { tab: x }, { replace: true })}
            className={cx(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === x ? 'border-brand-900 text-brand-900' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
            )}
          >
            {t(`systemSettings.tabs.${x}`)}
          </button>
        ))}
      </div>
      {tab === 'general' && (
        <div className="space-y-6">
          <GeneralSettings />
          <DbBackupCard />
          <VersionCard />
        </div>
      )}
      {tab === 'smtp' && <SmtpPage embedded />}
      {tab === 'transfer' && <TransferPage embedded />}
      {tab === 'report' && <ReportPage embedded />}
    </div>
  );
}

interface DbBackupStatus {
  state: 'ok' | 'stale' | 'failing' | 'notConfigured' | 'unknown';
  report: {
    configured?: boolean | null;
    schedule?: string | null;
    timezone?: string | null;
    keep?: number | null;
    count?: number | null;
    lastAttemptAt?: string | null;
    lastSuccessAt?: string | null;
    lastFile?: string | null;
    lastSizeKiB?: number | null;
    lastError?: string | null;
  } | null;
}

const dbBackupBadge = { ok: 'green', stale: 'yellow', failing: 'red', notConfigured: 'red', unknown: 'gray' } as const;

/** Stand des Datenbank-Backups, wie ihn der Dienst "backup" meldet (Bastion selbst sieht die Backup-Dateien nicht). */
function DbBackupCard() {
  const { t, i18n } = useTranslation();
  const status = useQuery({ queryKey: ['db-backup'], queryFn: () => get<DbBackupStatus>('/system/db-backup') });
  const d = status.data;
  const r = d?.report;
  const rows: [string, string][] = r
    ? [
        [t('dbBackup.lastSuccess'), r.lastSuccessAt ? formatDate(r.lastSuccessAt, i18n.language) : t('dbBackup.never')],
        ...(r.lastAttemptAt && r.lastAttemptAt !== r.lastSuccessAt ? [[t('dbBackup.lastAttempt'), formatDate(r.lastAttemptAt, i18n.language)] as [string, string]] : []),
        ...(r.schedule ? [[t('dbBackup.schedule'), t('dbBackup.scheduleValue', { time: r.schedule, tz: r.timezone ?? '' })] as [string, string]] : []),
        ...(r.count != null && r.keep != null ? [[t('dbBackup.kept'), t('dbBackup.keptValue', { count: r.count, keep: r.keep })] as [string, string]] : []),
        ...(r.lastFile ? [[t('dbBackup.file'), `${r.lastFile}${r.lastSizeKiB != null ? ` (${r.lastSizeKiB} KiB)` : ''}`] as [string, string]] : []),
      ]
    : [];
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <DatabaseBackup className="h-4 w-4 text-brand-500" />
          {t('dbBackup.title')}
          <HelpLink article="db-backup" />
        </span>
      }
      actions={d && <Badge color={dbBackupBadge[d.state]}>{t(`dbBackup.state.${d.state}`)}</Badge>}
    >
      <p className="mb-4 text-sm text-slate-600">{t('dbBackup.text')}</p>
      {status.error && <ErrorAlert error={status.error} />}
      {d && (
        <>
          <Alert kind={d.state === 'ok' ? 'success' : d.state === 'unknown' ? 'info' : d.state === 'stale' ? 'warning' : 'error'} className="mb-4">
            {t(`dbBackup.stateText.${d.state}`, { error: r?.lastError ?? '' })}
          </Alert>
          {rows.length > 0 && (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="break-all text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      <Link to="/help/db-backup" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
        <BookOpen className="h-4 w-4" />
        {t('dbBackup.howTo')}
      </Link>
    </Card>
  );
}

/** Version, Build-Datum und Git-Stand der laufenden Installation. */
function VersionCard() {
  const { t, i18n } = useTranslation();
  const { info } = useSession();
  const build = info?.build;
  const rows: [string, string][] = [
    [t('systemSettings.version'), `v${__APP_VERSION__}`],
    [t('systemSettings.serverVersion'), build ? `v${build.version}` : '–'],
    [t('systemSettings.builtAt'), build?.builtAt ? formatDate(build.builtAt, i18n.language) : '–'],
    [t('systemSettings.commit'), build?.commit || '–'],
  ];
  return (
    <Card title={t('systemSettings.versionTitle')}>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-mono text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
      {build && build.version !== __APP_VERSION__ && <Alert kind="warning" className="mt-4">{t('systemSettings.versionMismatch')}</Alert>}
    </Card>
  );
}

function GeneralSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const settings = useQuery({ queryKey: ['system-settings'], queryFn: () => get<Settings>('/system/settings') });
  const [form, setForm] = useState<Settings>({ requireMfaForSystemAdmins: false, autoLockMinutes: 15, extensionAutoLockMinutes: 60 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  return (
    <Card>
      <div className="max-w-md space-y-5">
        <ErrorAlert error={error} />
        {saved && <Alert kind="success">{t('common.saved')}</Alert>}
        <Checkbox
          label={t('systemSettings.requireMfa')}
          hint={t('systemSettings.requireMfaHint')}
          checked={form.requireMfaForSystemAdmins}
          onChange={(v) => setForm((f) => ({ ...f, requireMfaForSystemAdmins: v }))}
        />
        <Field label={t('systemSettings.autoLock')} hint={t('systemSettings.autoLockHint')}>
          <Input type="number" min={1} max={240} value={form.autoLockMinutes} onChange={(e) => setForm((f) => ({ ...f, autoLockMinutes: Number(e.target.value) }))} className="max-w-32" />
        </Field>
        <Field label={t('systemSettings.extensionAutoLock')} hint={t('systemSettings.extensionAutoLockHint')}>
          <Input
            type="number"
            min={1}
            max={480}
            value={form.extensionAutoLockMinutes}
            onChange={(e) => setForm((f) => ({ ...f, extensionAutoLockMinutes: Number(e.target.value) }))}
            className="max-w-32"
          />
        </Field>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setSaved(false);
            try {
              await put('/system/settings', form);
              await qc.invalidateQueries({ queryKey: ['system-settings'] });
              await qc.invalidateQueries({ queryKey: ['onboarding-checklist'] });
              await refresh();
              setSaved(true);
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
}
