import { X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button, cx } from './ui';

/**
 * Kurztour durch die Oberfläche. Jeder Schritt zeigt auf ein Element mit data-tour="…". Fehlt das Element ganz,
 * entfällt der Schritt (so passt die Tour sich der Rolle an: Wer keinen Verwaltungsbereich sieht, bekommt ihn nicht erklärt).
 * Ist das Element vorhanden, aber nicht sichtbar (z. B. zugeklappte Seitenleiste auf dem Handy), erscheint die Karte mittig.
 */
interface TourStep {
  id: string;
  target?: string;
}

const STEPS: TourStep[] = [
  { id: 'welcome' },
  { id: 'vault', target: 'nav-vault' },
  { id: 'tools', target: 'nav-tools' },
  { id: 'admin', target: 'nav-admin' },
  { id: 'system', target: 'nav-system' },
  { id: 'emergency', target: 'nav-emergency' },
  { id: 'account', target: 'nav-account' },
  { id: 'help', target: 'nav-help' },
  { id: 'done' },
];

const PAD = 6;
const CARD_W = 340;

const findTarget = (name: string) => document.querySelector<HTMLElement>(`[data-tour="${name}"]`);

function visibleRect(el: HTMLElement | null): DOMRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

export function Tour({ onClose }: { onClose: (reason: 'finished' | 'skipped', next?: 'checklist') => void }) {
  // Schritte einmal beim Start festlegen: was es in dieser Oberfläche nicht gibt, fällt weg. Erst nach dem Einhängen
  // prüfen: Beim ersten Login erscheint die Tour im selben Durchgang wie die Seitenleiste, die dann noch nicht im DOM ist.
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  useLayoutEffect(() => setSteps(STEPS.filter((s) => !s.target || findTarget(s.target))), []);
  return steps ? <TourSteps steps={steps} onClose={onClose} /> : null;
}

function TourSteps({ steps, onClose }: { steps: TourStep[]; onClose: (reason: 'finished' | 'skipped', next?: 'checklist') => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  const measure = useCallback(() => setRect(step.target ? visibleRect(findTarget(step.target)) : null), [step]);

  useLayoutEffect(() => {
    if (step.target) findTarget(step.target)?.scrollIntoView({ block: 'nearest' });
    measure();
  }, [step, measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  useEffect(() => primary.current?.focus(), [index]);

  const next = useCallback(() => (last ? onClose('finished') : setIndex((i) => i + 1)), [last, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose('skipped');
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, onClose]);

  // Karte rechts neben dem Ziel (Seitenleiste links), sonst darunter; ohne Ziel mittig
  const cardStyle: CSSProperties = (() => {
    if (!rect) return {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right + PAD + 16 + CARD_W <= vw - 8) {
      const top = Math.min(Math.max(8, rect.top - PAD), vh - 280);
      return {
        position: 'fixed',
        left: rect.right + PAD + 16,
        top,
        width: CARD_W,
      };
    }
    const top = Math.min(rect.bottom + PAD + 12, vh - 280);
    return {
      position: 'fixed',
      left: Math.max(8, Math.min(rect.left, vw - CARD_W - 8)),
      top,
      width: Math.min(CARD_W, vw - 16),
    };
  })();

  return (
    <div className="fixed inset-0 z-[60]" aria-hidden={false}>
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-lg ring-2 ring-gold-400 transition-all duration-200"
          style={{
            left: rect.left - PAD,
            top: rect.top - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(8, 15, 30, 0.6)',
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-brand-950/60" />
      )}
      <div className={cx(!rect && 'fixed inset-0 flex items-center justify-center p-4')}>
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} style={cardStyle} className={cx('rounded-lg bg-white p-5 shadow-2xl', !rect && 'w-full max-w-md')}>
          <div className="mb-2 flex items-start justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-brand-600">{t('tour.step', { n: index + 1, total: steps.length })}</p>
            <button
              type="button"
              onClick={() => onClose('skipped')}
              className="-m-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label={t('tour.skip')}
              title={t('tour.skip')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <h2 id={titleId} className="text-lg font-semibold text-slate-900">
            {t(`tour.${step.id}.title`)}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{t(`tour.${step.id}.text`)}</p>
          <div className="mt-4 flex gap-1" aria-hidden>
            {steps.map((s, i) => (
              <span key={s.id} className={cx('h-1.5 flex-1 rounded-full', i <= index ? 'bg-brand-700' : 'bg-slate-200')} />
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            {index > 0 ? (
              <Button variant="ghost" size="sm" onClick={back}>
                {t('tour.back')}
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => onClose('skipped')}>
                {t('tour.skip')}
              </Button>
            )}
            <div className="flex gap-2">
              {last && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onClose('finished', 'checklist');
                    navigate('/help');
                  }}
                >
                  {t('tour.toChecklist')}
                </Button>
              )}
              <Button ref={primary} size="sm" onClick={next}>
                {last ? t('tour.finish') : t('tour.next')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
