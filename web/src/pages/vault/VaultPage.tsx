import { FolderLock, Plus, RefreshCw, Search, ShieldOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Alert, Button, cx, EmptyState, IconButton, Input, Select, Spinner } from '../../components/ui';
import { ITEM_TYPES, itemSubtitle } from '../../lib/items';
import type { DecryptedItem, ItemType } from '../../lib/types';
import { useSession } from '../../state/session';
import { useRefreshVault, useStructure, useVaultItems } from '../../state/vault';
import { ItemDetail } from './ItemDetail';
import { ItemEditor, useWritableTargets } from './ItemEditor';
import { ItemIcon } from './ItemIcon';

export function VaultPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filter = params.get('f') ?? 'all';
  const selectedId = params.get('item');
  const items = useVaultItems();
  const structure = useStructure();
  const refresh = useRefreshVault();
  const writable = useWritableTargets();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ItemType | ''>('');
  const [editor, setEditor] = useState<{ item?: DecryptedItem } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const folderInfo = useMemo(() => {
    const map = new Map<string, { name: string; dept: string; hasKey: boolean; canEdit: boolean }>();
    for (const d of structure.data?.departments ?? [])
      for (const f of d.folders) map.set(f.id, { name: f.path, dept: d.name, hasKey: f.hasKey, canEdit: f.permissions.includes('vault.edit') });
    return map;
  }, [structure.data]);

  const locationLabel = (i: DecryptedItem) => (i.personal ? t('nav.personal') : (folderInfo.get(i.folderId!)?.name ?? t('vault.folder')));
  const currentFolder = filter !== 'all' && filter !== 'personal' ? folderInfo.get(filter) : undefined;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items.data ?? []).filter((i) => {
      if (filter === 'personal' && !i.personal) return false;
      if (filter !== 'all' && filter !== 'personal' && i.folderId !== filter) return false;
      if (typeFilter && i.type !== typeFilter) return false;
      if (!q) return true;
      return [i.overview.name, i.overview.username, i.overview.url, i.overview.service, i.overview.host, i.overview.bankName].some((v) => v?.toLowerCase().includes(q));
    });
  }, [items.data, filter, query, typeFilter]);

  const selected = visible.find((i) => i.id === selectedId) ?? null;
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('item', id);
    else next.delete('item');
    setParams(next, { replace: true });
  };

  const title = filter === 'all' ? t('nav.allItems') : filter === 'personal' ? t('nav.personal') : currentFolder ? `${currentFolder.dept} / ${currentFolder.name}` : t('vault.folder');
  const { info } = useSession();
  const canCreate = filter === 'all' || filter === 'personal' || (currentFolder?.canEdit && currentFolder.hasKey);

  return (
    <div className="flex h-full flex-col">
      {/* Titel links, Suche mittig, Filter und Aktionen rechts */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)_minmax(0,1fr)]">
        <h1 className="mr-auto min-w-0 truncate text-lg font-semibold text-slate-900">{title}</h1>
        <div className="relative order-last w-full lg:order-none">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('vault.search')}
            aria-label={t('vault.search')}
            className="h-10 rounded-lg border-slate-300 bg-slate-50 pl-9 text-[15px] focus:bg-white"
          />
        </div>
        <div className="flex items-center justify-end gap-3">
          <div className="w-40 shrink-0">
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ItemType | '')}>
              <option value="">{t('vault.allTypes')}</option>
              {ITEM_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`itemType.${x}`)}
                </option>
              ))}
            </Select>
          </div>
          <IconButton
            label={t('common.refresh')}
            onClick={async () => {
              setRefreshing(true);
              await refresh({ distribute: true }).finally(() => setRefreshing(false));
            }}
          >
            <RefreshCw className={cx('h-4 w-4', refreshing && 'animate-spin')} />
          </IconButton>
          {canCreate && (
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditor({})} className="whitespace-nowrap">
              {t('vault.newItem')}
            </Button>
          )}
        </div>
      </div>

      {filter === 'personal' && info?.emergency?.personalIncluded && (
        <div className="px-6 pt-4">
          <Alert kind="info">{t('vault.emergencyNotice')}</Alert>
        </div>
      )}

      {currentFolder && !currentFolder.hasKey && (
        <div className="px-6 pt-4">
          <Alert kind="warning" title={t('vault.keyPendingTitle')}>
            {t('vault.keyPendingText')}
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className={cx('scrollbar-thin w-full overflow-y-auto border-r border-slate-200 bg-white md:w-96 md:shrink-0', selected && 'hidden md:block')}>
          {items.isLoading ? (
            <div className="flex justify-center p-10">
              <Spinner />
            </div>
          ) : items.error ? (
            <div className="p-4">
              <Alert kind="error">{t('errors.UNKNOWN')}</Alert>
            </div>
          ) : visible.length === 0 ? (
            <EmptyState icon={currentFolder && !currentFolder.hasKey ? <FolderLock className="h-10 w-10" /> : <ShieldOff className="h-10 w-10" />} title={t('vault.empty')}>
              {query ? t('vault.emptySearch') : canCreate ? t('vault.emptyCreate') : null}
            </EmptyState>
          ) : (
            <ul>
              {visible.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => select(i.id)}
                    className={cx('flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50', selected?.id === i.id && 'bg-brand-50 hover:bg-brand-50')}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600">
                      <ItemIcon type={i.type} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cx('truncate text-sm font-medium', i.error ? 'text-red-600' : 'text-slate-900')}>{i.error ? t('vault.decryptError') : i.overview.name}</p>
                      <p className="truncate text-xs text-slate-500">
                        {itemSubtitle(i)}
                        {filter === 'all' && <span className="text-slate-400"> · {locationLabel(i)}</span>}
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={cx('scrollbar-thin min-w-0 flex-1 overflow-y-auto p-6', !selected && 'hidden md:block')}>
          {selected ? (
            <>
              <button type="button" className="mb-3 text-sm text-brand-600 md:hidden" onClick={() => select(null)}>
                ← {t('common.back')}
              </button>
              <ItemDetail key={selected.id} item={selected} locationLabel={locationLabel(selected)} onEdit={() => setEditor({ item: selected })} onDeleted={() => select(null)} />
            </>
          ) : (
            <EmptyState title={t('vault.selectItem')}>{t('vault.selectItemHint')}</EmptyState>
          )}
        </div>
      </div>

      {editor && (
        <ItemEditor
          item={editor.item}
          defaultTarget={filter === 'all' ? (writable[0]?.value ?? 'personal') : filter}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            select(id);
          }}
        />
      )}
    </div>
  );
}
