import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, ConfirmModal, ErrorAlert, formatDate, HelpLink } from '../../components/ui';
import { get, post } from '../../lib/api';
import { approveEmergencyKey } from '../../state/emergency';
import { useUnlocked } from '../../state/session';
import { runKeyMaintenance } from '../../state/vault';

interface TenantEmergency {
  key: { id: string; publicKey: string; fingerprint: string; createdAt: string } | null;
  approval: { approvedAt: string; approvedBy: string | null } | null;
  coverage: {
    folders: number;
    coveredFolders: number;
    items: number;
    coveredItems: number;
    personal: { users: number; coveredUsers: number };
  } | null;
}

/** Freigabe des systemweiten Notfallschlüssels für diesen Tenant (nur Tenant-Admins). */
export function TenantEmergencyCard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { info, keys, refresh } = useUnlocked();
  const status = useQuery({ queryKey: ['tenant-emergency'], queryFn: () => get<TenantEmergency>('/emergency/tenant') });
  const [confirm, setConfirm] = useState<'approve' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const d = status.data;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      const s = await refresh();
      if (s) await runKeyMaintenance(s, keys).catch(() => undefined);
      await qc.invalidateQueries({ queryKey: ['tenant-emergency'] });
      setConfirm(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <LifeBuoy className="h-4 w-4 text-brand-500" /> {t('tenantEmergency.title')} <HelpLink article="tenant-emergency" />
        </span>
      }
      actions={d?.key && (d.approval ? <Badge color="green">{t('emergency.approved')}</Badge> : <Badge color="yellow">{t('emergency.pendingApproval')}</Badge>)}
    >
      <div className="space-y-4 text-sm text-slate-700">
        <ErrorAlert error={error ?? status.error} />
        {!d?.key ? (
          <p className="text-slate-500">{t('tenantEmergency.none')}</p>
        ) : (
          <>
            <p>{t('tenantEmergency.text')}</p>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
              <dt className="text-slate-500">{t('emergency.fingerprint')}</dt>
              <dd className="font-mono font-semibold text-slate-900">{d.key.fingerprint}</dd>
              <dt className="text-slate-500">{t('emergency.createdAt')}</dt>
              <dd>{formatDate(d.key.createdAt, i18n.language)}</dd>
              {d.approval && (
                <>
                  <dt className="text-slate-500">{t('tenantEmergency.approvedAt')}</dt>
                  <dd>
                    {formatDate(d.approval.approvedAt, i18n.language)}
                    {d.approval.approvedBy && <span className="text-slate-500"> · {d.approval.approvedBy}</span>}
                  </dd>
                </>
              )}
              {d.approval && d.coverage && (
                <>
                  <dt className="text-slate-500">{t('tenantEmergency.coverage')}</dt>
                  <dd>
                    {t('tenantEmergency.coverageValue', {
                      folders: d.coverage.coveredFolders,
                      foldersTotal: d.coverage.folders,
                      users: d.coverage.personal.coveredUsers,
                      usersTotal: d.coverage.personal.users,
                    })}
                  </dd>
                </>
              )}
            </dl>
            {!d.approval ? (
              <>
                <Alert kind="warning">{t('tenantEmergency.personalWarning')}</Alert>
                <Button onClick={() => setConfirm('approve')} disabled={!info.tenant?.signingInitialized}>
                  {t('tenantEmergency.approve')}
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => setConfirm('revoke')}>
                {t('tenantEmergency.revoke')}
              </Button>
            )}
          </>
        )}
      </div>
      {d?.key && (
        <ConfirmModal
          open={confirm === 'approve'}
          onClose={() => setConfirm(null)}
          loading={busy}
          title={t('tenantEmergency.approveTitle')}
          confirmLabel={t('tenantEmergency.approveConfirm')}
          onConfirm={() => void run(() => approveEmergencyKey(info, keys, d.key!))}
        >
          <p>{t('tenantEmergency.approveText')}</p>
          <p className="my-3 rounded-md bg-slate-50 px-3 py-2 text-center font-mono font-semibold text-slate-900">{d.key.fingerprint}</p>
          <p>{t('tenantEmergency.personalWarning')}</p>
        </ConfirmModal>
      )}
      <ConfirmModal
        open={confirm === 'revoke'}
        onClose={() => setConfirm(null)}
        loading={busy}
        danger
        title={t('tenantEmergency.revokeTitle')}
        onConfirm={() => void run(() => post('/emergency/tenant/revoke'))}
      >
        {t('tenantEmergency.revokeText')}
      </ConfirmModal>
    </Card>
  );
}
