import { useQuery } from '@tanstack/react-query';
import { useOwnTenantFingerprint } from '../../components/TrustAnchor';
import { fingerprint } from '../../lib/crypto/primitives';
import { useUnlocked } from '../../state/session';
import { endorseUser } from '../../state/vault';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Checkbox, CopyButton, ErrorAlert, Modal } from '../../components/ui';
import { get, post } from '../../lib/api';
import type { InviteResult, Role, ScopeType, StructureInfo, UserRow, UserStatus } from '../../lib/types';

export function StatusBadge({ status, lockedUntil }: { status: UserStatus; lockedUntil?: string | null }) {
  const { t } = useTranslation();
  const color = status === 'ACTIVE' ? 'green' : status === 'PENDING_CONFIRMATION' ? 'gold' : status === 'INVITED' ? 'blue' : 'red';
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge color={color}>{t(`userStatus.${status}`)}</Badge>
      {lockedUntil && new Date(lockedUntil) > new Date() && <Badge color="red">{t('users.locked')}</Badge>}
    </span>
  );
}

export function roleLabel(t: TFunction, role: { key: string | null; name: string }) {
  return role.key ? t(`builtinRole.${role.key}`, { defaultValue: role.name }) : role.name;
}

export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: () => get<Role[]>('/roles') });
}

export function useAdminStructure() {
  return useQuery({ queryKey: ['structure'], queryFn: () => get<StructureInfo>('/structure') });
}

export function useScopeLabel() {
  const { t } = useTranslation();
  const structure = useAdminStructure();
  return (scopeType: ScopeType, departmentId: string | null, folderId: string | null) => {
    if (scopeType === 'TENANT') return t('scope.tenant');
    for (const d of structure.data?.departments ?? []) {
      if (scopeType === 'DEPARTMENT' && d.id === departmentId) return `${t('scope.department')}: ${d.name}`;
      const f = d.folders.find((x) => x.id === folderId);
      if (scopeType === 'FOLDER' && f) return `${t('scope.folder')}: ${d.name} / ${f.path}`;
    }
    return t(`scope.${scopeType.toLowerCase()}`);
  };
}

/** Ergebnis einer Einladung. `organizationCode`: Code, den die eingeladene Person auf anderem Weg erhalten muss. */
export function InviteResultAlert({ result, organizationCode }: { result: InviteResult | null; organizationCode?: string | null }) {
  const { t } = useTranslation();
  if (!result) return null;
  const code = organizationCode && (
    <p className="mt-2 text-sm">
      {t('users.inviteCode')} <span className="font-mono font-semibold tracking-wider">{organizationCode}</span>
    </p>
  );
  if (result.emailSent)
    return (
      <Alert kind="success">
        {t('users.inviteSent')}
        {code}
      </Alert>
    );
  return (
    <Alert kind="warning" title={t('users.inviteNoMail')}>
      <div className="mt-1 flex items-center gap-1">
        <code className="block min-w-0 flex-1 truncate rounded bg-white/70 px-2 py-1 text-xs">{result.inviteUrl}</code>
        <CopyButton value={result.inviteUrl ?? ''} />
      </div>
      {code}
    </Alert>
  );
}

/**
 * Bestätigung der Zugehörigkeit bzw. Beglaubigung des Schlüssels mit Fingerprint-Abgleich.
 * Der Fingerprint wird hier im Browser aus dem öffentlichen Schlüssel berechnet, nicht vom Server übernommen.
 * - confirm: Konto freischalten; Tenant-Admins beglaubigen dabei zugleich den Schlüssel
 * - endorse: nur beglaubigen (z. B. beigetretene System-Admins oder von anderen bestätigte Benutzer)
 * Erst beglaubigte Schlüssel erhalten Ordner- und Recovery-Schlüssel.
 */
export function ConfirmUserModal({
  user,
  mode = 'confirm',
  canEndorse,
  endorseHint = false,
  onClose,
  onConfirmed,
}: {
  user: UserRow;
  mode?: 'confirm' | 'endorse';
  canEndorse: boolean;
  /** Hinweis anzeigen, dass ein Tenant-Admin den Schlüssel noch beglaubigen muss */
  endorseHint?: boolean;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const { t } = useTranslation();
  const { info, keys } = useUnlocked();
  const fp = useQuery({ queryKey: ['fingerprint', user.publicKey], queryFn: () => fingerprint(user.publicKey!), enabled: !!user.publicKey });
  const tenantFp = useOwnTenantFingerprint();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'endorse' ? t('users.endorseTitle') : t('users.confirmTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!checked || !fp.data}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (mode === 'confirm') await post(`/users/${user.id}/confirm`, { fingerprint: fp.data });
                if (canEndorse) await endorseUser(info, keys, { id: user.id, publicKey: user.publicKey! });
                onConfirmed();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode === 'endorse' ? t('users.endorse') : t('users.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <ErrorAlert error={error} />
        <p>{t(mode === 'endorse' ? 'users.endorseText' : 'users.confirmText', { name: user.name || user.email, email: user.email })}</p>
        <p className="rounded-md bg-slate-100 p-3 text-center font-mono text-base tracking-wider text-slate-900">{fp.data ?? '…'}</p>
        {canEndorse && tenantFp.data && (
          <>
            <p>{t('users.tenantFingerprintText')}</p>
            <p className="rounded-md bg-slate-100 p-3 text-center font-mono text-sm tracking-wider text-slate-900">{tenantFp.data}</p>
          </>
        )}
        {!canEndorse && endorseHint && <Alert kind="info">{t('users.confirmNoEndorse')}</Alert>}
        <Alert kind="warning">{t('users.confirmWarning')}</Alert>
        <Checkbox label={t('users.confirmCheck')} checked={checked} onChange={setChecked} />
      </div>
    </Modal>
  );
}
