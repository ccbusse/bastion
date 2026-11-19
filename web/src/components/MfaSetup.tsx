import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { post } from '../lib/api';
import { deriveLoginKeys } from '../lib/crypto/primitives';
import { useUnlocked } from '../state/session';
import { Alert, Button, Checkbox, CopyButton, ErrorAlert, Field, Input, PasswordInput } from './ui';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-3 font-mono text-sm text-slate-900">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="flex items-center gap-1 text-xs text-slate-500">
        <CopyButton value={codes.join('\n')} label={t('common.copy')} /> {t('mfa.copyCodes')}
      </div>
    </div>
  );
}

/** TOTP-Einrichtung: QR-Code scannen, Code bestätigen, Wiederherstellungscodes sichern. */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { info } = useUnlocked();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Einrichtung nur mit dem Masterpasswort (Schutz bei übernommener Sitzung)
      const { authHash } = await deriveLoginKeys(password, info.keys);
      setSetup(await post('/mfa/totp/setup', { authHash }));
      setPassword('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ recoveryCodes: string[] }>('/mfa/totp/enable', { code: code.trim() });
      setCodes(r.recoveryCodes);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div className="space-y-4">
        <Alert kind="success" title={t('mfa.enabled')}>
          {t('mfa.saveCodes')}
        </Alert>
        <RecoveryCodes codes={codes} />
        <Checkbox label={t('mfa.codesSaved')} checked={saved} onChange={setSaved} />
        <Button onClick={onDone} disabled={!saved}>
          {t('common.done')}
        </Button>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="space-y-3">
        <ErrorAlert error={error} />
        <p className="text-sm text-slate-600">{t('mfa.intro')}</p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <Field label={t('common.masterPassword')} hint={t('mfa.passwordHint')}>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Button type="submit" loading={busy} disabled={!password}>
            {t('mfa.start')}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorAlert error={error} />
      <p className="text-sm text-slate-600">{t('mfa.scan')}</p>
      <div className="flex flex-wrap items-center gap-5">
        <img src={setup.qrDataUrl} alt="QR" className="h-44 w-44 rounded-md border border-slate-200" />
        <div className="space-y-1 text-xs text-slate-500">
          <p>{t('mfa.manual')}</p>
          <p className="flex items-center gap-1 break-all font-mono text-sm text-slate-800">
            {setup.secret.match(/.{1,4}/g)?.join(' ')} <CopyButton value={setup.secret} />
          </p>
        </div>
      </div>
      <Field label={t('mfa.code')}>
        <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className="max-w-40 font-mono tracking-widest" />
      </Field>
      <Button onClick={enable} disabled={code.length !== 6} loading={busy}>
        {t('mfa.verify')}
      </Button>
    </div>
  );
}
