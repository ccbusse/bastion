import { AlertTriangle, ArrowLeft, BookOpen, ChevronRight, Lightbulb, Route, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Checklist } from '../../components/Checklist';
import { Button, Card, EmptyState, Input, PageHeader } from '../../components/ui';
import { articleText, CATEGORIES, useArticles, type Article, type Block } from '../../help';
import { HelpText } from '../../help/HelpText';
import { useTour } from '../../state/onboarding';
import { useUnlocked } from '../../state/session';

/** Hilfe & Einstieg: erste Schritte, Tour und Anleitungen (Übersicht) bzw. ein einzelner Artikel (/help/:id). */
export function HelpPage() {
  const { id } = useParams();
  return id ? <HelpArticle id={id} /> : <HelpIndex />;
}

function HelpIndex() {
  const { t } = useTranslation();
  const { info } = useUnlocked();
  const articles = useArticles(info);
  const { startTour } = useTour();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return articles;
    return articles.filter((a) => {
      const text = articleText(a);
      return words.every((w) => text.includes(w));
    });
  }, [articles, query]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader title={t('help.title')} description={t('help.description')} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Checklist />
        <Card
          title={
            <span className="flex items-center gap-2">
              <Route className="h-4 w-4 text-brand-700" />
              {t('help.tourTitle')}
            </span>
          }
          className="self-start"
        >
          <p className="mb-4 text-sm text-slate-600">{t('help.tourText')}</p>
          <Button onClick={startTour} className="w-full">
            {t('help.startTour')}
          </Button>
        </Card>
      </div>

      <div className="mt-10">
        <div className="relative mb-6 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('help.search')} className="pl-9" aria-label={t('help.search')} />
        </div>
        {filtered.length === 0 ? (
          <EmptyState icon={<BookOpen className="h-10 w-10" />} title={t('help.noResults')} />
        ) : (
          <div className="space-y-8">
            {CATEGORIES.map((c) => {
              const list = filtered.filter((a) => a.category === c);
              if (!list.length) return null;
              return (
                <section key={c}>
                  <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wider text-slate-700">
                    {t(`help.categories.${c}`)}
                    <span className="text-xs font-normal normal-case tracking-normal text-slate-400">{t(`help.categoryHints.${c}`)}</span>
                  </h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {list.map((a) => (
                      <ArticleCard key={a.id} article={a} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ArticleCard({ article }: { article: Article }) {
  return (
    <Link
      to={`/help/${article.id}`}
      className="group flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50/40"
    >
      <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-slate-900">{article.title}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{article.summary}</span>
      </span>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-300 group-hover:text-brand-600" />
    </Link>
  );
}

function HelpArticle({ id }: { id: string }) {
  const { t } = useTranslation();
  const { info } = useUnlocked();
  const articles = useArticles(info);
  const article = articles.find((a) => a.id === id);
  const related = (article?.related ?? []).map((r) => articles.find((a) => a.id === r)).filter((a): a is Article => !!a);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link to="/help" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" />
        {t('help.back')}
      </Link>
      {!article ? (
        <EmptyState icon={<BookOpen className="h-10 w-10" />} title={t('help.notFound')} />
      ) : (
        <article>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand-600">{t(`help.categories.${article.category}`)}</p>
          <h1 className="text-2xl font-semibold text-slate-900">{article.title}</h1>
          <p className="mt-2 text-base text-slate-500">{article.summary}</p>
          <div className="mt-6 space-y-4 text-sm leading-relaxed text-slate-700">
            {article.body.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
          </div>
          {related.length > 0 && (
            <div className="mt-10 border-t border-slate-200 pt-6">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">{t('help.related')}</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {related.map((a) => (
                  <ArticleCard key={a.id} article={a} />
                ))}
              </div>
            </div>
          )}
        </article>
      )}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  const { t } = useTranslation();
  if ('h' in block) return <h2 className="pt-4 text-base font-semibold text-slate-900">{block.h}</h2>;
  if ('p' in block)
    return (
      <p>
        <HelpText text={block.p} />
      </p>
    );
  if ('list' in block)
    return (
      <ul className="list-disc space-y-1.5 pl-5 marker:text-slate-400">
        {block.list.map((x, i) => (
          <li key={i}>
            <HelpText text={x} />
          </li>
        ))}
      </ul>
    );
  if ('steps' in block)
    return (
      <ol className="space-y-2">
        {block.steps.map((x, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-900 text-xs font-semibold text-white">{i + 1}</span>
            <span className="pt-0.5">
              <HelpText text={x} />
            </span>
          </li>
        ))}
      </ol>
    );
  if ('tip' in block)
    return (
      <div className="flex gap-3 rounded-md border border-brand-200 bg-brand-50 p-3 text-brand-900">
        <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" aria-label={t('help.tip')} />
        <p>
          <HelpText text={block.tip} />
        </p>
      </div>
    );
  if ('warn' in block)
    return (
      <div className="flex gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-label={t('help.warn')} />
        <p>
          <HelpText text={block.warn} />
        </p>
      </div>
    );
  return <pre className="overflow-x-auto rounded-md bg-brand-950 p-3 font-mono text-xs leading-relaxed text-brand-50">{block.code}</pre>;
}
