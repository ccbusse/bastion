import { useQueryClient } from '@tanstack/react-query';
import { Wand2 } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, ErrorAlert, Field, IconButton, Input, Modal, PasswordInput, Select, Textarea } from '../../components/ui';
import { post, put } from '../../lib/api';
import { uuid } from '../../lib/crypto/encoding';
import { DEFAULT_GENERATOR, generatePassword } from '../../lib/generator';
import { encryptItem, ITEM_FIELDS, ITEM_TYPES, splitFields } from '../../lib/items';
import type { DecryptedItem, FieldValues, ItemType } from '../../lib/types';
import { useUnlocked } from '../../state/session';
import { itemKeysFor, loadFolderKeys, useStructure } from '../../state/vault';

export function useWritableTargets() {
  const structure = useStructure();
  const { t } = useTranslation();
  return useMemo(() => {
    const targets: { value: string; label: string }[] = [{ value: 'personal', label: t('nav.personal') }];
    for (const d of structure.data?.departments ?? []) {
      for (const f of d.folders) if (f.hasKey && f.permissions.includes('vault.edit')) targets.push({ value: f.id, label: `${d.name} / ${f.path}` });
    }
    return targets;
  }, [structure.data, t]);
}

export function ItemEditor({ item, defaultTarget, onClose, onSaved }: { item?: DecryptedItem; defaultTarget: string; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useTranslation();
  const { info, keys } = useUnlocked();
  const qc = useQueryClient();
  const targets = useWritableTargets();
  const [type, setType] = useState<ItemType>(item?.type ?? 'LOGIN');
  const [name, setName] = useState(item?.overview.name ?? '');
  const [values, setValues] = useState<FieldValues>(() => {
    if (!item) return {};
    const { name: _n, last4: _l, ...o } = item.overview;
    void _n;
    void _l;
    return { ...o, ...(item.secret ?? {}) };
  });
  const initialTarget = item ? (item.personal ? 'personal' : item.folderId!) : targets.some((x) => x.value === defaultTarget) ? defaultTarget : 'personal';
  const [target, setTarget] = useState(initialTarget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));
  // Unternehmenseinträge dürfen nicht in den persönlichen Tresor verschoben werden
  const targetOptions = item && !item.personal ? targets.filter((x) => x.value !== 'personal') : targets;
  const currentMissing = item && !targetOptions.some((x) => x.value === initialTarget);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const id = item?.id ?? uuid();
      if (target !== 'personal') await loadFolderKeys(info, keys);
      const itemKeys = itemKeysFor(keys, target);
      const { overview, secret } = splitFields(type, name.trim(), values);
      const enc = await encryptItem(itemKeys, id, overview, secret);
      const body = { type, folderId: target === 'personal' ? null : target, ...enc };
      if (item) await put(`/items/${id}`, { ...body, revision: item.revision });
      else await post('/items', { id, ...body });
      await qc.invalidateQueries({ queryKey: ['items'] });
      await qc.invalidateQueries({ queryKey: ['structure'] });
      onSaved(id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? t('vault.editItem') : t('vault.newItem')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="item-editor" loading={busy} disabled={!name.trim() || !!currentMissing}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="item-editor" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={error} />
        {currentMissing && <Alert kind="warning">{t('vault.noWriteTarget')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('vault.type')}>
            <Select value={type} onChange={(e) => setType(e.target.value as ItemType)} disabled={!!item}>
              {ITEM_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`itemType.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('vault.location')}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {targetOptions.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('field.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus />
        </Field>
        {ITEM_FIELDS[type].map((f) => {
          const label = t(`field.${f.key}`);
          const v = values[f.key] ?? '';
          if (f.kind === 'textarea' || f.kind === 'secretArea')
            return (
              <Field key={f.key} label={label}>
                <Textarea value={v} onChange={(e) => set(f.key, e.target.value)} className={f.mono ? 'font-mono text-xs' : ''} spellCheck={!f.mono} rows={f.kind === 'secretArea' ? 6 : 4} />
              </Field>
            );
          if (f.kind === 'password')
            return (
              <Field key={f.key} label={label}>
                <PasswordInput
                  value={v}
                  onChange={(e) => set(f.key, e.target.value)}
                  autoComplete="new-password"
                  extra={
                    f.key === 'password' || f.key === 'apiSecret' ? (
                      <IconButton label={t('nav.generator')} onClick={() => set(f.key, generatePassword(DEFAULT_GENERATOR))}>
                        <Wand2 className="h-4 w-4" />
                      </IconButton>
                    ) : undefined
                  }
                />
              </Field>
            );
          return (
            <Field key={f.key} label={label} hint={f.kind === 'totp' ? t('vault.totpHint') : undefined}>
              <Input
                value={v}
                onChange={(e) => set(f.key, e.target.value)}
                type={f.kind === 'url' ? 'text' : 'text'}
                inputMode={f.kind === 'url' ? 'url' : undefined}
                className={f.mono ? 'font-mono' : ''}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          );
        })}
        <p className="text-xs text-slate-500">{t('vault.e2eHint')}</p>
      </form>
    </Modal>
  );
}
