import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, ConfirmModal, ErrorAlert, Field, IconButton, Input, Modal, PageHeader, Spinner, useErrorMessage } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import type { Role } from '../../lib/types';
import { accessLevels, adminRoles, isLegacyRole, roleHint, roleLabel, topVaultPermission, useRoles, VAULT_PERMISSIONS } from './shared';

/** Eigene Verwaltungsrolle anlegen oder bearbeiten. Tresorzugriff gibt es nur über die festen Zugriffsstufen. */
function RoleModal({ role, onClose }: { role?: Role; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ['permission-catalog'], queryFn: () => get<string[]>('/permissions') });
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions.filter((p) => p.startsWith('tenant.')) ?? []);
  // Ältere Rollen behalten ihre Tresorrechte unverändert (der Server lässt keine neuen zu)
  const keptVault = role?.permissions.filter((p) => p.startsWith('vault.')) ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toggle = (p: string, on: boolean) => setPerms((s) => (on ? [...s, p] : s.filter((x) => x !== p)));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, permissions: [...perms, ...keptVault] };
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
          <Button onClick={submit} loading={busy} disabled={!name.trim() || !(perms.length || keptVault.length)}>
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
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-800">{t('roles.tenantPermissions')}</p>
          <p className="text-xs text-slate-500">{t('roles.tenantHint')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(catalog.data ?? [])
              .filter((p) => p.startsWith('tenant.'))
              .map((p) => (
                <Checkbox key={p} label={t(`perm.${p}`)} hint={t(`permHint.${p}`)} checked={perms.includes(p)} onChange={(v) => toggle(p, v)} />
              ))}
          </div>
        </div>
        {keptVault.length > 0 ? (
          <Alert kind="warning" title={t('roles.legacyTitle')}>
            {t('roles.legacyEditText', { perms: keptVault.map((p) => t(`perm.${p}`)).join(', ') })}
          </Alert>
        ) : (
          <p className="text-xs text-slate-500">{t('roles.noVaultInRoles')}</p>
        )}
      </div>
    </Modal>
  );
}

/** Was jede Zugriffsstufe darf: Häkchen-Tabelle, die Stufen bauen aufeinander auf. */
function AccessLevelsCard({ levels }: { levels: Role[] }) {
  const { t } = useTranslation();
  const rows = [...VAULT_PERMISSIONS];
  return (
    <Card title={t('roles.levelsTitle')} className="mb-6">
      <p className="mb-4 text-sm text-slate-600">{t('roles.levelsText')}</p>
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500">
            <tr>
              <th className="px-5 py-2 font-medium" />
              {levels.map((r) => (
                <th key={r.id} className="px-3 py-2 text-center font-medium">
                  <span className="block text-sm text-slate-900">{roleLabel(t, r)}</span>
                  <span className="block font-normal">{t('roles.assignments', { count: r.assignmentCount })}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => (
              <tr key={p}>
                <td className="px-5 py-2">
                  <span className="block text-slate-800">{t(`ability.${p}`)}</span>
                  <span className="block text-xs text-slate-500">{t(`abilityHint.${p}`)}</span>
                </td>
                {levels.map((r) => {
                  const top = topVaultPermission(r.permissions);
                  const has = !!top && VAULT_PERMISSIONS.indexOf(p) <= VAULT_PERMISSIONS.indexOf(top);
                  return (
                    <td key={r.id} className="px-3 py-2 text-center">
                      {has ? <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label={t('common.yes')} /> : <Minus className="mx-auto h-4 w-4 text-slate-300" aria-label={t('common.no')} />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-slate-500">{t('roles.levelsScopeHint')}</p>
    </Card>
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
  const levels = accessLevels(roles.data).filter((r) => r.isSystem);
  // Verwaltungsrollen und ältere eigene Rollen mit Tresorrechten (die keine Stufe sind)
  const managed = [...adminRoles(roles.data), ...(roles.data ?? []).filter((r) => isLegacyRole(r) && !adminRoles([r]).length)];

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader title={t('roles.title')} description={t('roles.description')} help="roles" />
      {error && (
        <Alert kind="error" className="mb-4">
          {error}
        </Alert>
      )}
      {roles.isLoading ? (
        <Spinner />
      ) : (
        <>
          <AccessLevelsCard levels={levels} />
          <Card
            title={t('roles.adminTitle')}
            actions={
              <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>
                {t('roles.new')}
              </Button>
            }
          >
            <p className="mb-3 text-sm text-slate-600">{t('roles.adminText')}</p>
            <ul className="divide-y divide-slate-100">
              {managed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="mr-auto min-w-0 max-w-xl">
                    <p className="flex items-center gap-2 font-medium text-slate-900">
                      {roleLabel(t, r)} {r.isSystem && <Lock className="h-3.5 w-3.5 text-slate-400" aria-label={t('roles.builtin')} />}
                    </p>
                    <p className="text-xs text-slate-500">{roleHint(t, r)}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.permissions
                        .filter((p) => p.startsWith('tenant.'))
                        .map((p) => (
                          <Badge key={p} color="gold">
                            {t(`perm.${p}`)}
                          </Badge>
                        ))}
                      {isLegacyRole(r) && (
                        <span title={t('roles.legacyHint')}>
                          <Badge color="red">{t('roles.legacyBadge')}</Badge>
                        </span>
                      )}
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
          </Card>
        </>
      )}
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
