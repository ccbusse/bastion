import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '../../components/Logo';
import { LanguageSwitch } from '../../components/LanguageSwitch';
import { ThemeToggle } from '../../components/ThemeToggle';

/** Gleichbleibender Sternenhimmel (Positionen in Prozent, damit er sich jeder Breite anpasst). */
const STARS = (() => {
  let seed = 1118;
  const next = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return Array.from({ length: 90 }, () => ({
    left: `${(next() * 100).toFixed(2)}%`,
    top: `${(next() * 62).toFixed(2)}%`,
    size: next() > 0.85 ? 3 : 2,
    opacity: Number((0.25 + next() * 0.55).toFixed(2)),
    delay: `${(next() * 6).toFixed(1)}s`,
  }));
})();

/** Szene über die ganze Fläche: Nachthimmel, Morgenlicht und die Festung am Horizont. Rein dekorativ. */
function Scene() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-clip" aria-hidden="true">
      <div className="auth-sky absolute inset-0" />
      {STARS.map((s, i) => (
        <span
          key={i}
          className="auth-star absolute rounded-full bg-white"
          style={{ left: s.left, top: s.top, width: s.size, height: s.size, opacity: s.opacity, animationDelay: s.delay }}
        />
      ))}
      <div className="auth-dawn absolute bottom-[10vh] left-1/2 h-[560px] w-[1400px] max-w-[200vw] -translate-x-1/2 rounded-full" />
      <svg viewBox="0 0 1440 420" preserveAspectRatio="xMidYMax slice" className="absolute inset-x-0 bottom-0 h-[38vh] min-h-[220px] max-h-[420px] w-full">
        <defs>
          <pattern id="auth-cren" width="26" height="16" patternUnits="userSpaceOnUse">
            <rect width="15" height="16" fill="#05080f" />
          </pattern>
        </defs>
        <g fill="#05080f">
          <rect x="0" y="226" width="1440" height="194" />
          <rect x="0" y="210" width="1440" height="16" fill="url(#auth-cren)" />
          <rect x="150" y="150" width="90" height="270" />
          <rect x="150" y="134" width="90" height="16" fill="url(#auth-cren)" />
          <rect x="1200" y="150" width="90" height="270" />
          <rect x="1200" y="134" width="90" height="16" fill="url(#auth-cren)" />
          <rect x="400" y="110" width="110" height="310" />
          <rect x="400" y="94" width="110" height="16" fill="url(#auth-cren)" />
          <rect x="930" y="110" width="110" height="310" />
          <rect x="930" y="94" width="110" height="16" fill="url(#auth-cren)" />
          <rect x="560" y="40" width="320" height="380" />
          <rect x="560" y="24" width="320" height="16" fill="url(#auth-cren)" />
        </g>
        <g fill="#ecbb45" fillOpacity="0.85">
          <rect x="187" y="190" width="16" height="26" rx="8" />
          <rect x="1237" y="190" width="16" height="26" rx="8" />
          <rect x="447" y="160" width="16" height="26" rx="8" />
          <rect x="977" y="160" width="16" height="26" rx="8" />
        </g>
      </svg>
    </div>
  );
}

/**
 * Hülle aller Anmeldeseiten (Entwurf „Horizont“): Szene über die ganze Breite, Leitsatz und darunter die Karte mit dem Formular.
 * Die Szene bleibt in beiden Modi nächtlich (theme-fixed); die Karte folgt dem Tag-/Nachtmodus (theme-content).
 */
export function AuthLayout({ title, subtitle, children, wide }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="auth-root theme-fixed relative flex min-h-full flex-col overflow-clip text-white">
      <Scene />
      <header className="relative z-10 flex items-center justify-between gap-2 px-5 py-5 sm:px-12 sm:py-6">
        <Logo dark />
        <div className="flex items-center gap-2">
          <LanguageSwitch dark />
          <ThemeToggle />
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center px-4 pb-8">
        <div className="mt-2 max-w-3xl text-center sm:mt-8">
          <p className="text-[32px] font-extrabold leading-[1.1] tracking-tight sm:text-[50px]">
            {t('auth.sloganBefore')} <span className="text-gold-400">{t('auth.sloganAccent')}</span>
          </p>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-brand-300 sm:mt-4 sm:text-[17px]">{t('auth.sloganText')}</p>
        </div>

        <section
          className={`auth-panel theme-content mt-8 w-full rounded-[20px] bg-white p-6 text-slate-800 shadow-[0_30px_80px_rgba(0,0,0,0.55)] ring-1 ring-white/60 sm:mt-10 sm:p-8 ${wide ? 'max-w-xl' : 'max-w-[420px]'}`}
        >
          <h1 className="text-[26px] font-extrabold leading-tight tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[14px] text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </section>
      </main>

      <footer className="relative z-10 flex flex-col items-center gap-3 px-4 pb-6 pt-4">
        <ul className="flex flex-wrap justify-center gap-2.5">
          {(['zk', 'bsi', 'audit'] as const).map((k) => (
            <li key={k} className="rounded-full border border-white/15 px-3.5 py-1.5 text-xs font-semibold text-brand-200">
              {t(`auth.trust.${k}.title`)} · {t(`auth.trust.${k}.text`)}
            </li>
          ))}
        </ul>
        <p className="text-center text-[11px] text-brand-400">
          Bastion v{__APP_VERSION__} · {t('app.tagline')}
        </p>
      </footer>
    </div>
  );
}
