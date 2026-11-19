import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone, Puzzle, ShieldCheck, ShieldOff } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MasterPasswordFields } from '../../components/MasterPasswordFields';
import { MfaSetup, RecoveryCodes } from '../../components/MfaSetup';
import { Alert, Badge, Button, Card, ErrorAlert, Field, formatDate, Modal, PageHeader, PasswordInput } from '../../components/ui';
import { del, get, post } from '../../lib/api';
import { rewrapForPassword } from '../../lib/crypto/account';
import { deriveLoginKeys, fingerprint } from '../../lib/crypto/primitives';
import { useUnlocked } from '../../state/session';
import { useOwnTenantFingerprint } from '../../components/TrustAnchor';

function ChangePasswordCard() {
  const { t } = useTranslation();
  const { info, keys, refresh } = useUnlocked();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [formKey, setFormKey] = useState(0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!next) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const { authHash: currentAuthHash } = await deriveLoginKeys(current, info.keys);
      await post('/auth/change-password', { currentAuthHash, ...(await rewrapForPassword(next, keys.accountKeyRaw, keys.personalKeyRaw)) });
      await refresh();
      setCurrent('');
      setFormKey((k) => k + 1);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('account.changePassword')}>
      <form onSubmit={submit} className="max-w-md space-y-4">
        <ErrorAlert error={error} />
        {done && <Alert kind="success">{t('account.passwordChanged')}</Alert>}
        <Field label={t('account.currentPassword')}>
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <MasterPasswordFields key={formKey} userInputs={[info.user.email, info.user.name]} onChange={setNext} />
        <Button type="submit" disabled={!next || !current} loading={busy}>
          {t('account.changePassword')}
        </Button>
      </form>
    </Card>
  );
}

export function ReauthModal({
  title,
  onClose,
  onConfirm,
  danger,
  children,
}: {
  title: string;
  onClose: () => void;
  onConfirm: (authHash: string) => Promise<void>;
  danger?: boolean;
  /** Zusätzlicher Inhalt oberhalb der Passwortabfrage */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { info } = useUnlocked();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm((await deriveLoginKeys(pw, info.keys)).authHash);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        <ErrorAlert error={error} />
        <Field label={t('account.confirmWithPassword')}>
          <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

function MfaCard() {
  const { t } = useTranslation();
  const { info, refresh } = useUnlocked();
  const [setupOpen, setSetupOpen] = useState(false);
  const [action, setAction] = useState<'disable' | 'codes' | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  return (
    <Card
      title={t('account.mfa')}
      actions={info.user.totpEnabled ? <Badge color="green">{t('account.mfaActive')}</Badge> : <Badge color="yellow">{t('account.mfaInactive')}</Badge>}
    >
      {info.user.totpEnabled ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <ShieldCheck className="h-5 w-5 text-emerald-600" /> {t('account.mfaEnabledText', { count: info.user.recoveryCodesLeft })}
          </div>
          {codes && <RecoveryCodes codes={codes} />}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAction('codes')}>
              {t('account.newRecoveryCodes')}
            </Button>
            {!info.tenant?.requireMfa && (
              <Button variant="secondary" size="sm" onClick={() => setAction('disable')}>
                {t('account.disableMfa')}
              </Button>
            )}
          </div>
        </div>
      ) : setupOpen ? (
        <MfaSetup
          onDone={() => {
            setSetupOpen(false);
            void refresh();
          }}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <ShieldOff className="h-5 w-5 text-amber-600" /> {t('account.mfaRecommended')}
          </div>
          <Button size="sm" onClick={() => setSetupOpen(true)}>
            {t('mfa.start')}
          </Button>
        </div>
      )}
      {action && (
        <ReauthModal
          title={action === 'disable' ? t('account.disableMfa') : t('account.newRecoveryCodes')}
          danger={action === 'disable'}
          onClose={() => setAction(null)}
          onConfirm={async (authHash) => {
            if (action === 'disable') await post('/mfa/totp/disable', { authHash });
            else setCodes((await post<{ recoveryCodes: string[] }>('/mfa/recovery-codes', { authHash })).recoveryCodes);
            setAction(null);
            await refresh();
          }}
        />
      )}
    </Card>
  );
}

function SessionsCard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => get<{ id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; client: 'WEB' | 'EXTENSION'; label: string | null; current: boolean }[]>('/auth/sessions'),
  });
  return (
    <Card title={t('account.sessions')}>
      <ul className="divide-y divide-slate-100">
        {sessions.data?.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
            {s.client === 'EXTENSION' ? <Puzzle className="h-4 w-4 shrink-0 text-gold-500" /> : <MonitorSmartphone className="h-4 w-4 shrink-0 text-slate-400" />}
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-slate-800">
                {s.client === 'EXTENSION' && <Badge color="gold">{t('account.extensionSession')}</Badge>}
                <span className="truncate">{s.client === 'EXTENSION' ? (s.label ?? s.userAgent ?? '–') : (s.userAgent ?? '–')}</span>
              </p>
              <p className="text-xs text-slate-500">
                {s.ip ?? '–'} · {t('account.lastSeen')}: {formatDate(s.lastSeenAt, i18n.language)}
              </p>
            </div>
            {s.current ? (
              <Badge color="green">{t('account.currentSession')}</Badge>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await del(`/auth/sessions/${s.id}`);
                  await qc.invalidateQueries({ queryKey: ['sessions'] });
                }}
              >
                {t('account.revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const { info } = useUnlocked();
  const fp = useQuery({ queryKey: ['own-fingerprint', info.keys.publicKey], queryFn: () => fingerprint(info.keys.publicKey) });
  const tenantFp = useOwnTenantFingerprint();
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader title={t('account.title')} help="account-security" />
      {info.emergency?.personalIncluded && <Alert kind="info" title={t('account.emergencyTitle')}>{t('account.emergencyText')}</Alert>}
      <Card title={t('account.profile')}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-slate-400">{t('common.name')}</dt>
            <dd className="text-slate-900">{info.user.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">{t('common.email')}</dt>
            <dd className="text-slate-900">{info.user.email}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">{t('account.organization')}</dt>
            <dd className="text-slate-900">{info.tenant?.name ?? t('account.systemAccount')}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-slate-400">{t('account.passwordChangedAt')}</dt>
            <dd className="text-slate-900">{formatDate(info.user.passwordChangedAt, i18n.language)}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase text-slate-400">{t('account.fingerprint')}</dt>
            <dd className="font-mono text-slate-900">{fp.data ?? '…'}</dd>
            <p className="mt-1 text-xs text-slate-500">{t('account.fingerprintHint')}</p>
          </div>
          {info.tenant && (
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase text-slate-400">{t('account.tenantFingerprint')}</dt>
              <dd className="font-mono text-slate-900">{tenantFp.data ?? t('account.tenantFingerprintMissing')}</dd>
              <p className="mt-1 text-xs text-slate-500">{t('account.tenantFingerprintHint')}</p>
            </div>
          )}
        </dl>
      </Card>
      <ChangePasswordCard />
      <MfaCard />
      <SessionsCard />
    </div>
  );
}
