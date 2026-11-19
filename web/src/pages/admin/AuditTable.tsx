import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, ErrorAlert, formatDate, Input, Spinner } from '../../components/ui';
import { get } from '../../lib/api';
import type { AuditRow } from '../../lib/types';

export function AuditTable({ endpoint, extraParams = '', toolbar }: { endpoint: string; extraParams?: string; toolbar?: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['audit', endpoint, applied, extraParams],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(extraParams);
      if (applied) p.set('action', applied);
      if (pageParam) p.set('before', pageParam);
      return get<AuditRow[]>(`${endpoint}?${p}`);
    },
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].id : undefined),
  });
  const rows = query.data?.pages.flat() ?? [];

  return (
    <Card>
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(action.trim());
        }}
      >
        <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder={t('audit.filterPlaceholder')} className="max-w-xs" />
        <Button type="submit" variant="secondary">
          {t('audit.filter')}
        </Button>
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </form>
      {query.isLoading ? (
        <Spinner />
      ) : query.error ? (
        <ErrorAlert error={query.error} />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-y border-slate-200 bg-slate-50 uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">{t('audit.time')}</th>
                <th className="px-4 py-2">{t('audit.action')}</th>
                <th className="px-4 py-2">{t('audit.actor')}</th>
                <th className="px-4 py-2">{t('audit.details')}</th>
                <th className="px-4 py-2">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-slate-500">{formatDate(r.createdAt, i18n.language)}</td>
                  <td className="px-4 py-2">
                    <span className="font-medium text-slate-800">{t(`auditAction.${r.action}`, { defaultValue: r.action })}</span>
                    <span className="block font-mono text-[10px] text-slate-400">{r.action}</span>
                  </td>
                  <td className="px-4 py-2 text-slate-700">{r.actorEmail ?? '–'}</td>
                  <td className="max-w-md px-4 py-2 font-mono text-[11px] text-slate-500">
                    {r.targetType && (
                      <span className="block">
                        {r.targetType}: {r.targetId}
                      </span>
                    )}
                    {r.metadata && <span className="block break-all">{JSON.stringify(r.metadata)}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-slate-500">{r.ip ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="px-4 py-6 text-center text-sm text-slate-400">{t('audit.empty')}</p>}
        </div>
      )}
      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
            {t('audit.loadMore')}
          </Button>
        </div>
      )}
    </Card>
  );
}
