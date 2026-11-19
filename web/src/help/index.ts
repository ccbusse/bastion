import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionInfo } from '../lib/types';
import { articlesDe } from './de';
import { articlesEn } from './en';
import type { Article, Audience, Category } from './types';

export type { Article, Block, Category } from './types';

export const CATEGORIES: Category[] = ['basics', 'admin', 'operations'];

/** Welche Artikelgruppen jemand in der Übersicht sieht (die Texte sind nicht geheim, nur nach Relevanz gefiltert). */
export function audiencesFor(info: SessionInfo): Set<Audience> {
  const set = new Set<Audience>(['all']);
  const isSystemAdmin = info.permissions.isSystemAdmin;
  if (isSystemAdmin || info.permissions.isTenantAdmin || info.permissions.tenant.length > 0) set.add('admin');
  if (isSystemAdmin) set.add('system');
  return set;
}

export function useArticles(info: SessionInfo): Article[] {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return useMemo(() => {
    const all = lang === 'en' ? articlesEn : articlesDe;
    const audiences = audiencesFor(info);
    return all.filter((a) => audiences.has(a.audience));
  }, [lang, info]);
}

/** Text eines Artikels für die Suche (ohne Auszeichnung). */
export function articleText(a: Article): string {
  const parts: string[] = [a.title, a.summary];
  for (const b of a.body) {
    if ('h' in b) parts.push(b.h);
    else if ('p' in b) parts.push(b.p);
    else if ('tip' in b) parts.push(b.tip);
    else if ('warn' in b) parts.push(b.warn);
    else if ('code' in b) parts.push(b.code);
    else if ('list' in b) parts.push(...b.list);
    else if ('steps' in b) parts.push(...b.steps);
  }
  return parts.join(' ').replace(/\*\*|`|\[([^\]]+)\]\([^)]+\)/g, '$1').toLowerCase();
}
