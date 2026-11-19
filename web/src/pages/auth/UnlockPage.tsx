import { Lock } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ErrorAlert, Field, PasswordInput } from '../../components/ui';
import { unlock } from '../../lib/crypto/account';
import { useSession } from '../../state/session';
import { AuthLayout } from './AuthLayout';

export function UnlockPage() {
  const { t } = useTranslation();
  const { info, setKeys, logout, refresh } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = (await refresh()) ?? info;
      const keys = await unlock(password, fresh.keys);
      setPassword('');
      setKeys(keys);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('unlock.title')} subtitle={t('unlock.subtitle', { email: info?.user.email })}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorAlert error={error} />
        <Field label={t('common.masterPassword')}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
        </Field>
        <Button type="submit" className="w-full" loading={busy} icon={<Lock className="h-4 w-4" />}>
          {t('unlock.submit')}
        </Button>
        <button type="button" onClick={() => void logout()} className="w-full text-center text-sm text-slate-500 hover:text-slate-800">
          {t('nav.logout')}
        </button>
      </form>
    </AuthLayout>
  );
}
