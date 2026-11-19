import { Moon, Sparkles, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setTheme, useTheme } from '../lib/theme';
import { cx } from './ui';

/**
 * Tag-/Nacht-Schalter als Pille: tagsüber Gold-Rosé-Verlauf mit Sonne rechts,
 * nachts Violett-Indigo-Verlauf mit Mond links. Der Knopf gleitet beim Umschalten.
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const dark = useTheme() === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={t('theme.nightMode')}
      title={dark ? t('theme.switchToDay') : t('theme.switchToNight')}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="relative h-8 w-[88px] shrink-0 overflow-hidden rounded-full shadow-md ring-1 ring-[#e58fb4]/70 transition-shadow hover:shadow-lg"
    >
      <span aria-hidden className={cx('absolute inset-0 bg-gradient-to-r from-[#f4b731] to-[#e47aa0] transition-opacity duration-300', dark ? 'opacity-0' : 'opacity-100')} />
      <span aria-hidden className={cx('absolute inset-0 bg-gradient-to-r from-[#b552c5] to-[#2e1a8c] transition-opacity duration-300', dark ? 'opacity-100' : 'opacity-0')} />
      <span
        aria-hidden
        className={cx(
          'absolute inset-y-0 flex items-center text-[11px] font-extrabold uppercase tracking-wide text-white transition-all duration-300',
          dark ? 'right-2.5' : 'left-3',
        )}
      >
        {dark ? t('theme.night') : t('theme.day')}
      </span>
      <span
        aria-hidden
        className={cx(
          'absolute left-0 top-[3px] flex h-[26px] w-[26px] items-center justify-center rounded-full bg-[#fbfbfd] shadow-[0_2px_6px_rgba(0,0,0,0.25)] transition-transform duration-300 ease-out',
          dark ? 'translate-x-[3px]' : 'translate-x-[59px]',
        )}
      >
        {dark ? (
          <span className="relative">
            <Moon className="h-4 w-4 text-[#2b1d7a]" strokeWidth={2.25} />
            <Sparkles className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 text-[#2b1d7a]" strokeWidth={2.5} />
          </span>
        ) : (
          <Sun className="h-4 w-4 text-[#e0a526]" strokeWidth={2.25} />
        )}
      </span>
    </button>
  );
}
