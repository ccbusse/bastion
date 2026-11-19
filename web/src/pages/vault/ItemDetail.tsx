import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, ConfirmModal, CopyButton, cx, formatDate, IconButton, useErrorMessage } from '../../components/ui';
import { del, post } from '../../lib/api';
import { FieldDef, ITEM_FIELDS, safeHref } from '../../lib/items';
import { parseTotp, totpCode } from '../../lib/totp';
import type { DecryptedItem } from '../../lib/types';
import { ItemIcon } from './ItemIcon';

function logEvent(item: DecryptedItem, event: 'reveal' | 'copy', field: string) {
  if (!item.personal) post(`/items/${item.id}/events`, { event, field }).catch(() => undefined);
}

function TotpValue({ secret, onCopy }: { secret: string; onCopy: () => void }) {
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(30);
  useEffect(() => {
    const cfg = parseTotp(secret);
    if (!cfg) return;
    let alive = true;
    const tick = async () => {
      const now = Date.now();
      const c = await totpCode(cfg, now);
      if (alive) {
        setCode(c);
        setLeft(cfg.period - (Math.floor(now / 1000) % cfg.period));
      }
    };
    void tick();
    const h = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [secret]);
  if (!code) return <span className="text-sm text-red-600">–</span>;
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-lg tracking-widest text-slate-900">
        {code.slice(0, 3)} {code.slice(3)}
      </span>
      <span className={cx('rounded-full px-1.5 text-xs tabular-nums', left <= 5 ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600')}>{left}s</span>
      <CopyButton value={code} onCopied={onCopy} />
    </div>
  );
}

function FieldRow({ item, def, value }: { item: DecryptedItem; def: FieldDef; value: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(!def.sensitive);
  const multiline = def.kind === 'textarea' || def.kind === 'secretArea';
  const href = def.kind === 'url' ? safeHref(value) : null;
  return (
    <div className="border-b border-slate-100 py-3 last:border-0">
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t(`field.${def.key}`)}</p>
      <div className="flex items-start justify-between gap-3">
        <div className={cx('min-w-0 flex-1 text-sm text-slate-900', def.mono && 'font-mono', multiline ? 'whitespace-pre-wrap break-words' : 'truncate')}>
          {def.kind === 'totp' ? (
            <TotpValue secret={value} onCopy={() => logEvent(item, 'copy', def.key)} />
          ) : shown ? (
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">
                {value}
              </a>
            ) : (
              value
            )
          ) : (
            '••••••••••••'
          )}
        </div>
        {def.kind !== 'totp' && (
          <div className="flex shrink-0 items-center">
            {def.sensitive && (
              <IconButton
                label={shown ? t('common.hide') : t('common.show')}
                onClick={() => {
                  if (!shown) logEvent(item, 'reveal', def.key);
                  setShown((s) => !s);
                }}
              >
                {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </IconButton>
            )}
            {href && (
              <a href={href} target="_blank" rel="noopener noreferrer" title={t('common.open')} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100">
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
            <CopyButton value={value} onCopied={() => logEvent(item, 'copy', def.key)} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ItemDetail({ item, locationLabel, onEdit, onDeleted }: { item: DecryptedItem; locationLabel: string; onEdit: () => void; onDeleted: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const errMsg = useErrorMessage();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (item.error) return <Alert kind="error">{t('vault.decryptError')}</Alert>;

  const fields = ITEM_FIELDS[item.type]
    .map((def) => ({ def, value: (def.part === 'overview' ? item.overview : item.secret)?.[def.key] }))
    .filter((f): f is { def: FieldDef; value: string } => !!f.value);
  const secretHidden = !item.secret;

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <ItemIcon type={item.type} className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">{item.overview.name}</h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Badge color={item.personal ? 'gray' : 'blue'}>{locationLabel}</Badge>
              <span>{t(`itemType.${item.type}`)}</span>
            </div>
          </div>
        </div>
        {item.canEdit && (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>
              {t('common.edit')}
            </Button>
            <IconButton label={t('common.delete')} onClick={() => setConfirm(true)} className="hover:text-red-600">
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {secretHidden && <Alert kind="info">{t('vault.viewOnly')}</Alert>}
      <div className="rounded-lg border border-slate-200 bg-white px-4">
        {fields.length ? fields.map((f) => <FieldRow key={f.def.key} item={item} def={f.def} value={f.value} />) : <p className="py-4 text-sm text-slate-400">{t('vault.noFields')}</p>}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        {t('vault.updated')}: {formatDate(item.updatedAt, i18n.language)} · {t('vault.created')}: {formatDate(item.createdAt, i18n.language)}
      </p>
      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        danger
        loading={busy}
        title={t('vault.deleteTitle')}
        confirmLabel={t('common.delete')}
        onConfirm={async () => {
          setBusy(true);
          try {
            await del(`/items/${item.id}`);
            await Promise.all([qc.invalidateQueries({ queryKey: ['items'] }), qc.invalidateQueries({ queryKey: ['trash'] }), qc.invalidateQueries({ queryKey: ['structure'] })]);
            setConfirm(false);
            onDeleted();
          } catch (e) {
            setError(errMsg(e));
            setConfirm(false);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('vault.deleteText', { name: item.overview.name })}
      </ConfirmModal>
    </div>
  );
}
