import { ArrowLeft, Cloud, FolderOpen, Globe, HardDrive, Network, Terminal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Checkbox, cx, ErrorAlert, Field, Input, Modal, PasswordInput, Textarea } from '../../components/ui';
import { post, put } from '../../lib/api';
import type { Target } from './EmergencyAutoCard';
import { buildConfig, DEFAULTS, MAIN_PRESETS, OTHER_PRESETS, Preset, PRESET_TYPE, PresetError, presetOf, SECRET_FIELDS, Simple, simpleOf } from './targetPresets';

const ICONS: Record<Preset, typeof Cloud> = {
  smb: Network,
  nextcloud: Cloud,
  storagebox: HardDrive,
  sftp: Terminal,
  webdav: Globe,
  folder: FolderOpen,
};

interface TestResult {
  ok: boolean;
  error?: string;
  backups?: number;
  hostKey?: string | null;
}

/** Ziel anlegen oder bearbeiten: erst Vorlage wählen, dann nur die nötigen Angaben. Speichern testet automatisch. */
export function TargetModal({ target, folderBase, onClose, onSaved }: { target: Target | null; folderBase: string; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<Preset | null>(target ? presetOf(target.type, target.config) : null);
  const [simple, setSimple] = useState<Simple>(target && preset ? simpleOf(preset, target.config) : {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [name, setName] = useState(target?.name ?? '');
  const [keep, setKeep] = useState(target?.keep ?? 30);
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const [failed, setFailed] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Neue SFTP-Server-Kennung bewusst übernehmen (z. B. nach Neuinstallation des Servers)
  const [resetKey, setResetKey] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const choose = (p: Preset) => {
    setPreset(p);
    setSimple({ ...DEFAULTS[p] });
    setSecrets({});
    setName(t(`emergencyAuto.preset.${p}`));
    setFailed(null);
  };
  const set = (k: string, v: string | number | boolean) => {
    setSimple((s) => ({ ...s, [k]: v }));
    setFailed(null);
  };
  const stored = (k: string) => !!target && presetOf(target.type, target.config) === preset && !!target.secrets[k];

  /** Speichern: zuerst testen; bei Fehler Meldung zeigen und "Trotzdem speichern" anbieten. */
  const save = async (force = false, reset = resetKey) => {
    if (!preset) return;
    setBusy(true);
    setError(null);
    try {
      const sim = { ...simple };
      const config = buildConfig(preset, sim, reset ? undefined : target?.config);
      const body = { name: name.trim() || t(`emergencyAuto.preset.${preset}`), type: PRESET_TYPE[preset], enabled, keep, config, secrets: pickSecrets(preset, secrets) };
      if (!force) {
        const test = await post<TestResult>('/emergency/auto/test', { ...body, id: target?.id });
        if (!test.ok) {
          setFailed(test);
          return;
        }
        if (test.hostKey) body.config = { ...config, hostKey: test.hostKey };
      }
      if (target) await put(`/emergency/auto/targets/${target.id}`, body);
      else await post('/emergency/auto/targets', body);
      await onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof PresetError ? new Error(`PRESET_${e.message}`) : e);
    } finally {
      setBusy(false);
    }
  };

  // ---------- Schritt 1: Vorlage wählen ----------
  if (!preset) {
    return (
      <Modal open size="lg" onClose={onClose} title={t('emergencyAuto.chooseTitle')}>
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {MAIN_PRESETS.map((p) => (
              <Tile key={p} preset={p} onClick={() => choose(p)} />
            ))}
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('emergencyAuto.otherTargets')}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {OTHER_PRESETS.map((p) => (
                <Tile key={p} preset={p} small onClick={() => choose(p)} />
              ))}
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // ---------- Schritt 2: Angaben ----------
  const txt = (k: string, label: string, opts: { hint?: string; placeholder?: string; type?: string } = {}) => (
    <Field label={label} hint={opts.hint}>
      <Input type={opts.type ?? 'text'} value={String(simple[k] ?? '')} onChange={(e) => set(k, opts.type === 'number' ? Number(e.target.value) : e.target.value)} placeholder={opts.placeholder} autoComplete="off" spellCheck={false} />
    </Field>
  );
  const secret = (k: string, label: string, opts: { hint?: string; multiline?: boolean } = {}) => (
    <Field label={label} hint={stored(k) ? t('emergencyAuto.secretStored') : opts.hint}>
      {opts.multiline ? (
        <Textarea rows={4} className="font-mono text-xs" value={secrets[k] ?? ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} placeholder={stored(k) ? '••••••••' : ''} spellCheck={false} />
      ) : (
        <PasswordInput value={secrets[k] ?? ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} placeholder={stored(k) ? '••••••••' : ''} autoComplete="new-password" />
      )}
    </Field>
  );
  const Icon = ICONS[preset];

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-brand-500" /> {t(`emergencyAuto.preset.${preset}`)}
        </span>
      }
      footer={
        <>
          {!target && (
            <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setPreset(null)} className="mr-auto">
              {t('common.back')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {busy ? t('emergencyAuto.checking') : t('emergencyAuto.saveAndTest')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t(`emergencyAuto.intro.${preset}`)}</p>
        <ErrorAlert error={error} />

        {preset === 'smb' && (
          <>
            {txt('location', t('emergencyAuto.f.location'), { hint: t('emergencyAuto.f.locationHint'), placeholder: '\\\\NAS\\Backup\\Bastion' })}
            <div className="grid gap-4 sm:grid-cols-2">
              {txt('username', t('emergencyAuto.f.username'))}
              {secret('password', t('emergencyAuto.f.password'))}
            </div>
          </>
        )}
        {preset === 'nextcloud' && (
          <>
            {txt('server', t('emergencyAuto.f.ncServer'), { placeholder: 'cloud.firma.de' })}
            <div className="grid gap-4 sm:grid-cols-2">
              {txt('username', t('emergencyAuto.f.username'))}
              {secret('password', t('emergencyAuto.f.appPassword'), { hint: t('emergencyAuto.f.appPasswordHint') })}
            </div>
            {txt('folder', t('emergencyAuto.f.folder'), { hint: t('emergencyAuto.f.ncFolderHint') })}
          </>
        )}
        {preset === 'storagebox' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {txt('username', t('emergencyAuto.f.sbUser'), { placeholder: 'u123456', hint: t('emergencyAuto.f.sbUserHint') })}
              {secret('password', t('emergencyAuto.f.password'))}
            </div>
            {txt('folder', t('emergencyAuto.f.folder'), { hint: t('emergencyAuto.f.folderCreated') })}
          </>
        )}
        {preset === 'sftp' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {txt('host', t('emergencyAuto.f.server'), { placeholder: 'backup.firma.de' })}
              {txt('username', t('emergencyAuto.f.username'))}
            </div>
            {secret('password', t('emergencyAuto.f.password'))}
            {txt('folder', t('emergencyAuto.f.folder'), { hint: t('emergencyAuto.f.folderCreated') })}
          </>
        )}
        {preset === 'webdav' && (
          <>
            {txt('url', t('emergencyAuto.f.webdavUrl'), { placeholder: 'https://server/webdav/bastion/' })}
            <div className="grid gap-4 sm:grid-cols-2">
              {txt('username', t('emergencyAuto.f.username'))}
              {secret('password', t('emergencyAuto.f.password'))}
            </div>
          </>
        )}
        {preset === 'folder' && (
          <>
            {txt('folder', t('emergencyAuto.f.subfolder'), { hint: t('emergencyAuto.f.subfolderHint', { base: folderBase }) })}
            <Alert kind="info">{t('emergencyAuto.f.folderInfo', { base: folderBase })}</Alert>
          </>
        )}

        {failed && (
          <Alert kind="error" title={t('emergencyAuto.testFailed')}>
            <p>{failed.error}</p>
            {PRESET_TYPE[preset] === 'SFTP' && failed.hostKey && (
              <>
                <p className="mt-2">{t('emergencyAuto.hostKeyChanged')}</p>
                <Button
                  size="sm"
                  variant="danger"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => {
                    setResetKey(true);
                    void save(false, true);
                  }}
                >
                  {t('emergencyAuto.acceptNewKey')}
                </Button>
              </>
            )}
            {!(PRESET_TYPE[preset] === 'SFTP' && failed.hostKey) && (
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => void save(true)} disabled={busy || (PRESET_TYPE[preset] === 'SFTP' && !target?.config.hostKey)}>
                {t('emergencyAuto.saveAnyway')}
              </Button>
            )}
          </Alert>
        )}

        <details className="rounded-lg border border-slate-200 px-4 py-2 text-sm">
          <summary className="cursor-pointer select-none py-1 font-medium text-slate-700">{t('emergencyAuto.advanced')}</summary>
          <div className="space-y-4 py-3">
            <Field label={t('common.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <Field label={t('emergencyAuto.keep')} hint={t('emergencyAuto.keepHint')}>
              <Input type="number" min={0} value={keep} onChange={(e) => setKeep(Number(e.target.value))} className="max-w-32" />
            </Field>
            {preset === 'smb' && txt('domain', t('emergencyAuto.f.domain'), { hint: t('emergencyAuto.f.domainHint') })}
            {(preset === 'storagebox' || preset === 'sftp') && (
              <>
                {preset === 'sftp' && txt('port', t('emergencyAuto.port'), { type: 'number' })}
                {preset === 'sftp' && secret('privateKey', t('emergencyAuto.privateKey'), { multiline: true })}
                {preset === 'sftp' && secret('passphrase', t('emergencyAuto.keyPassphrase'))}
                <p className="text-xs text-slate-500">
                  {t('emergencyAuto.f.hostKeyInfo')}
                  {target?.config.hostKey ? <span className="mt-1 block break-all font-mono">{String(target.config.hostKey)}</span> : null}
                </p>
              </>
            )}
            <Checkbox label={t('emergencyAuto.targetEnabled')} checked={enabled} onChange={setEnabled} />
          </div>
        </details>
      </div>
    </Modal>
  );
}

/** Nur die zur Vorlage gehörenden, tatsächlich eingegebenen Geheimnisse übertragen */
function pickSecrets(preset: Preset, secrets: Record<string, string>) {
  return Object.fromEntries(SECRET_FIELDS[preset].filter((k) => secrets[k]).map((k) => [k, secrets[k]]));
}

function Tile({ preset, onClick, small }: { preset: Preset; onClick: () => void; small?: boolean }) {
  const { t } = useTranslation();
  const Icon = ICONS[preset];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex items-start gap-3 rounded-lg border border-slate-200 bg-white text-left transition-colors hover:border-brand-400 hover:bg-slate-50',
        small ? 'px-3 py-2' : 'p-4',
      )}
    >
      <Icon className={cx('shrink-0 text-brand-500', small ? 'mt-0.5 h-4 w-4' : 'h-6 w-6')} />
      <span>
        <span className={cx('block font-semibold text-slate-900', small && 'text-sm')}>{t(`emergencyAuto.preset.${preset}`)}</span>
        {!small && <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">{t(`emergencyAuto.presetHint.${preset}`)}</span>}
      </span>
    </button>
  );
}
