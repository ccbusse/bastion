import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { MasterPasswordFields } from '../../components/MasterPasswordFields';
import { Alert, Button, ErrorAlert, Field, Input, PasswordInput } from '../../components/ui';
import { post } from '../../lib/api';
import { createAccount } from '../../lib/crypto/account';
import { useSession } from '../../state/session';
import { AuthLayout } from './AuthLayout';

/** Ersteinrichtung: Anmeldung mit Initialpasswort (Container-Log), danach Pflicht zum eigenen Masterpasswort. */
export function SetupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refresh, setKeys } = useSession();
  const [step, setStep] = useState<'initial' | 'account'>('initial');
  const [initialPassword, setInitialPassword] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [master, setMaster] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submitInitial = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/setup/login', { username: 'admin', password: initialPassword.trim() });
      setInitialPassword('');
      setStep('account');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitAccount = async (e: FormEvent) => {
    e.preventDefault();
    if (!master) return;
    setBusy(true);
    setError(null);
    try {
      const { bundle, keys } = await createAccount(master);
      const { recoveryAccountKey, ...rest } = bundle;
      void recoveryAccountKey;
      await post('/auth/setup/complete', { ...rest, email: email.trim().toLowerCase(), name: name.trim() });
      setKeys(keys);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'initial') {
    return (
      <AuthLayout title={t('setup.title')} subtitle={t('setup.subtitle')}>
        <form onSubmit={submitInitial} className="space-y-4">
          <Alert kind="info">{t('setup.logHint')}</Alert>
          <ErrorAlert error={error} />
          <Field label={t('setup.username')}>
            <Input value="admin" disabled />
          </Field>
          <Field label={t('setup.initialPassword')}>
            <PasswordInput value={initialPassword} onChange={(e) => setInitialPassword(e.target.value)} autoComplete="off" required autoFocus />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            {t('common.continue')}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('setup.accountTitle')} subtitle={t('setup.accountSubtitle')} wide>
      <form onSubmit={submitAccount} className="space-y-4">
        <Alert kind="warning">{t('setup.mustChange')}</Alert>
        <ErrorAlert error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </Field>
          <Field label={t('common.email')}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </Field>
        </div>
        <MasterPasswordFields userInputs={[email, name, 'bastion', 'admin']} onChange={setMaster} label={t('common.masterPassword')} />
        <Alert kind="info">{t('setup.noRecoveryHint')}</Alert>
        <Button type="submit" className="w-full" disabled={!master || !email || !name} loading={busy}>
          {busy ? t('setup.creatingKeys') : t('setup.complete')}
        </Button>
      </form>
    </AuthLayout>
  );
}
