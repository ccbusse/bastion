import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { organizationCodeMatches, tenantFingerprint } from '../lib/crypto/trust';
import { useUnlocked } from '../state/session';
import { loadTrust, MaintenanceResult, pinTrust } from '../state/vault';
import { Alert, Button, ErrorAlert, Field, Input, Modal } from './ui';

/**
 * Hinweis, wenn für den aktiven Tenant noch kein Vertrauensanker festgehalten ist (z. B. nach dem Beitritt eines
 * System-Admins oder bei Konten aus der Zeit vor der Beglaubigung) oder der Server abweichende Tenant-Schlüssel meldet.
 * Ohne Anker verteilt der Client keine Schlüssel und hinterlegt nichts für die Wiederherstellung.
 */
export function TrustAnchorBanner({ state, onPinned }: { state: MaintenanceResult | null; onPinned: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (state?.anchorMismatch) {
    return (
      <Alert kind="error" title={t('trust.mismatchTitle')} className="m-4 mb-0">
        {t('trust.mismatchText')}
      </Alert>
    );
  }
  // Ordnerschlüssel ohne gültigen Herkunftsnachweis werden nicht verwendet (möglicherweise untergeschoben)
  if (state && !state.needsAnchor && state.untrustedKeys > 0) {
    return (
      <Alert kind="error" title={t('trust.untrustedKeysTitle', { count: state.untrustedKeys })} className="m-4 mb-0">
        {t('trust.untrustedKeysText')}
      </Alert>
    );
  }
  if (!state?.needsAnchor || !state.trust?.server.signingPublicKey || !state.trust.server.recoveryPublicKey) return null;
  const server = { signingPublicKey: state.trust.server.signingPublicKey, recoveryPublicKey: state.trust.server.recoveryPublicKey };
  return (
    <>
      <Alert kind="warning" title={t('trust.pinTitle')} className="m-4 mb-0">
        <p>{t('trust.pinText')}</p>
        <Button size="sm" variant="gold" className="mt-2" onClick={() => setOpen(true)}>
          {t('trust.pinButton')}
        </Button>
      </Alert>
      {open && (
        <PinModal
          anchor={server}
          onClose={() => setOpen(false)}
          onPinned={() => {
            setOpen(false);
            onPinned();
          }}
        />
      )}
    </>
  );
}

function PinModal({ anchor, onClose, onPinned }: { anchor: { signingPublicKey: string; recoveryPublicKey: string }; onClose: () => void; onPinned: () => void }) {
  const { t } = useTranslation();
  const { info, keys } = useUnlocked();
  const fp = useQuery({ queryKey: ['tenant-fingerprint', anchor.signingPublicKey, anchor.recoveryPublicKey], queryFn: () => tenantFingerprint(anchor) });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={t('trust.pinTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!code.trim() || !fp.data}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                // Erst vertrauen, wenn der Code der Administration zu den gemeldeten Schlüsseln passt
                if (!(await organizationCodeMatches(anchor, code))) throw new Error('ORGANIZATION_CODE_MISMATCH');
                await pinTrust(info, keys, anchor);
                onPinned();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('trust.pinConfirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-600">
        <ErrorAlert error={error} />
        <p>{t('trust.pinExplain', { tenant: info.tenant?.name ?? '' })}</p>
        <Field label={t('invite.organizationCode')} hint={t('trust.pinCodeHint')}>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" className="font-mono uppercase" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
    </Modal>
  );
}

/** Fingerprint der Tenant-Schlüssel aus dem eigenen Vertrauensanker (zum Vorlesen beim Abgleich); null = kein Anker. */
export function useOwnTenantFingerprint() {
  const { info, keys } = useUnlocked();
  return useQuery({
    queryKey: ['own-tenant-fingerprint', info.tenant?.id],
    enabled: !!info.tenant,
    queryFn: async () => {
      const trust = await loadTrust(info, keys);
      return trust?.anchor ? tenantFingerprint(trust.anchor) : null;
    },
  });
}
