import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, LogOut, Pencil, Plus, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, ConfirmModal, EmptyState, ErrorAlert, Field, IconButton, Input, Modal, PageHeader, Spinner, formatDate, useErrorMessage } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import type { InviteResult, UserRow } from '../../lib/types';
import { useUnlocked } from '../../state/session';
import { runKeyMaintenance } from '../../state/vault';
import { ConfirmUserModal, InviteResultAlert, StatusBadge } from '../admin/shared';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  requireMfa: boolean;
  requireJoinApproval: boolean;
  /** Eigene offene Beitrittsanfrage (gültig bis) */
  joinRequestedUntil: string | null;
  keysInitialized: boolean;
  createdAt: string;
  counts: { users: number; departments: number; folders: number; items: number };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** Nach Beitritt/Austritt: Session neu laden, Tenant-Schlüssel initialisieren bzw. Recovery hinterlegen. */
function useMembershipRefresh() {
  const { keys, refresh } = useUnlocked();
  const qc = useQueryClient();
  return async () => {
    const s = await refresh();
    if (s) await runKeyMaintenance(s, keys).catch(() => undefined);
    await refresh();
    await qc.invalidateQueries();
  };
}

function CreateTenantModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { info } = useUnlocked();
  const membershipRefresh = useMembershipRefresh();
  const [addSelf, setAddSelf] = useState(!info.user.tenantId);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [requireMfa, setRequireMfa] = useState(true);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ invite: InviteResult | null } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ invite: InviteResult | null }>('/system/tenants', {
        name,
        slug,
        requireMfa,
        addSelfAsAdmin: addSelf,
        adminEmail: adminEmail.trim() || undefined,
        adminName: adminName || undefined,
      });
      setResult(r);
      if (addSelf) await membershipRefresh();
      await qc.invalidateQueries({ queryKey: ['tenants'] });
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
      title={t('tenants.new')}
      footer={
        result ? (
          <Button onClick={onClose}>{t('common.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submit} loading={busy} disabled={!name || !slug || (!adminEmail && !addSelf)}>
              {t('tenants.create')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <Alert kind="success">{t('tenants.created')}</Alert>
          {addSelf && <Alert kind="info">{t('tenants.selfAdded')}</Alert>}
          <InviteResultAlert result={result.invite} />
          {result.invite && <p className="text-sm text-slate-600">{t('tenants.nextSteps')}</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <ErrorAlert error={error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('tenants.name')}>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
                autoFocus
              />
            </Field>
            <Field label={t('tenants.slug')} hint={t('tenants.slugHint')}>
              <Input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                className="font-mono"
              />
            </Field>
          </div>
          <Checkbox label={t('tenantSettings.requireMfa')} hint={t('tenantSettings.requireMfaHint')} checked={requireMfa} onChange={setRequireMfa} />
          <div className="rounded-md bg-slate-50 p-4">
            <div className="mb-4">
              <Checkbox label={t('tenants.addSelf')} hint={t('tenants.addSelfHint')} checked={addSelf} onChange={setAddSelf} />
            </div>
            <p className="mb-3 text-sm font-medium text-slate-700">{addSelf ? t('tenants.additionalAdmin') : t('tenants.firstAdmin')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('common.email')}>
                <Input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
              </Field>
              <Field label={t('common.nameOptional')}>
                <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} />
              </Field>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TenantDetailModal({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errMsg = useErrorMessage();
  const users = useQuery({ queryKey: ['tenant-users', tenant.id], queryFn: () => get<UserRow[]>(`/system/tenants/${tenant.id}/users`) });
  const [confirming, setConfirming] = useState<UserRow | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => qc.invalidateQueries({ queryKey: ['tenant-users', tenant.id] });

  return (
    <Modal open onClose={onClose} title={t('tenants.usersOf', { name: tenant.name })} size="lg" footer={<Button onClick={onClose}>{t('common.done')}</Button>}>
      <div className="space-y-4">
        <Alert kind="info">{t('tenants.sysadminScope')}</Alert>
        {error && <Alert kind="error">{error}</Alert>}
        <InviteResultAlert result={inviteResult} />
        {users.isLoading ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {users.data?.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <div className="mr-auto">
                  <p className="font-medium text-slate-800">
                    {u.name || u.email} {u.isTenantAdmin && <Badge color="gold">{t('tenants.admin')}</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                </div>
                <StatusBadge status={u.status} lockedUntil={u.lockedUntil} />
                {u.isTenantAdmin && u.status === 'PENDING_CONFIRMATION' && (
                  <Button size="sm" variant="gold" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setConfirming(u)}>
                    {t('users.verifyAndConfirm')}
                  </Button>
                )}
                {u.isTenantAdmin && u.status === 'INVITED' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      setError(null);
                      try {
                        setInviteResult(await post<InviteResult>(`/users/${u.id}/resend-invite`));
                      } catch (e) {
                        setError(errMsg(e));
                      }
                    }}
                  >
                    {t('users.resendInvite')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2 rounded-md bg-slate-50 p-4">
          <div className="flex-1">
            <Field label={t('tenants.inviteAdmin')}>
              <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="admin@example.com" />
            </Field>
          </div>
          <Button
            icon={<UserPlus className="h-4 w-4" />}
            loading={busy}
            disabled={!inviteEmail}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setInviteResult(await post<InviteResult>(`/system/tenants/${tenant.id}/admins`, { email: inviteEmail }));
                setInviteEmail('');
                await reload();
              } catch (e) {
                setError(errMsg(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('users.sendInvite')}
          </Button>
        </div>
      </div>
      {confirming && (
        <ConfirmUserModal
          user={confirming}
          canEndorse={false}
          onClose={() => setConfirming(null)}
          onConfirmed={async () => {
            setConfirming(null);
            await reload();
          }}
        />
      )}
    </Modal>
  );
}

function EditTenantModal({ tenant, onClose }: { tenant: TenantRow; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(tenant.name);
  const [requireMfa, setRequireMfa] = useState(tenant.requireMfa);
  const [confirmSlug, setConfirmSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['tenants'] });
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
      title={t('tenants.edit')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} onClick={() => run(() => patch(`/system/tenants/${tenant.id}`, { name, requireMfa }))}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorAlert error={error} />
        <Field label={t('tenants.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Checkbox label={t('tenantSettings.requireMfa')} checked={requireMfa} onChange={setRequireMfa} />
        <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">{t('tenants.dangerZone')}</p>
          <p className="text-xs text-red-700">{t('tenants.deleteText', { slug: tenant.slug })}</p>
          <div className="flex gap-2">
            <Input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} placeholder={tenant.slug} className="font-mono" />
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} disabled={confirmSlug !== tenant.slug} loading={busy} onClick={() => run(() => del(`/system/tenants/${tenant.id}?confirm=${encodeURIComponent(confirmSlug)}`))}>
              {t('common.delete')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const { info } = useUnlocked();
  const errMsg = useErrorMessage();
  const membershipRefresh = useMembershipRefresh();
  const [membership, setMembership] = useState<{ kind: 'join' | 'leave'; tenant: TenantRow } | null>(null);
  const memberOf = new Set(info.tenants.map((x) => x.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => get<TenantRow[]>('/system/tenants') });
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<TenantRow | null>(null);
  const [editing, setEditing] = useState<TenantRow | null>(null);
  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
        help="system-setup"
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t('tenants.new')}
          </Button>
        }
      />
      {error && (
        <Alert kind="error" className="mb-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert kind="success" className="mb-4">
          {notice}
        </Alert>
      )}
      <Card>
        {tenants.isLoading ? (
          <Spinner />
        ) : !tenants.data?.length ? (
          <EmptyState title={t('tenants.empty')}>{t('tenants.emptyHint')}</EmptyState>
        ) : (
          <ul className="-my-3 divide-y divide-slate-100">
            {tenants.data.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="mr-auto">
                  <p className="font-medium text-slate-900">{x.name}</p>
                  <p className="font-mono text-xs text-slate-500">{x.slug}</p>
                </div>
                {info.user.tenantId === x.id ? (
                  <Badge color="gold">
                    <Crown className="mr-1 h-3 w-3" />
                    {t('tenants.activeTenant')}
                  </Badge>
                ) : (
                  memberOf.has(x.id) && <Badge color="blue">{t('tenants.member')}</Badge>
                )}
                {x.requireMfa && <Badge color="green">MFA</Badge>}
                {x.joinRequestedUntil && !memberOf.has(x.id) && (
                  <span title={t('tenants.joinPendingUntil', { date: formatDate(x.joinRequestedUntil, i18n.language) })}>
                    <Badge color="yellow">{t('tenants.joinPending')}</Badge>
                  </span>
                )}
                {!x.keysInitialized && <Badge color="yellow">{t('tenants.awaitingAdmin')}</Badge>}
                <span className="text-xs text-slate-500">{t('tenants.counts', x.counts)}</span>
                <Button size="sm" variant="secondary" icon={<Users className="h-3.5 w-3.5" />} onClick={() => setDetail(x)}>
                  {t('tenants.admins')}
                </Button>
                {!memberOf.has(x.id) && !x.joinRequestedUntil && (
                  <Button size="sm" variant="secondary" icon={<Crown className="h-3.5 w-3.5" />} onClick={() => setMembership({ kind: 'join', tenant: x })}>
                    {x.requireJoinApproval ? t('tenants.requestJoin') : t('tenants.join')}
                  </Button>
                )}
                {!memberOf.has(x.id) && x.joinRequestedUntil && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      setError(null);
                      setNotice(null);
                      try {
                        await del(`/system/tenants/${x.id}/join`);
                        await qc.invalidateQueries({ queryKey: ['tenants'] });
                      } catch (e) {
                        setError(errMsg(e));
                      }
                    }}
                  >
                    {t('tenants.cancelJoinRequest')}
                  </Button>
                )}
                {memberOf.has(x.id) && (
                  <IconButton label={t('tenants.leave')} onClick={() => setMembership({ kind: 'leave', tenant: x })}>
                    <LogOut className="h-4 w-4" />
                  </IconButton>
                )}
                <IconButton label={t('common.edit')} onClick={() => setEditing(x)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && <CreateTenantModal onClose={() => setCreating(false)} />}
      {detail && <TenantDetailModal tenant={detail} onClose={() => setDetail(null)} />}
      {editing && <EditTenantModal tenant={editing} onClose={() => setEditing(null)} />}
      {membership && (
        <ConfirmModal
          open
          danger={membership.kind === 'leave'}
          loading={busy}
          title={membership.kind === 'leave' ? t('tenants.leave') : membership.tenant.requireJoinApproval ? t('tenants.requestJoin') : t('tenants.join')}
          confirmLabel={membership.kind === 'leave' ? t('tenants.leave') : membership.tenant.requireJoinApproval ? t('tenants.requestJoin') : t('tenants.join')}
          onClose={() => setMembership(null)}
          onConfirm={async () => {
            setBusy(true);
            setError(null);
            setNotice(null);
            try {
              const r = await post<{ requested?: boolean }>(`/system/tenants/${membership.tenant.id}/${membership.kind}`);
              if (r?.requested) {
                setNotice(t('tenants.joinRequested', { name: membership.tenant.name }));
                await qc.invalidateQueries({ queryKey: ['tenants'] });
              } else await membershipRefresh();
            } catch (e) {
              setError(errMsg(e));
            } finally {
              setBusy(false);
              setMembership(null);
            }
          }}
        >
          {membership.kind === 'leave'
            ? t('tenants.leaveText', { name: membership.tenant.name })
            : membership.tenant.requireJoinApproval
              ? t('tenants.requestJoinText', { name: membership.tenant.name })
              : t('tenants.joinText', { name: membership.tenant.name })}
        </ConfirmModal>
      )}
    </div>
  );
}
