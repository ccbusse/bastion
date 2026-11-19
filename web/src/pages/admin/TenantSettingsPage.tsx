import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, Checkbox, ErrorAlert, Field, Input, PageHeader, Spinner, formatDate } from '../../components/ui';
import { get, patch, post } from '../../lib/api';
import { useSession } from '../../state/session';
import { useOwnTenantFingerprint } from '../../components/TrustAnchor';
import { organizationCodeOf } from '../../lib/crypto/trust';
import { TenantEmergencyCard } from './TenantEmergencyCard';

interface JoinRequest {
  id: string;
  userId: string;
  email: string;
  name: string;
  createdAt: string;
  expiresAt: string;
}

/** Offene Beitrittsanfragen von System-Admins (nur für Tenant-Admins). */
function JoinRequestsCard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const requests = useQuery({ queryKey: ['join-requests'], queryFn: () => get<JoinRequest[]>('/tenant/join-requests') });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const decide = async (r: JoinRequest, action: 'approve' | 'reject') => {
    setBusy(r.id + action);
    setError(null);
    setDone(null);
    try {
      await post(`/tenant/join-requests/${r.id}/${action}`);
      setDone(action === 'approve' ? t('tenantSettings.approved') : t('tenantSettings.rejected'));
      await qc.invalidateQueries({ queryKey: ['join-requests'] });
      if (action === 'approve') await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title={t('tenantSettings.joinRequests')}>
      <div className="space-y-3">
        <ErrorAlert error={error} />
        {done && <Alert kind="success">{done}</Alert>}
        {requests.isLoading ? (
          <Spinner />
        ) : !requests.data?.length ? (
          <p className="text-sm text-slate-500">{t('tenantSettings.joinRequestsEmpty')}</p>
        ) : (
          <>
            <Alert kind="warning">{t('tenantSettings.joinRequestsHint')}</Alert>
            <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
              {requests.data.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <div className="mr-auto">
                    <p className="font-medium text-slate-800">{r.name || r.email}</p>
                    <p className="text-xs text-slate-500">
                      {r.email} · {t('tenantSettings.joinRequestedAt', { date: formatDate(r.createdAt, i18n.language), expires: formatDate(r.expiresAt, i18n.language) })}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" loading={busy === r.id + 'reject'} disabled={busy !== null} onClick={() => decide(r, 'reject')}>
                    {t('tenantSettings.reject')}
                  </Button>
                  <Button size="sm" variant="gold" loading={busy === r.id + 'approve'} disabled={busy !== null} onClick={() => decide(r, 'approve')}>
                    {t('tenantSettings.approve')}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  requireMfa: boolean;
  requireJoinApproval: boolean;
  keysInitialized: boolean;
  stats: { users: Record<string, number>; departments: number; folders: number; items: number };
}

export function TenantSettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { refresh, info } = useSession();
  const tenant = useQuery({ queryKey: ['tenant'], queryFn: () => get<TenantInfo>('/tenant') });
  const [name, setName] = useState('');
  const [requireMfa, setRequireMfa] = useState(false);
  const [requireJoinApproval, setRequireJoinApproval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const tenantFp = useOwnTenantFingerprint();

  useEffect(() => {
    if (tenant.data) {
      setName(tenant.data.name);
      setRequireMfa(tenant.data.requireMfa);
      setRequireJoinApproval(tenant.data.requireJoinApproval);
    }
  }, [tenant.data]);

  if (tenant.isLoading) return <Spinner />;
  const d = tenant.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <PageHeader title={t('tenantSettings.title')} description={t('tenantSettings.description')} help="tenant-settings" />
      {d && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            [t('tenantSettings.users'), d.stats.users.ACTIVE ?? 0],
            [t('nav.structure'), d.stats.departments],
            [t('tenantSettings.folders'), d.stats.folders],
            [t('tenantSettings.items'), d.stats.items],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <p className="text-xs uppercase text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
            </Card>
          ))}
        </div>
      )}
      <Card title={t('tenantSettings.general')}>
        <div className="max-w-md space-y-4">
          <ErrorAlert error={error} />
          {saved && <Alert kind="success">{t('common.saved')}</Alert>}
          <Field label={t('common.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Checkbox label={t('tenantSettings.requireMfa')} hint={t('tenantSettings.requireMfaHint')} checked={requireMfa} onChange={setRequireMfa} />
          <Checkbox label={t('tenantSettings.requireJoinApproval')} hint={t('tenantSettings.requireJoinApprovalHint')} checked={requireJoinApproval} onChange={setRequireJoinApproval} />
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setSaved(false);
              try {
                await patch('/tenant', { name, requireMfa, requireJoinApproval });
                await qc.invalidateQueries({ queryKey: ['tenant'] });
                await refresh();
                setSaved(true);
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
      <Card title={t('tenantSettings.crypto')}>
        <div className="space-y-2 text-sm text-slate-600">
          <p>
            {t('tenantSettings.recoveryKey')}: {d?.keysInitialized ? <Badge color="green">{t('tenantSettings.initialized')}</Badge> : <Badge color="yellow">{t('tenantSettings.notInitialized')}</Badge>}
          </p>
          {tenantFp.data && (
            <>
              <p>
                {t('tenantSettings.organizationCode')}: <span className="font-mono text-base font-semibold tracking-wider text-slate-900">{organizationCodeOf(tenantFp.data)}</span>
              </p>
              <p className="text-xs text-slate-500">{t('tenantSettings.organizationCodeHint')}</p>
              <p>
                {t('account.tenantFingerprint')}: <span className="font-mono text-slate-900">{tenantFp.data}</span>
              </p>
            </>
          )}
          <p className="text-xs text-slate-500">{t('tenantSettings.cryptoHint')}</p>
          <p className="text-xs text-slate-500">{t('tenantSettings.fingerprintHint')}</p>
        </div>
      </Card>
      {info?.permissions.isTenantAdmin && <JoinRequestsCard />}
      {info?.permissions.isTenantAdmin && <TenantEmergencyCard />}
    </div>
  );
}
