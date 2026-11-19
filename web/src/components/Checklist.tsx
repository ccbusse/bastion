import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, CircleCheckBig, CircleDashed, Hourglass, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { checklistProgress, setOnboarding, STEP_LINKS, useChecklist } from '../state/onboarding';
import { Button, Card, cx, ErrorAlert, Spinner } from './ui';

/**
 * Checkliste "Erste Schritte": Schritte je Rolle, abgeleitet aus dem tatsächlichen Zustand (vom Server ermittelt).
 * Ausblenden merkt sich der Server pro Benutzer.
 */
export function Checklist() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const checklist = useChecklist();
  const [busy, setBusy] = useState(false);
  const { done, total } = checklistProgress(checklist.data);
  const hidden = !!checklist.data?.hiddenAt;

  const toggle = async () => {
    setBusy(true);
    try {
      await setOnboarding({ checklistHidden: !hidden });
      await qc.invalidateQueries({ queryKey: ['onboarding-checklist'] });
    } finally {
      setBusy(false);
    }
  };

  if (checklist.isLoading)
    return (
      <Card>
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      </Card>
    );
  if (checklist.error) return <ErrorAlert error={checklist.error} />;

  if (hidden)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-5 py-3 text-sm text-slate-600 shadow-sm">
        <span className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-slate-400" />
          {t('checklist.hiddenHint', { done, total })}
        </span>
        <Button size="sm" variant="secondary" onClick={toggle} loading={busy}>
          {t('checklist.show')}
        </Button>
      </div>
    );

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-brand-700" />
          {t('checklist.title')}
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={toggle} loading={busy}>
          {t('checklist.hide')}
        </Button>
      }
    >
      <div className="mb-5">
        <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-slate-500">
          <span>{t('checklist.progress', { done, total })}</span>
          <span>{total ? Math.round((done / total) * 100) : 0} %</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        {total > 0 && done === total && <p className="mt-3 text-sm font-medium text-emerald-700">{t('checklist.allDone')}</p>}
      </div>
      <div className="space-y-6">
        {checklist.data?.groups.map((g) => (
          <section key={g.id}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{t(`checklist.groups.${g.id}`)}</h3>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-100">
              {g.steps.map((s) => {
                const link = STEP_LINKS[s.id];
                const doneStep = s.state === 'done';
                return (
                  <li key={s.id} className="flex items-start gap-3 px-3 py-3">
                    <span className="mt-0.5 shrink-0" aria-label={t(doneStep ? 'checklist.done' : s.state === 'waiting' ? 'checklist.waiting' : 'checklist.go')}>
                      {doneStep ? (
                        <CircleCheckBig className="h-5 w-5 text-emerald-600" />
                      ) : s.state === 'waiting' ? (
                        <Hourglass className="h-5 w-5 text-amber-500" />
                      ) : (
                        <CircleDashed className="h-5 w-5 text-slate-400" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-3">
                      <div className="min-w-0 flex-1">
                        <p className={cx('text-sm font-medium', doneStep ? 'text-slate-500 line-through decoration-slate-300' : 'text-slate-800')}>{t(`checklist.steps.${s.id}.title`)}</p>
                        <p className="text-xs text-slate-500">{s.state === 'waiting' ? t(`checklist.steps.${s.id}.waiting`) : t(`checklist.steps.${s.id}.text`)}</p>
                      </div>
                      {link && (
                        <div className="mt-2 flex items-center gap-1 sm:mt-0 sm:shrink-0">
                          <Link to={`/help/${link.article}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                            <BookOpen className="h-3.5 w-3.5" />
                            {t('checklist.guide')}
                          </Link>
                          {!doneStep && s.state !== 'waiting' && (
                            <Link to={link.to} className="rounded-md bg-brand-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-800">
                              {t('checklist.go')}
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Card>
  );
}
