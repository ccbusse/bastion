import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { post, setReauthHandler } from '../lib/api';
import { ReauthModal } from '../pages/settings/AccountPage';

/**
 * Fragt das Masterpasswort ab, wenn der Server für eine kritische Aktion eine erneute Bestätigung verlangt
 * (403 REAUTH_REQUIRED, siehe lib/api.ts). Nach der Bestätigung wiederholt der API-Client die Anfrage.
 */
export function ReauthHost() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setOpen(true);
        }),
    );
    return () => {
      setReauthHandler(null);
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  const finish = (confirmed: boolean) => {
    setOpen(false);
    resolver.current?.(confirmed);
    resolver.current = null;
  };

  if (!open) return null;
  return (
    <ReauthModal
      title={t('account.reauthTitle')}
      onClose={() => finish(false)}
      onConfirm={async (authHash) => {
        await post('/auth/verify', { authHash });
        finish(true);
      }}
    >
      <p className="text-sm text-slate-600">{t('account.reauthText')}</p>
    </ReauthModal>
  );
}
