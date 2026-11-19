import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MasterPasswordFields } from '../../components/MasterPasswordFields';
import { Alert, Badge, Button, Card, ConfirmModal, ErrorAlert, Field, formatDate, IconButton, Input, Modal, PageHeader, Select, Spinner, useErrorMessage } from '../../components/ui';
import { del, get, post } from '../../lib/api';
import { openTenantAdminKeys, recoverUser } from '../../lib/crypto/account';
import type { InviteResult, ScopeType, UserRow } from '../../lib/types';
import { useCan, useUnlocked } from '../../state/session';
import { distributePendingKeys } from '../../state/vault';
import { ReauthModal } from '../settings/AccountPage';
import { useOwnTenantFingerprint } from '../../components/TrustAnchor';
import { organizationCodeOf } from '../../lib/crypto/trust';
import { ConfirmUserModal, InviteResultAlert, roleLabel, StatusBadge, useAdminStructure, useRoles, useScopeLabel } from './shared';

/** Auswahl von Rolle + Geltungsbereich. */
export function ScopeRolePicker({
  value,
  onChange,
}: {
  value: { roleId: string; scope: string };
  onChange: (v: { roleId: string; scope: string }) => void;
}) {
  const { t } = useTranslation();
  const roles = useRoles();
  const structure = useAdminStructure();
  const role = roles.data?.find((r) => r.id === value.roleId);
  const tenantOnly = !!role?.permissions.some((p) => p.startsWith('tenant.'));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('users.role')}>
        <Select value={value.roleId} onChange={(e) => onChange({ roleId: e.target.value, scope: value.scope })}>
          <option value="">{t('common.choose')}</option>
          {roles.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {roleLabel(t, r)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('users.scope')}>
        <Select value={tenantOnly ? 'TENANT' : value.scope} disabled={tenantOnly} onChange={(e) => onChange({ roleId: value.roleId, scope: e.target.value })}>
          <option value="TENANT">{t('scope.tenant')}</option>
          {structure.data?.departments.map((d) => (
            <optgroup key={d.id} label={d.name}>
              <option value={`DEPARTMENT:${d.id}`}>
                {t('scope.department')}: {d.name}
              </option>
              {d.folders.map((f) => (
                <option key={f.id} value={`FOLDER:${f.id}`}>
                  {t('scope.folder')}: {f.path}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
    </div>
  );
}

export function scopeToPayload(scope: string): { scopeType: ScopeType; departmentId?: string; folderId?: string } {
  if (scope.startsWith('DEPARTMENT:')) return { scopeType: 'DEPARTMENT', departmentId: scope.slice(11) };
  if (scope.startsWith('FOLDER:')) return { scopeType: 'FOLDER', folderId: scope.slice(7) };
  return { scopeType: 'TENANT' };
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tenantFp = useOwnTenantFingerprint();
  const tenantCode = tenantFp.data ? organizationCodeOf(tenantFp.data) : null;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pick, setPick] = useState({ roleId: '', scope: 'TENANT' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const roles = useRoles();
  const role = roles.data?.find((r) => r.id === pick.roleId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const scope = role?.permissions.some((p) => p.startsWith('tenant.')) ? 'TENANT' : pick.scope;
      const r = await post<InviteResult>('/users/invite', {
        email: email.trim(),
        name: name.trim() || undefined,
        assignments: pick.roleId ? [{ roleId: pick.roleId, ...scopeToPayload(scope) }] : [],
      });
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['users'] });
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
      title={t('users.invite')}
      footer={
        result ? (
          <Button onClick={onClose}>{t('common.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} loading={busy} disabled={!email}>
              {t('users.sendInvite')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <InviteResultAlert result={result} organizationCode={tenantCode} />
      ) : (
        <div className="space-y-4">
          <ErrorAlert error={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('common.email')}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </Field>
            <Field label={t('common.nameOptional')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <p className="text-sm font-medium text-slate-700">{t('users.initialRole')}</p>
          <ScopeRolePicker value={pick} onChange={setPick} />
          <p className="text-xs text-slate-500">{t('users.inviteFlowHint')}</p>
        </div>
      )}
    </Modal>
  );
}

function AssignmentsModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { info, keys } = useUnlocked();
  const scopeLabel = useScopeLabel();
  const roles = useRoles();
  const [pick, setPick] = useState({ roleId: '', scope: 'TENANT' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/users') });
  const current = users.data?.find((u) => u.id === user.id) ?? user;

  const after = async () => {
    await distributePendingKeys(info, keys).catch(() => 0);
    await Promise.all(['users', 'structure', 'items'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const role = roles.data?.find((r) => r.id === pick.roleId);
      const scope = role?.permissions.some((p) => p.startsWith('tenant.')) ? 'TENANT' : pick.scope;
      await post('/assignments', { userId: user.id, roleId: pick.roleId, ...scopeToPayload(scope) });
      setPick({ roleId: '', scope: 'TENANT' });
      await after();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t('users.rolesOf', { name: user.name || user.email })} size="lg" footer={<Button onClick={onClose}>{t('common.done')}</Button>}>
      <div className="space-y-5">
        <ErrorAlert error={error} />
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {current.assignments?.length ? (
            current.assignments.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-medium text-slate-800">{roleLabel(t, { key: a.roleKey, name: a.roleName })}</span>
                <span className="mr-auto text-slate-500">{scopeLabel(a.scopeType, a.departmentId, a.folderId)}</span>
                <IconButton
                  label={t('common.remove')}
                  onClick={async () => {
                    setError(null);
                    try {
                      await del(`/assignments/${a.id}`);
                      await after();
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            ))
          ) : (
            <li className="px-3 py-3 text-sm text-slate-400">{t('users.noRoles')}</li>
          )}
        </ul>
        <div className="space-y-3 rounded-md bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-700">{t('users.addRole')}</p>
          <ScopeRolePicker value={pick} onChange={setPick} />
          <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={add} loading={busy} disabled={!pick.roleId}>
            {t('common.add')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RecoverModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { t } = useTranslation();
  const { info, keys } = useUnlocked();
  const [temp, setTemp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!temp || !info.tenant) return;
    setBusy(true);
    setError(null);
    try {
      const recovery = await get<{ protectedRecoveryPrivateKey: string; wrappedKey: string | null }>('/keys/tenant-recovery');
      if (!recovery.wrappedKey) throw new Error('NO_RECOVERY_GRANT');
      const { recoveryKey: recKey } = await openTenantAdminKeys(info.tenant.id, keys, { protectedRecoveryPrivateKey: recovery.protectedRecoveryPrivateKey, wrappedKey: recovery.wrappedKey });
      const { recoveryAccountKey } = await get<{ recoveryAccountKey: string }>(`/users/${user.id}/recovery`);
      await post(`/users/${user.id}/recover`, await recoverUser(recKey, recoveryAccountKey, temp));
      setDone(true);
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
      title={t('users.recoverTitle')}
      footer={
        done ? (
          <Button onClick={onClose}>{t('common.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={submit} loading={busy} disabled={!temp}>
              {t('users.recoverSubmit')}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Alert kind="success">{t('users.recoverDone', { email: user.email })}</Alert>
      ) : (
        <div className="space-y-4">
          <ErrorAlert error={error} />
          <Alert kind="warning" title={t('users.recoverWarningTitle')}>
            {t('users.recoverWarning')}
          </Alert>
          <MasterPasswordFields userInputs={[user.email, user.name]} onChange={setTemp} label={t('users.tempPassword')} />
        </div>
      )}
    </Modal>
  );
}

type Dialog = { kind: 'confirm' | 'endorse' | 'roles' | 'recover' | 'delete' | 'resend'; user: UserRow } | null;

function RowMenu({ user, onAction }: { user: UserRow; onAction: (kind: string) => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const { info } = useUnlocked();
  // Position des Menüs relativ zum Fenster: Die Tabelle scrollt horizontal und würde ein absolut positioniertes Menü abschneiden
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const open = !!pos;
  const close = () => setPos(null);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);
  const isSelf = user.id === info.user.id;
  const admin = info.permissions.isTenantAdmin;
  // System-Admin-Konten können nur von System-Admins verwaltet werden
  const canTouch = !isSelf && (!user.isTenantAdmin || admin) && (user.systemRole !== 'SYSTEM_ADMIN' || info.permissions.isSystemAdmin);
  const actions: [string, string, boolean][] = [
    ['roles', t('users.manageRoles'), can('tenant.roles.manage') || can('tenant.users.manage')],
    ['resend', t('users.resendInvite'), canTouch && user.status === 'INVITED' && can('tenant.users.invite')],
    ['disable', t('users.disable'), canTouch && user.status !== 'DISABLED' && user.status !== 'INVITED' && can('tenant.users.manage')],
    ['enable', t('users.enable'), canTouch && user.status === 'DISABLED' && can('tenant.users.manage')],
    ['unlock', t('users.unlock'), canTouch && !!user.lockedUntil && new Date(user.lockedUntil) > new Date() && can('tenant.users.manage')],
    ['resetMfa', t('users.resetMfa'), canTouch && admin && user.totpEnabled],
    ['recover', t('users.recover'), canTouch && admin && user.hasRecoveryKey && user.status === 'ACTIVE'],
    ['delete', user.status === 'INVITED' ? t('users.revokeInvite') : t('users.delete'), canTouch && can('tenant.users.manage')],
  ];
  const visible = actions.filter(([, , ok]) => ok);
  if (!visible.length) return null;
  return (
    <>
      <IconButton
        label={t('common.actions')}
        aria-expanded={open}
        onClick={(e) => {
          if (open) return close();
          const r = e.currentTarget.getBoundingClientRect();
          const right = window.innerWidth - r.right;
          // Nach oben öffnen, wenn unten kein Platz ist
          setPos(window.innerHeight - r.bottom < visible.length * 34 + 16 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      {pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={close} />
            <div className="fixed z-50 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg" style={pos} role="menu">
              {visible.map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onAction(kind);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${kind === 'delete' || kind === 'recover' ? 'text-red-600' : 'text-slate-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const tenantFp = useOwnTenantFingerprint();
  const tenantCode = tenantFp.data ? organizationCodeOf(tenantFp.data) : null;
  const can = useCan();
  const { info, keys } = useUnlocked();
  const errMsg = useErrorMessage();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/users') });
  const scopeLabel = useScopeLabel();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Deaktivieren mit Hinweis, falls der persönliche Tresor danach dauerhaft im Notfall-Backup fehlen würde
  const [disableConfirm, setDisableConfirm] = useState<UserRow | null>(null);
  const [resetMfa, setResetMfa] = useState<UserRow | null>(null);

  const refresh = async () => {
    await distributePendingKeys(info, keys).catch(() => 0);
    await qc.invalidateQueries({ queryKey: ['users'] });
  };

  const simple = async (user: UserRow, kind: string) => {
    setMessage(null);
    try {
      if (kind === 'disable') await post(`/users/${user.id}/disable`);
      if (kind === 'enable') await post(`/users/${user.id}/enable`);
      if (kind === 'unlock') await post(`/users/${user.id}/unlock`);
      setMessage({ kind: 'success', text: t(`users.done.${kind}`) });
      await refresh();
    } catch (e) {
      setMessage({ kind: 'error', text: errMsg(e) });
    }
  };

  const onAction = async (user: UserRow, kind: string) => {
    if (kind === 'disable') {
      const check = await get<{ personalNotInBackup: boolean }>(`/emergency/user/${user.id}/disable-check`).catch(() => null);
      if (check?.personalNotInBackup) return setDisableConfirm(user);
    }
    // 2FA zurücksetzen nur nach erneuter Eingabe des eigenen Masterpassworts
    if (kind === 'resetMfa') return setResetMfa(user);
    if (['disable', 'enable', 'unlock'].includes(kind)) void simple(user, kind);
    else setDialog({ kind: kind as NonNullable<Dialog>['kind'], user });
  };

  const pending = users.data?.filter((u) => u.status === 'PENDING_CONFIRMATION') ?? [];
  // Beglaubigen können nur Tenant-Admins mit Zugriff auf den Signaturschlüssel
  const canEndorse = info.permissions.isTenantAdmin && !!info.tenant?.signingInitialized;
  const unendorsed = canEndorse ? (users.data?.filter((u) => u.status === 'ACTIVE' && u.publicKey && u.endorsed === false && u.id !== info.user.id) ?? []) : [];

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        help="users"
        actions={
          can('tenant.users.invite') && (
            <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviteOpen(true)} disabled={!info.tenant?.keysInitialized}>
              {t('users.invite')}
            </Button>
          )
        }
      />
      {!info.tenant?.keysInitialized && <Alert kind="warning" className="mb-4">{t('users.keysNotInitialized')}</Alert>}
      {message && (
        <Alert kind={message.kind} className="mb-4">
          {message.text}
        </Alert>
      )}
      <InviteResultAlert result={inviteResult} organizationCode={tenantCode} />
      {unendorsed.length > 0 && (
        <Card title={t('users.endorseListTitle', { count: unendorsed.length })} className="mb-6 border-gold-400">
          <p className="mb-2 text-sm text-slate-600">{t('users.endorseListText')}</p>
          <ul className="divide-y divide-slate-100">
            {unendorsed.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="mr-auto">
                  <p className="text-sm font-medium text-slate-900">
                    {u.name || u.email} {u.systemRole === 'SYSTEM_ADMIN' && <Badge color="gold">{t('users.systemAdmin')}</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                </div>
                <Button size="sm" variant="gold" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setDialog({ kind: 'endorse', user: u })}>
                  {t('users.endorse')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {pending.length > 0 && can('tenant.users.confirm') && (
        <Card title={t('users.pendingTitle', { count: pending.length })} className="mb-6 border-gold-400">
          <ul className="divide-y divide-slate-100">
            {pending.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="mr-auto">
                  <p className="text-sm font-medium text-slate-900">{u.name || u.email}</p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                </div>
                {(!u.isTenantAdmin || info.permissions.isTenantAdmin) && (
                  <Button size="sm" variant="gold" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setDialog({ kind: 'confirm', user: u })}>
                    {t('users.verifyAndConfirm')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        {users.isLoading ? (
          <Spinner />
        ) : users.error ? (
          <ErrorAlert error={users.error} />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">{t('common.name')}</th>
                  <th className="px-4 py-2.5">{t('users.status')}</th>
                  <th className="px-4 py-2.5">{t('users.roles')}</th>
                  <th className="px-4 py-2.5">MFA</th>
                  <th className="px-4 py-2.5">{t('users.lastLogin')}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.data?.map((u) => (
                  <tr key={u.id} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {u.name || '–'} {u.id === info.user.id && <span className="text-xs text-slate-400">({t('users.you')})</span>}{' '}
                        {u.systemRole === 'SYSTEM_ADMIN' && <Badge color="gold">{t('users.systemAdmin')}</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">{u.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={u.status} lockedUntil={u.lockedUntil} />
                      {u.status === 'ACTIVE' && u.endorsed === false && (
                        <span className="ml-1" title={t('users.notEndorsedHint')}>
                          <Badge color="gold">{t('users.notEndorsed')}</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-sm flex-wrap gap-1">
                        {u.assignments?.map((a) => (
                          <Badge key={a.id} color={a.scopeType === 'TENANT' ? 'blue' : 'gray'}>
                            <span title={scopeLabel(a.scopeType, a.departmentId, a.folderId)}>
                              {roleLabel(t, { key: a.roleKey, name: a.roleName })}
                              {a.scopeType !== 'TENANT' && <span className="ml-1 opacity-60">· {scopeLabel(a.scopeType, a.departmentId, a.folderId).split(': ')[1]}</span>}
                            </span>
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">{u.totpEnabled ? <Badge color="green">{t('common.on')}</Badge> : <Badge>{t('common.off')}</Badge>}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{formatDate(u.lastLoginAt, i18n.language)}</td>
                    <td className="px-4 py-3 text-right">
                      <RowMenu user={u} onAction={(k) => void onAction(u, k)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} />}
      {(dialog?.kind === 'confirm' || dialog?.kind === 'endorse') && (
        <ConfirmUserModal
          user={dialog.user}
          mode={dialog.kind}
          canEndorse={canEndorse}
          endorseHint
          onClose={() => setDialog(null)}
          onConfirmed={async () => {
            setDialog(null);
            setMessage({ kind: 'success', text: t(dialog.kind === 'endorse' ? 'users.done.endorse' : 'users.done.confirm') });
            await refresh();
          }}
        />
      )}
      {dialog?.kind === 'roles' && <AssignmentsModal user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'recover' && <RecoverModal user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'resend' && (
        <ConfirmModal
          open
          title={t('users.resendInvite')}
          onClose={() => setDialog(null)}
          loading={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              setInviteResult(await post<InviteResult>(`/users/${dialog.user.id}/resend-invite`));
            } catch (e) {
              setMessage({ kind: 'error', text: errMsg(e) });
            } finally {
              setBusy(false);
              setDialog(null);
            }
          }}
        >
          {t('users.resendText', { email: dialog.user.email })}
        </ConfirmModal>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          open
          danger
          title={t('users.delete')}
          confirmLabel={t('common.delete')}
          onClose={() => setDialog(null)}
          loading={busy}
          onConfirm={async () => {
            setBusy(true);
            try {
              await del(`/users/${dialog.user.id}`);
              await refresh();
            } catch (e) {
              setMessage({ kind: 'error', text: errMsg(e) });
            } finally {
              setBusy(false);
              setDialog(null);
            }
          }}
        >
          {t('users.deleteText', { email: dialog.user.email })}
        </ConfirmModal>
      )}
      {disableConfirm && (
        <ConfirmModal
          open
          danger
          onClose={() => setDisableConfirm(null)}
          title={t('users.disableEmergencyTitle')}
          confirmLabel={t('users.disable')}
          onConfirm={() => {
            const u = disableConfirm;
            setDisableConfirm(null);
            void simple(u, 'disable');
          }}
        >
          {t('users.disableEmergencyText', { email: disableConfirm.email })}
        </ConfirmModal>
      )}
      {resetMfa && (
        <ReauthModal
          danger
          title={t('users.resetMfa')}
          onClose={() => setResetMfa(null)}
          onConfirm={async (authHash) => {
            await post(`/users/${resetMfa.id}/reset-mfa`, { authHash });
            setResetMfa(null);
            setMessage({ kind: 'success', text: t('users.done.resetMfa') });
            await refresh();
          }}
        >
          <p className="text-sm text-slate-600">{t('users.resetMfaText', { email: resetMfa.email })}</p>
        </ReauthModal>
      )}
    </div>
  );
}
