import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Checkbox, ConfirmModal, ErrorAlert, Field, IconButton, Input, Modal, PageHeader, Spinner, Alert, useErrorMessage } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import type { Role } from '../../lib/types';
import { roleLabel, useRoles } from './shared';

function RoleModal({ role, onClose }: { role?: Role; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ['permission-catalog'], queryFn: () => get<string[]>('/permissions') });
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toggle = (p: string, on: boolean) => setPerms((s) => (on ? [...s, p] : s.filter((x) => x !== p)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, permissions: perms };
      if (role) await patch(`/roles/${role.id}`, body);
      else await post('/roles', body);
      await qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const group = (prefix: string) => (catalog.data ?? []).filter((p) => p.startsWith(prefix));
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={role ? t('roles.edit') : t('roles.new')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim() || !perms.length}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('common.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Field label={t('common.description')}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
          </Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">{t('roles.vaultPermissions')}</p>
            <p className="text-xs text-slate-500">{t('roles.vaultHint')}</p>
            {group('vault.').map((p) => (
              <Checkbox key={p} label={t(`perm.${p}`)} hint={t(`permHint.${p}`)} checked={perms.includes(p)} onChange={(v) => toggle(p, v)} />
            ))}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-800">{t('roles.tenantPermissions')}</p>
            <p className="text-xs text-slate-500">{t('roles.tenantHint')}</p>
            {group('tenant.').map((p) => (
              <Checkbox key={p} label={t(`perm.${p}`)} hint={t(`permHint.${p}`)} checked={perms.includes(p)} onChange={(v) => toggle(p, v)} />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errMsg = useErrorMessage();
  const roles = useRoles();
  const [editing, setEditing] = useState<{ role?: Role } | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        help="roles"
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>
            {t('roles.new')}
          </Button>
        }
      />
      {error && (
        <Alert kind="error" className="mb-4">
          {error}
        </Alert>
      )}
      <Card>
        {roles.isLoading ? (
          <Spinner />
        ) : (
          <ul className="-my-3 divide-y divide-slate-100">
            {roles.data?.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="mr-auto min-w-0 max-w-xl">
                  <p className="flex items-center gap-2 font-medium text-slate-900">
                    {roleLabel(t, r)} {r.isSystem && <Lock className="h-3.5 w-3.5 text-slate-400" />}
                  </p>
                  <p className="text-xs text-slate-500">{r.key ? t(`builtinRoleHint.${r.key}`, { defaultValue: r.description }) : r.description}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {r.permissions.map((p) => (
                      <Badge key={p} color={p.startsWith('tenant.') ? 'gold' : 'blue'}>
                        {t(`perm.${p}`)}
                      </Badge>
                    ))}
                  </div>
                </div>
                <span className="text-xs text-slate-400">{t('roles.assignments', { count: r.assignmentCount })}</span>
                {!r.isSystem && (
                  <div className="flex">
                    <IconButton label={t('common.edit')} onClick={() => setEditing({ role: r })}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={t('common.delete')} onClick={() => setDeleting(r)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <RoleModal role={editing.role} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmModal
          open
          danger
          title={t('roles.delete')}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await del(`/roles/${deleting.id}`);
              await qc.invalidateQueries({ queryKey: ['roles'] });
            } catch (e) {
              setError(errMsg(e));
            }
            setDeleting(null);
          }}
        >
          {t('roles.deleteText', { name: deleting.name, count: deleting.assignmentCount })}
        </ConfirmModal>
      )}
    </div>
  );
}
