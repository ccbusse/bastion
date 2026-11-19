import { useQuery } from '@tanstack/react-query';
import { FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Button, ErrorAlert, Field, Input, PasswordInput } from '../../components/ui';
import { get, post } from '../../lib/api';
import { unlockWithEncKey } from '../../lib/crypto/account';
import { deriveLoginKeys, KdfParams } from '../../lib/crypto/primitives';
import { useSession } from '../../state/session';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh, setKeys } = useSession();
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const encKeyRef = useRef<CryptoKey | null>(null);
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => get<{ setupRequired: boolean }>('/auth/status') });

  const finish = async () => {
    const info = await refresh();
    if (!info || !encKeyRef.current) throw new Error('UNKNOWN');
    const keys = await unlockWithEncKey(encKeyRef.current, info.keys);
    encKeyRef.current = null;
    setKeys(keys);
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && from !== '/login' ? from : '/', { replace: true });
  };

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const normalized = email.trim().toLowerCase();
      const kdf = await post<KdfParams>('/auth/prelogin', { email: normalized });
      const { authHash, encKey } = await deriveLoginKeys(password, kdf);
      encKeyRef.current = encKey;
      const res = await post<{ mfaRequired: boolean }>('/auth/login', { email: normalized, authHash });
      setPassword('');
      if (res.mfaRequired) setStep('mfa');
      else await finish();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login/mfa', { code: code.trim() });
      await finish();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'mfa') {
    return (
      <AuthLayout title={t('login.mfaTitle')} subtitle={t('login.mfaSubtitle')}>
        <form onSubmit={submitMfa} className="space-y-4">
          <ErrorAlert error={error} />
          <Field label={t('login.mfaCode')} hint={t('login.mfaHint')}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text" autoFocus className="font-mono tracking-widest" />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            {t('login.verify')}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('login.title')} subtitle={t('login.subtitle')}>
      <form onSubmit={submitCredentials} className="space-y-4">
        {status.data?.setupRequired && (
          <Alert kind="warning" title={t('login.setupRequired')}>
            <Link to="/setup" className="font-medium underline">
              {t('login.goToSetup')}
            </Link>
          </Alert>
        )}
        <ErrorAlert error={error} />
        <Field label={t('common.email')}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </Field>
        <Field label={t('common.masterPassword')}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          {busy ? t('login.deriving') : t('login.submit')}
        </Button>
        <p className="text-xs text-slate-500">{t('login.zeroKnowledgeHint')}</p>
      </form>
    </AuthLayout>
  );
}
