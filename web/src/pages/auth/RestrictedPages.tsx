import { useQuery } from '@tanstack/react-query';
import { Clock, RefreshCw } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MasterPasswordFields } from '../../components/MasterPasswordFields';
import { MfaSetup } from '../../components/MfaSetup';
import { Alert, Button, ErrorAlert, Field, PasswordInput } from '../../components/ui';
import { post } from '../../lib/api';
import { rewrapAfterRecovery } from '../../lib/crypto/account';
import { deriveLoginKeys, fingerprint, importAesKey } from '../../lib/crypto/primitives';
import { useUnlocked } from '../../state/session';
import { AuthLayout } from './AuthLayout';

export function PendingConfirmationPage() {
  const { t } = useTranslation();
  const { info, refresh, logout } = useUnlocked();
  const fp = useQuery({ queryKey: ['own-fingerprint', info.keys.publicKey], queryFn: () => fingerprint(info.keys.publicKey) });
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title={t('pending.title')} subtitle={t('pending.subtitle')}>
      <div className="space-y-4 text-sm text-slate-600">
        <div className="flex items-center gap-2 text-amber-700">
          <Clock className="h-5 w-5" /> {t('pending.waiting', { tenant: info.tenant?.name ?? 'Bastion' })}
        </div>
        <p>{t('pending.fingerprintHint')}</p>
        <p className="rounded-md bg-slate-100 p-3 text-center font-mono text-base tracking-wider text-slate-900">{fp.data ?? '…'}</p>
        <Button
          className="w-full"
          variant="secondary"
          loading={busy}
          icon={<RefreshCw className="h-4 w-4" />}
          onClick={async () => {
            setBusy(true);
            await refresh().finally(() => setBusy(false));
          }}
        >
          {t('pending.check')}
        </Button>
        <button type="button" onClick={() => void logout()} className="w-full text-center text-sm text-slate-500 hover:text-slate-800">
          {t('nav.logout')}
        </button>
      </div>
    </AuthLayout>
  );
}

export function ForcePasswordChangePage() {
  const { t } = useTranslation();
  const { info, keys, refresh, logout, setKeys } = useUnlocked();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      const { authHash: currentAuthHash } = await deriveLoginKeys(current, info.keys);
      // Nach einer Admin-Wiederherstellung kennt der Admin den bisherigen PersonalKey: durch einen neuen ersetzen
      const { payload, personalKeyRaw } = await rewrapAfterRecovery(next, keys.accountKeyRaw);
      await post('/auth/change-password', { currentAuthHash, ...payload });
      // Neue Schlüssel übernehmen (Kopie des AccountKeys, da setKeys die bisherigen Puffer überschreibt)
      setKeys({ ...keys, accountKeyRaw: keys.accountKeyRaw.slice(), personalKeyRaw, personalKey: await importAesKey(personalKeyRaw) });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('forcePassword.title')} subtitle={t('forcePassword.subtitle')} wide>
      <form onSubmit={submit} className="space-y-4">
        <Alert kind="warning">{t('forcePassword.hint')}</Alert>
        <ErrorAlert error={error} />
        <Field label={t('forcePassword.current')}>
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <MasterPasswordFields userInputs={[info.user.email, info.user.name]} onChange={setNext} />
        <Button type="submit" className="w-full" disabled={!next || !current} loading={busy}>
          {t('forcePassword.submit')}
        </Button>
        <button type="button" onClick={() => void logout()} className="w-full text-center text-sm text-slate-500 hover:text-slate-800">
          {t('nav.logout')}
        </button>
      </form>
    </AuthLayout>
  );
}

export function MfaRequiredPage() {
  const { t } = useTranslation();
  const { refresh, logout } = useUnlocked();
  return (
    <AuthLayout title={t('mfaRequired.title')} subtitle={t('mfaRequired.subtitle')} wide>
      <div className="space-y-4">
        <MfaSetup onDone={() => void refresh()} />
        <button type="button" onClick={() => void logout()} className="w-full text-center text-sm text-slate-500 hover:text-slate-800">
          {t('nav.logout')}
        </button>
      </div>
    </AuthLayout>
  );
}
