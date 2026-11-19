import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { del, post } from '../../lib/api';
import { itemSubtitle } from '../../lib/items';
import type { DecryptedTrashItem } from '../../lib/types';
import { Alert, Button, Card, ConfirmModal, EmptyState, ErrorAlert, PageHeader, Spinner, formatDate, useErrorMessage } from '../../components/ui';
import { useStructure, useTrashItems } from '../../state/vault';
import { ItemIcon } from './ItemIcon';

/**
 * Papierkorb: gelöschte Einträge wiederherstellen oder endgültig löschen. Nach Ablauf der Frist (Server: TRASH_RETENTION_DAYS)
 * löscht der Server sie selbst. Rechte wie beim Löschen: Bearbeiten im Ordner.
 */
export function TrashPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const trash = useTrashItems();
  const structure = useStructure();
  const errMsg = useErrorMessage();
  const [busy, setBusy] = useState<string | null>(null);
  const [purge, setPurge] = useState<DecryptedTrashItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folderNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of structure.data?.departments ?? []) for (const f of d.folders) m.set(f.id, `${d.name} / ${f.path}`);
    return m;
  }, [structure.data]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['trash'] }), qc.invalidateQueries({ queryKey: ['items'] }), qc.invalidateQueries({ queryKey: ['structure'] })]);

  const restore = async (item: DecryptedTrashItem) => {
    setBusy(item.id);
    setError(null);
    try {
      await post(`/items/${item.id}/restore`);
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const items = trash.data ?? [];
  const retentionDays = items.length ? Math.round((Date.parse(items[0].purgeAt) - Date.parse(items[0].deletedAt)) / 86_400_000) : null;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader help="trash" title={t('trash.title')} description={retentionDays ? t('trash.descriptionDays', { days: retentionDays }) : t('trash.description')} />
      {error && <Alert kind="error" className="mb-4">{error}</Alert>}
      {trash.error && <ErrorAlert error={trash.error} />}
      <Card>
        {trash.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Trash2 className="h-10 w-10" />} title={t('trash.empty')} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                <ItemIcon type={item.type} className="h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-800">{item.error ? <span className="italic text-slate-400">{t('trash.unreadable')}</span> : item.overview.name || '—'}</p>
                  <p className="truncate text-xs text-slate-500">
                    {[!item.error && itemSubtitle(item), item.personal ? t('nav.personal') : (folderNames.get(item.folderId!) ?? t('vault.folder'))].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs text-slate-400">
                    {t('trash.deletedAt', { date: formatDate(item.deletedAt, i18n.language) })} · {t('trash.purgeAt', { date: formatDate(item.purgeAt, i18n.language, false) })}
                  </p>
                </div>
                {item.canEdit && (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="secondary" icon={<RotateCcw className="h-4 w-4" />} loading={busy === item.id} onClick={() => restore(item)}>
                      {t('trash.restore')}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={busy === item.id} onClick={() => setPurge(item)}>
                      {t('trash.purge')}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmModal
        open={!!purge}
        onClose={() => setPurge(null)}
        danger
        loading={!!purge && busy === purge.id}
        title={t('trash.purgeTitle')}
        confirmLabel={t('trash.purge')}
        onConfirm={async () => {
          if (!purge) return;
          setBusy(purge.id);
          setError(null);
          try {
            await del(`/items/${purge.id}/permanent`);
            await refresh();
          } catch (e) {
            setError(errMsg(e));
          } finally {
            setBusy(null);
            setPurge(null);
          }
        }}
      >
        {t('trash.purgeText', { name: purge?.overview.name || t('trash.unreadable') })}
      </ConfirmModal>
    </div>
  );
}
