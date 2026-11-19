import { useTranslation } from 'react-i18next';
import { post } from '../lib/api';
import { cx } from './ui';

export function LanguageSwitch({ dark, persist }: { dark?: boolean; persist?: boolean }) {
  const { i18n } = useTranslation();
  const change = (lng: 'de' | 'en') => {
    void i18n.changeLanguage(lng);
    try {
      localStorage.setItem('bastion.lang', lng);
    } catch {
      /* Speicher nicht verfügbar */
    }
    if (persist) post('/auth/locale', { locale: lng }).catch(() => undefined);
  };
  return (
    <div className={cx('flex overflow-hidden rounded-md text-xs font-medium', dark ? 'bg-white/10' : 'bg-slate-100')}>
      {(['de', 'en'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => change(l)}
          className={cx(
            'px-2.5 py-1 uppercase',
            i18n.language === l ? (dark ? 'bg-white/20 text-white' : 'bg-white text-slate-900 shadow-sm') : dark ? 'text-brand-200 hover:text-white' : 'text-slate-500',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
