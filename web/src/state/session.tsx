import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, get, post } from '../lib/api';
import type { VaultKeys } from '../lib/crypto/account';
import { wipe } from '../lib/crypto/encoding';
import type { SessionInfo } from '../lib/types';

interface SessionCtx {
  status: 'loading' | 'anonymous' | 'authenticated';
  info: SessionInfo | null;
  /** Entschlüsselte Schlüssel – nur im Arbeitsspeicher, nie persistiert. null = gesperrt */
  keys: VaultKeys | null;
  refresh: () => Promise<SessionInfo | null>;
  setKeys: (k: VaultKeys | null) => void;
  lock: () => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionCtx['status']>('loading');
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [keys, setKeysState] = useState<VaultKeys | null>(null);
  const keysRef = useRef<VaultKeys | null>(null);
  const qc = useQueryClient();
  const { i18n } = useTranslation();

  const setKeys = useCallback((k: VaultKeys | null) => {
    if (keysRef.current && keysRef.current !== k) wipe(keysRef.current.accountKeyRaw, keysRef.current.personalKeyRaw);
    keysRef.current = k;
    setKeysState(k);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await get<SessionInfo>('/auth/session');
      setInfo(s);
      setStatus('authenticated');
      if (s.user.locale && s.user.locale !== i18n.language && !localStorage.getItem('bastion.lang')) void i18n.changeLanguage(s.user.locale);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setInfo(null);
        setKeys(null);
        setStatus('anonymous');
        return null;
      }
      throw e;
    }
  }, [i18n, setKeys]);

  const lock = useCallback(() => {
    setKeys(null);
    qc.removeQueries();
  }, [qc, setKeys]);

  const logout = useCallback(async () => {
    await post('/auth/logout').catch(() => undefined);
    setKeys(null);
    qc.removeQueries();
    setInfo(null);
    setStatus('anonymous');
  }, [qc, setKeys]);

  useEffect(() => {
    refresh().catch(() => setStatus('anonymous'));
    const onUnauthorized = () => {
      setKeys(null);
      qc.removeQueries();
      setInfo(null);
      setStatus('anonymous');
    };
    window.addEventListener('bastion:unauthorized', onUnauthorized);
    return () => window.removeEventListener('bastion:unauthorized', onUnauthorized);
  }, [refresh, qc, setKeys]);

  // Automatische Sperre bei Inaktivität
  const autoLockMinutes = info?.session.autoLockMinutes ?? 15;
  useEffect(() => {
    if (!keys) return;
    let timer = window.setTimeout(lock, autoLockMinutes * 60_000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, autoLockMinutes * 60_000);
    };
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [keys, autoLockMinutes, lock]);

  const value = useMemo(() => ({ status, info, keys, refresh, setKeys, lock, logout }), [status, info, keys, refresh, setKeys, lock, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}

/** Für Seiten innerhalb des entsperrten Bereichs. */
export function useUnlocked() {
  const s = useSession();
  if (!s.info || !s.keys) throw new Error('Vault locked');
  return { ...s, info: s.info, keys: s.keys };
}

export function useCan() {
  const { info } = useSession();
  return useCallback((perm: string) => !!info && (info.permissions.isTenantAdmin || info.permissions.tenant.includes(perm)), [info]);
}
