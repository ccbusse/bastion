import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { breachCount, evaluatePassword, MIN_LENGTH, PolicyResult } from '../lib/password-policy';
import { cx, Field, PasswordInput } from './ui';

const SCORE_COLORS = ['bg-red-500', 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'];

/**
 * Eingabe eines neuen Masterpassworts inkl. BSI-orientierter Richtlinienprüfung und HIBP-Abgleich.
 * Meldet das Passwort über onChange, sobald alle Anforderungen erfüllt sind (sonst null).
 */
export function MasterPasswordFields({
  userInputs = [],
  onChange,
  label,
  autoFocus,
}: {
  userInputs?: string[];
  onChange: (password: string | null) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<PolicyResult | null>(null);
  const [breach, setBreach] = useState<'idle' | 'checking' | number | null>('idle');
  const inputsKey = userInputs.join('|');

  useEffect(() => {
    let cancelled = false;
    const h = setTimeout(async () => {
      const r = await evaluatePassword(pw, userInputs);
      if (!cancelled) setResult(r);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pw, inputsKey]);

  useEffect(() => {
    setBreach('idle');
    if (!result?.valid) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      setBreach('checking');
      const n = await breachCount(pw);
      if (!cancelled) setBreach(n);
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [result, pw]);

  const breachOk = breach === 0 || breach === null;
  const valid = !!result?.valid && pw === confirm && breachOk;
  useEffect(() => {
    onChange(valid ? pw : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, pw]);

  const checks: [boolean, string][] = result
    ? [
        [result.checks.length, t('policy.length', { n: MIN_LENGTH })],
        [result.checks.variety, t('policy.variety')],
        [result.checks.strength, t('policy.strength')],
        [result.checks.personal, t('policy.personal')],
      ]
    : [];

  return (
    <div className="space-y-4">
      <Field label={label ?? t('policy.newPassword')}>
        <PasswordInput value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus={autoFocus} />
      </Field>
      {pw && result && (
        <div className="space-y-2 rounded-md bg-slate-50 p-3">
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={cx('h-1.5 flex-1 rounded-full', i < result.score ? SCORE_COLORS[result.score] : 'bg-slate-200')} />
            ))}
          </div>
          <ul className="space-y-1 text-xs">
            {checks.map(([ok, text]) => (
              <li key={text} className={cx('flex items-center gap-1.5', ok ? 'text-emerald-700' : 'text-slate-500')}>
                {ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                {text}
              </li>
            ))}
            {result.valid && (
              <li className={cx('flex items-center gap-1.5', breach === 0 ? 'text-emerald-700' : typeof breach === 'number' ? 'text-red-600' : 'text-slate-500')}>
                {breach === 'checking' || breach === 'idle' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : breach === 0 ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                {breach === null ? t('policy.breachUnavailable') : typeof breach === 'number' && breach > 0 ? t('policy.breached', { count: breach }) : t('policy.notBreached')}
              </li>
            )}
          </ul>
        </div>
      )}
      <Field label={t('policy.confirmPassword')} error={confirm && confirm !== pw ? t('policy.mismatch') : undefined}>
        <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
    </div>
  );
}
