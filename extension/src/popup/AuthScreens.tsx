import { KeyRound, Link2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { getSettings } from '../lib/storage';
import { connectVault, login, logout, unlock, verifyMfa } from '../lib/vault';
import { errorText, t } from './i18n';
import { Button, ErrorBox, Field, Hero, Input, PasswordInput } from './ui';

function Shell({ title, text, children, footer }: { title: string; text?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-[540px] flex-col">
      <Hero>
        <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
        {text && <p className="mt-1 text-[13px] leading-relaxed text-brand-200">{text}</p>}
      </Hero>
      <div className="flex-1 px-5 py-5">{children}</div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-5 py-3 text-[11px] text-slate-400 dark:border-white/10">
        <span className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
          {t.zeroKnowledge}
        </span>
        {footer}
      </div>
    </div>
  );
}

function VaultHost() {
  const [host, setHost] = useState('');
  useEffect(() => {
    void getSettings().then((s) => setHost(s.vaultUrl ? new URL(s.vaultUrl).host : ''));
  }, []);
  return host ? <span className="truncate font-mono">{host}</span> : null;
}

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void getSettings().then((s) => s.vaultUrl && setUrl(s.vaultUrl));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await connectVault(url);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={t.connectTitle} text={t.connectText} footer={<span>v{__APP_VERSION__}</span>}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <Field label={t.vaultUrl}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://vault.firma.de" autoFocus required inputMode="url" spellCheck={false} />
        </Field>
        <Button type="submit" className="w-full" loading={busy} icon={<Link2 className="h-4 w-4" />}>
          {t.connect}
        </Button>
        <p className="text-xs text-slate-500">{t.connectHint}</p>
      </form>
    </Shell>
  );
}

export function LoginScreen({ onDone, onChangeVault }: { onDone: () => void; onChangeVault: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [encKey, setEncKey] = useState<CryptoKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void getSettings().then((s) => s.email && setEmail(s.email));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await login(email, password);
      setPassword('');
      if (res.mfaRequired) setEncKey(res.encKey);
      else onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!encKey) return;
    setBusy(true);
    setError('');
    try {
      await verifyMfa(code, encKey);
      setEncKey(null);
      onDone();
    } catch (err) {
      setError(errorText(err));
      // Abgelaufene MFA-Sitzung: zurück zur Anmeldung
      if (err instanceof Error && ['SESSION_EXPIRED', 'NOT_AUTHENTICATED'].includes(err.message)) setEncKey(null);
    } finally {
      setBusy(false);
    }
  };

  if (encKey) {
    return (
      <Shell title={t.mfaTitle} text={t.mfaText}>
        <form onSubmit={submitMfa} className="space-y-4">
          <ErrorBox>{error}</ErrorBox>
          <Field label={t.mfaCode}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus required className="font-mono tracking-widest" />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            {t.confirm}
          </Button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell
      title={t.loginTitle}
      footer={
        <button type="button" className="shrink-0 underline-offset-2 hover:text-slate-600 hover:underline dark:hover:text-slate-200" onClick={onChangeVault}>
          {t.changeVault}
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          {t.connectedTo} <VaultHost />
        </p>
        <Field label={t.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus={!email} />
        </Field>
        <Field label={t.masterPassword}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus={!!email} />
        </Field>
        <Button type="submit" className="w-full" loading={busy} icon={<KeyRound className="h-4 w-4" />}>
          {t.login}
        </Button>
      </form>
    </Shell>
  );
}

export function UnlockScreen({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void getSettings().then((s) => setEmail(s.email ?? ''));
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await unlock(password);
      setPassword('');
      onDone();
    } catch (err) {
      setError(errorText(err));
      if (err instanceof Error && ['SESSION_EXPIRED', 'NOT_AUTHENTICATED'].includes(err.message)) onLogout();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title={t.unlockTitle}
      text={t.unlockText}
      footer={
        <button
          type="button"
          className="shrink-0 underline-offset-2 hover:text-slate-600 hover:underline dark:hover:text-slate-200"
          onClick={async () => {
            await logout();
            onLogout();
          }}
        >
          {t.switchAccount}
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        {email && <p className="truncate text-sm font-semibold text-slate-700 dark:text-slate-200">{email}</p>}
        <Field label={t.masterPassword}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
        </Field>
        <Button type="submit" className="w-full" loading={busy} icon={<LockKeyhole className="h-4 w-4" />}>
          {t.unlock}
        </Button>
      </form>
    </Shell>
  );
}
