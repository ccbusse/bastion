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

/**
 * Festung am Horizont. Die Zeichenfläche ist sehr breit (4800 × 420): Auf breiten Bildschirmen zeigt sich mehr Mauer,
 * auf schmalen fallen die äußeren Türme weg; die Höhe wird bis zu einem Seitenverhältnis von gut 11:1 nie beschnitten.
 * Mitte bei x = 2400 (Bergfried), Türme symmetrisch nach außen niedriger.
 */
const FORT_W = 4800;
const FORT_MID = FORT_W / 2;
const MERLON = 15;
const MERLON_GAP = 11;
const TOWERS: { offset: number; width: number; top: number; window?: boolean }[] = [
  { offset: 0, width: 320, top: 40 },
  { offset: 265, width: 110, top: 110, window: true },
  { offset: 525, width: 90, top: 150, window: true },
  { offset: 860, width: 80, top: 168 },
  { offset: 1250, width: 90, top: 150, window: true },
  { offset: 1700, width: 80, top: 172 },
  { offset: 2150, width: 90, top: 160, window: true },
];
const TOWER_SHAPES = TOWERS.flatMap((t) => (t.offset === 0 ? [FORT_MID] : [FORT_MID - t.offset, FORT_MID + t.offset]).map((cx) => ({ ...t, x: cx - t.width / 2 })));

/** Zinnen genau über die Turmbreite verteilt: außen immer eine volle Zinne, gleichmäßige Lücken dazwischen. */
function merlons(x: number, width: number) {
  const count = Math.max(2, Math.round((width + MERLON_GAP) / (MERLON + MERLON_GAP)));
  const step = (width - MERLON) / (count - 1);
  return Array.from({ length: count }, (_, i) => x + i * step);
}

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
      <svg viewBox={`0 0 ${FORT_W} 420`} preserveAspectRatio="xMidYMax slice" className="absolute inset-x-0 bottom-0 h-[38vh] min-h-[220px] max-h-[420px] w-full">
        <defs>
          {/* Zinnen der durchgehenden Mauer, an der Mitte ausgerichtet */}
          <pattern id="auth-cren" x={FORT_MID - MERLON / 2} width={MERLON + MERLON_GAP} height="16" patternUnits="userSpaceOnUse">
            <rect width={MERLON} height="16" fill="#05080f" />
          </pattern>
        </defs>
        <g fill="#05080f">
          <rect x="0" y="226" width={FORT_W} height="194" />
          <rect x="0" y="210" width={FORT_W} height="16" fill="url(#auth-cren)" />
          {TOWER_SHAPES.map((t) => (
            <g key={t.x}>
              <rect x={t.x} y={t.top} width={t.width} height={420 - t.top} />
              {merlons(t.x, t.width).map((mx) => (
                <rect key={mx} x={mx} y={t.top - 16} width={MERLON} height="16" />
              ))}
            </g>
          ))}
        </g>
        <g fill="#ecbb45" fillOpacity="0.85">
          {TOWER_SHAPES.filter((t) => t.window).map((t) => (
            <rect key={t.x} x={t.x + t.width / 2 - 8} y={t.top + 40} width="16" height="26" rx="8" />
          ))}
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
