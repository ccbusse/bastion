import { useQuery } from '@tanstack/react-query';
import { useOwnTenantFingerprint } from '../../components/TrustAnchor';
import { fingerprint } from '../../lib/crypto/primitives';
import { useUnlocked } from '../../state/session';
import { endorseUser } from '../../state/vault';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Checkbox, CopyButton, ErrorAlert, Modal, Select } from '../../components/ui';
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

/**
 * Zwei Arten von Rollen:
 * - Zugriffsstufen (nur Tresorrechte): wer was mit Einträgen darf, je Ordner, Abteilung oder für alle Abteilungen.
 *   Die vier eingebauten Stufen bauen aufeinander auf (Verwalten ⊃ Bearbeiten ⊃ Lesen ⊃ Übersicht).
 * - Verwaltungsrollen (enthalten Verwaltungsrechte): wer Bastion verwaltet, immer tenantweit.
 */
export const ACCESS_LEVEL_KEYS = ['viewer', 'reader', 'editor', 'manager'] as const;
export const VAULT_PERMISSIONS = ['vault.view', 'vault.reveal', 'vault.edit', 'vault.manage'] as const;

export const isAccessRole = (r: { permissions: string[] }) => r.permissions.length > 0 && r.permissions.every((p) => p.startsWith('vault.'));
export const isAdminRole = (r: { permissions: string[] }) => r.permissions.some((p) => p.startsWith('tenant.'));
/** Eigene Rollen aus der Zeit vor der Trennung, die Tresorrechte enthalten (funktionieren weiter, neue gibt es nicht mehr). */
export const isLegacyRole = (r: Role) => !r.isSystem && r.permissions.some((p) => p.startsWith('vault.'));

/** Zugriffsstufen in aufsteigender Reihenfolge: eingebaute Stufen, danach ältere eigene Rollen mit nur Tresorrechten. */
export function accessLevels(roles: Role[] | undefined): Role[] {
  const all = roles ?? [];
  const builtin = ACCESS_LEVEL_KEYS.map((k) => all.find((r) => r.key === k)).filter((r): r is Role => !!r);
  return [...builtin, ...all.filter((r) => !r.isSystem && isAccessRole(r))];
}

export const adminRoles = (roles: Role[] | undefined) => (roles ?? []).filter(isAdminRole);

/** Höchstes enthaltenes Tresorrecht (die Stufen schließen die darunter ein). */
export function topVaultPermission(permissions: string[]) {
  return [...VAULT_PERMISSIONS].reverse().find((p) => permissions.includes(p));
}

/** Kurzbeschreibung einer Zugriffsstufe bzw. Rolle. */
export function roleHint(t: TFunction, role: { key: string | null; description?: string }) {
  return role.key ? t(`builtinRoleHint.${role.key}`, { defaultValue: role.description ?? '' }) : (role.description ?? '');
}

/** Auswahl einer Zugriffsstufe als Kacheln (mit Kurzbeschreibung), statt eines Dropdowns. */
export function AccessLevelPicker({ roles, value, onChange }: { roles: Role[]; value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
      {roles.map((r) => {
        const selected = r.id === value;
        return (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(r.id)}
            className={`rounded-md border p-3 text-left text-sm transition ${selected ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300'}`}
          >
            <span className="block font-medium text-slate-900">{roleLabel(t, r)}</span>
            <span className="block text-xs text-slate-500">{roleHint(t, r)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Auswahl des Bereichs einer Zugriffsstufe: alle Abteilungen, eine Abteilung oder ein Ordner. */
export function AccessScopeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const structure = useAdminStructure();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="TENANT">{t('scope.allDepartments')}</option>
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
  );
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
