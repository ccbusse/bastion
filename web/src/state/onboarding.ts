import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { get, post } from '../lib/api';

export type StepState = 'done' | 'open' | 'waiting';
export type GroupId = 'basics' | 'tenantAdmin' | 'systemAdmin';

export interface ChecklistResponse {
  groups: { id: GroupId; steps: { id: string; state: StepState }[] }[];
  hiddenAt: string | null;
}

/** Wohin ein Schritt führt: Seite zum Erledigen und passende Anleitung. */
export const STEP_LINKS: Record<string, { to: string; article: string }> = {
  mfa: { to: '/account', article: 'account-security' },
  firstItem: { to: '/vault', article: 'items' },
  extension: { to: '/tools/extension', article: 'extension' },
  structure: { to: '/admin/structure', article: 'structure' },
  invite: { to: '/admin/users', article: 'users' },
  tenantMfa: { to: '/admin/settings', article: 'tenant-settings' },
  emergencyApproval: { to: '/admin/settings', article: 'tenant-emergency' },
  secondAdmin: { to: '/system/admins', article: 'system-setup' },
  systemMfa: { to: '/system/settings', article: 'system-setup' },
  smtp: { to: '/system/settings?tab=smtp', article: 'system-setup' },
  tenant: { to: '/system/tenants', article: 'system-setup' },
  emergencyKey: { to: '/system/emergency', article: 'emergency-backup' },
  emergencyAuto: { to: '/system/emergency', article: 'emergency-auto' },
  dbBackup: { to: '/system/settings', article: 'db-backup' },
};

export function useChecklist() {
  return useQuery({ queryKey: ['onboarding-checklist'], queryFn: () => get<ChecklistResponse>('/onboarding/checklist') });
}

export function checklistProgress(data: ChecklistResponse | undefined) {
  const steps = data?.groups.flatMap((g) => g.steps) ?? [];
  return { done: steps.filter((s) => s.state === 'done').length, total: steps.length };
}

export const setOnboarding = (body: { tourCompleted?: boolean; checklistHidden?: boolean }) => post('/onboarding', body);

/** Kurztour von überall starten (z. B. aus der Hilfe). Bereitgestellt vom Layout. */
export const TourContext = createContext<{ startTour: () => void }>({ startTour: () => undefined });

export const useTour = () => useContext(TourContext);
