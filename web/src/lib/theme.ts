import { useSyncExternalStore } from 'react';

/** Tag-/Nachtmodus: Auswahl wird lokal gespeichert, ohne Auswahl gilt die Systemeinstellung. */
export type Theme = 'light' | 'dark';

const KEY = 'bastion.theme';
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let current: Theme = stored() ?? system();

function apply() {
  document.documentElement.classList.toggle('dark', current === 'dark');
}

export function initTheme() {
  apply();
  // Systemwechsel übernehmen, solange keine eigene Auswahl gespeichert ist
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (stored()) return;
    current = system();
    apply();
    listeners.forEach((l) => l());
  });
}

export function setTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Speicher nicht verfügbar */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
