import { useCallback, useEffect, useState } from 'react';
import type { VaultKeys } from '../../../web/src/lib/crypto/account';
import type { SessionInfo } from '../../../web/src/lib/types';
import { currentState, loadKeys, lock, logout, sessionInfo, type VaultState } from '../lib/vault';
import { LoginScreen, SetupScreen, UnlockScreen } from './AuthScreens';
import { errorText, t } from './i18n';
import { Button, ErrorBox, Hero } from './ui';
import { VaultScreen } from './VaultScreen';

type View = { kind: 'loading' } | { kind: VaultState } | { kind: 'ready'; info: SessionInfo; keys: VaultKeys } | { kind: 'restricted' } | { kind: 'error'; message: string };

export function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const state = await currentState();
      if (state !== 'unlocked') return setView({ kind: state });
      const info = await sessionInfo();
      const r = info.restrictions;
      if (r.forcePasswordChange || r.pendingConfirmation || r.mfaSetupRequired) return setView({ kind: 'restricted' });
      const keys = await loadKeys(info);
      setView(keys ? { kind: 'ready', info, keys } : { kind: 'locked' });
    } catch (e) {
      // Sitzung abgelaufen oder widerrufen: Zustand neu bestimmen (führt zur Anmeldung)
      const state = await currentState().catch(() => 'login' as VaultState);
      setView(state === 'unlocked' ? { kind: 'error', message: errorText(e) } : { kind: state });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  switch (view.kind) {
    case 'loading':
      return <Hero />;
    case 'setup':
      return <SetupScreen onDone={refresh} />;
    case 'login':
      return <LoginScreen onDone={refresh} onChangeVault={() => setView({ kind: 'setup' })} />;
    case 'mfa':
      // MFA ohne den EncKey im Speicher (Popup war geschlossen): Anmeldung neu beginnen
      return <LoginScreen onDone={refresh} onChangeVault={() => setView({ kind: 'setup' })} />;
    case 'locked':
      return <UnlockScreen onDone={refresh} onLogout={refresh} />;
    case 'ready':
      return (
        <VaultScreen
          info={view.info}
          keys={view.keys}
          onLock={async () => {
            await lock();
            await refresh();
          }}
          onLogout={async () => {
            await logout();
            await refresh();
          }}
        />
      );
    case 'restricted':
    case 'error':
      return (
        <div>
          <Hero />
          <div className="space-y-4 p-5">
            <ErrorBox>{view.kind === 'restricted' ? t.restricted : view.message}</ErrorBox>
            <Button
              variant="secondary"
              className="w-full"
              onClick={async () => {
                await logout();
                await refresh();
              }}
            >
              {t.logout}
            </Button>
          </div>
        </div>
      );
  }
}
