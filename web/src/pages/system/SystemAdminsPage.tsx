import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Field, formatDate, Input, Modal, PageHeader, Spinner, useErrorMessage } from '../../components/ui';
import { get, post } from '../../lib/api';
import type { InviteResult, UserRow } from '../../lib/types';
import { useUnlocked } from '../../state/session';
import { ConfirmUserModal, InviteResultAlert, StatusBadge } from '../admin/shared';

export function SystemAdminsPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const errMsg = useErrorMessage();
  const { info } = useUnlocked();
  const admins = useQuery({ queryKey: ['system-admins'], queryFn: () => get<UserRow[]>('/system/admins') });
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [confirming, setConfirming] = useState<UserRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => qc.invalidateQueries({ queryKey: ['system-admins'] });

  const act = async (path: string) => {
    setError(null);
    try {
      await post(path);
      await reload();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title={t('systemAdmins.title')}
        description={t('systemAdmins.description')}
        help="system-setup"
        actions={
          <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviting(true)}>
            {t('systemAdmins.invite')}
          </Button>
        }
      />
      {error && (
        <Alert kind="error" className="mb-4">
          {error}
        </Alert>
      )}
      <InviteResultAlert result={result} />
      <Card className="mt-4">
        {admins.isLoading ? (
          <Spinner />
        ) : (
          <ul className="-my-3 divide-y divide-slate-100">
            {admins.data?.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="mr-auto">
                  <p className="font-medium text-slate-900">
                    {u.name || u.email} {u.id === info.user.id && <span className="text-xs text-slate-400">({t('users.you')})</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {u.email} · {t('users.lastLogin')}: {formatDate(u.lastLoginAt, i18n.language)}
                  </p>
                </div>
                <StatusBadge status={u.status} lockedUntil={u.lockedUntil} />
                {u.id !== info.user.id && (
                  <>
                    {u.status === 'PENDING_CONFIRMATION' && (
                      <Button size="sm" variant="gold" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setConfirming(u)}>
                        {t('users.verifyAndConfirm')}
                      </Button>
                    )}
                    {u.status === 'INVITED' && (
                      <Button size="sm" variant="secondary" onClick={async () => setResult(await post<InviteResult>(`/users/${u.id}/resend-invite`))}>
                        {t('users.resendInvite')}
                      </Button>
                    )}
                    {u.status === 'ACTIVE' && (
                      <Button size="sm" variant="secondary" onClick={() => act(`/users/${u.id}/disable`)}>
                        {t('users.disable')}
                      </Button>
                    )}
                    {u.status === 'DISABLED' && (
                      <Button size="sm" variant="secondary" onClick={() => act(`/users/${u.id}/enable`)}>
                        {t('users.enable')}
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Alert kind="info" className="mt-4">
        {t('systemAdmins.recoveryHint')}
      </Alert>
      {inviting && (
        <Modal
          open
          onClose={() => setInviting(false)}
          title={t('systemAdmins.invite')}
          size="sm"
          footer={
            <Button
              loading={busy}
              disabled={!email}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await post<InviteResult>('/system/admins', { email }));
                  setEmail('');
                  setInviting(false);
                  await reload();
                } catch (e) {
                  setError(errMsg(e));
                  setInviting(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('users.sendInvite')}
            </Button>
          }
        >
          <Field label={t('common.email')}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
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
    </div>
  );
}
