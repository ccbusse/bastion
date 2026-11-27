import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  Folder,
  FolderLock,
  KeyRound,
  Layers,
  Trash2,
  Loader2,
  Lock,
  LogOut,
  Menu,
  Puzzle,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  User,
  UserCog,
  Users,
  Vault,
  Wand2,
  LifeBuoy,
  CircleHelp,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { post } from '../lib/api';
import { ReauthHost } from './ReauthHost';
import { useCan, useUnlocked } from '../state/session';
import { checklistProgress, setOnboarding, TourContext, useChecklist } from '../state/onboarding';
import { Tour } from './Tour';
import { MaintenanceResult, runKeyMaintenance, useStructure } from '../state/vault';
import { TrustAnchorBanner } from './TrustAnchor';
import { RotationNotice } from './RotationNotice';
import { LanguageSwitch } from './LanguageSwitch';
import { ThemeToggle } from './ThemeToggle';
import { useTheme } from '../lib/theme';
import { Logo } from './Logo';
import type { FolderInfo } from '../lib/types';
import { cx, useErrorMessage } from './ui';

function NavItem({ to, icon, children, active, indent, tour }: { to: string; icon: ReactNode; children: ReactNode; active?: boolean; indent?: boolean; tour?: string }) {
  return (
    <NavLink
      to={to}
      data-tour={tour}
      className={({ isActive }) =>
        cx(
          'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
          indent && 'pl-7',
          (active ?? isActive) ? 'bg-white/10 font-medium text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white',
        )
      }
      end
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="truncate">{children}</span>
    </NavLink>
  );
}

/** Aufklappbarer Ordnerbaum einer Abteilung. Unterordner sind eingeklappt, außer auf dem Weg zum aktuellen Ordner. */
function FolderNav({ folders, current }: { folders: FolderInfo[]; current: string | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const ic = 'h-4 w-4';
  const byId = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const withChildren = useMemo(() => new Set(folders.map((f) => f.parentId).filter(Boolean)), [folders]);
  const onPath = useMemo(() => {
    const s = new Set<string>();
    for (let id = current ? (byId.get(current)?.parentId ?? null) : null; id; id = byId.get(id)?.parentId ?? null) s.add(id);
    return s;
  }, [byId, current]);
  const isOpen = (id: string) => open[id] ?? onPath.has(id);
  const shown = folders.filter((f) => {
    for (let p = f.parentId; p; p = byId.get(p)?.parentId ?? null) if (!isOpen(p)) return false;
    return true;
  });
  return (
    <>
      {shown.map((f) => {
        const canView = f.permissions.includes('vault.view');
        const label = (
          <>
            <span className="shrink-0 opacity-80">{f.hasKey ? <Folder className={ic} /> : <FolderLock className={ic} />}</span>
            <span className="truncate">{f.name}</span>
          </>
        );
        return (
          <div key={f.id} className="flex items-center" style={{ paddingLeft: `${f.depth * 14}px` }}>
            {withChildren.has(f.id) ? (
              <button
                type="button"
                aria-label={f.name}
                aria-expanded={isOpen(f.id)}
                onClick={() => setOpen((o) => ({ ...o, [f.id]: !isOpen(f.id) }))}
                className="ml-1.5 shrink-0 rounded p-0.5 text-brand-300 hover:bg-white/10 hover:text-white"
              >
                {isOpen(f.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            ) : (
              <span className="ml-1.5 w-[18px] shrink-0" />
            )}
            {canView ? (
              <NavLink
                to={`/vault?f=${f.id}`}
                onClick={() => withChildren.has(f.id) && setOpen((o) => ({ ...o, [f.id]: true }))}
                className={cx(
                  'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm transition-colors',
                  current === f.id ? 'bg-white/10 font-medium text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white',
                )}
                end
              >
                {label}
              </NavLink>
            ) : (
              <span
                onClick={() => withChildren.has(f.id) && setOpen((o) => ({ ...o, [f.id]: true }))}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-1.5 py-1.5 text-sm text-brand-400"
              >
                {label}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Aktueller Tenant, gut sichtbar unter dem Logo; System-Admins wechseln hier zwischen ihren Tenants. */
function TenantSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const { info, refresh } = useUnlocked();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errMsg = useErrorMessage();
  const ref = useRef<HTMLDivElement>(null);
  const isSystemAdmin = info.permissions.isSystemAdmin;
  const canOpen = isSystemAdmin || info.tenants.length > 1;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const switchTo = async (id: string) => {
    setOpen(false);
    if (id === info.tenant?.id) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/system/tenants/${id}/switch`, {});
      await refresh();
      qc.clear();
      onNavigate();
      navigate('/vault');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!info.tenant && !isSystemAdmin) return null;
  return (
    <div ref={ref} className="relative mt-4">
      <button
        type="button"
        disabled={!canOpen || busy}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cx(
          'flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-left transition-colors',
          canOpen && 'hover:border-white/20 hover:bg-white/10',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-brand-400">{t('nav.tenant')}</span>
          <span className={cx('block truncate text-base font-semibold', info.tenant ? 'text-white' : 'italic text-brand-300')}>{info.tenant?.name ?? t('nav.noTenant')}</span>
        </span>
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-300" /> : canOpen && <ChevronsUpDown className="h-4 w-4 shrink-0 text-brand-300" />}
      </button>
      {error != null && <p className="mt-1 text-xs text-red-300">{errMsg(error)}</p>}
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-lg border border-white/10 bg-brand-900 py-1 shadow-xl" role="listbox">
          <div className="max-h-72 overflow-y-auto">
            {info.tenants.map((x) => (
              <button
                key={x.id}
                type="button"
                role="option"
                aria-selected={x.id === info.tenant?.id}
                onClick={() => void switchTo(x.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-brand-100 hover:bg-white/10 hover:text-white"
              >
                <Check className={cx('h-4 w-4 shrink-0', x.id === info.tenant?.id ? 'text-gold-400' : 'invisible')} />
                <span className="truncate">{x.name}</span>
              </button>
            ))}
            {!info.tenants.length && <p className="px-3 py-2 text-sm text-brand-300">{t('nav.noTenantsYet')}</p>}
          </div>
          {isSystemAdmin && (
            <>
              <div className="my-1 border-t border-white/10" />
              <NavLink
                to="/system/tenants"
                onClick={() => {
                  setOpen(false);
                  onNavigate();
                }}
                className="flex items-center gap-2 px-3 py-2 text-sm text-brand-100 hover:bg-white/10 hover:text-white"
              >
                <Vault className="h-4 w-4 shrink-0 text-gold-400" />
                <span className="flex-1">{t('nav.manageTenants')}</span>
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-gold-400" aria-label={t('nav.systemAdminsOnly')} />
              </NavLink>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Menübereich. Bereiche, die normale Benutzer nicht sehen, sind gekennzeichnet:
 * "admin" (Verwaltung, nur Admins) dezent blau, "system" (nur System-Admins) gold mit Schild.
 */
function Section({ title, children, tone = 'default', note, first, tour }: { title: string; children: ReactNode; tone?: 'default' | 'admin' | 'system'; note?: string; first?: boolean; tour?: string }) {
  return (
    <div data-tour={tour} className={cx('space-y-0.5', !first && 'mt-3 border-t border-white/10 pt-1')}>
      <p
        className={cx(
          'flex items-baseline gap-1.5 px-2.5 pb-1.5 pt-3 text-[13px] font-bold uppercase tracking-wider',
          tone === 'system' ? 'text-gold-400' : tone === 'admin' ? 'text-sky-300' : 'text-brand-100',
        )}
      >
        {tone === 'system' && <ShieldCheck className="h-3.5 w-3.5 shrink-0 self-center" />}
        <span>{title}</span>
        {note && <span className={cx('truncate text-[11px] font-medium normal-case tracking-normal', tone === 'system' ? 'text-gold-300/80' : 'text-sky-300/70')}>· {note}</span>}
      </p>
      {children}
    </div>
  );
}

function VaultNav() {
  const { t } = useTranslation();
  const { info } = useUnlocked();
  const structure = useStructure();
  const [params] = useSearchParams();
  const location = useLocation();
  const current = location.pathname === '/vault' ? (params.get('f') ?? 'all') : null;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const ic = 'h-4 w-4';
  return (
    <Section title={t('nav.vault')} first tour="nav-vault">
      <NavItem to="/vault" icon={<Layers className={ic} />} active={current === 'all'}>
        {t('nav.allItems')}
      </NavItem>
      <NavItem to="/vault?f=personal" icon={<User className={ic} />} active={current === 'personal'}>
        {t('nav.personal')}
      </NavItem>
      <NavItem to="/trash" icon={<Trash2 className={ic} />}>
        {t('nav.trash')}
      </NavItem>
      {info.tenant && !!structure.data?.departments.length && (
        <>
          <p className="mx-1 mt-3 border-t border-white/10 px-1.5 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-brand-400">{t('nav.departments')}</p>
          <div className="space-y-1.5">
            {structure.data.departments.map((d) => {
              // Eingeklappt, außer der aktuell gewählte Ordner liegt in dieser Abteilung
              const expanded = open[d.id] ?? d.folders.some((f) => f.id === current);
              return (
                <div key={d.id} className="mx-0.5 rounded-lg bg-white/[0.04] p-0.5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen((o) => ({ ...o, [d.id]: !expanded }))}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-white hover:bg-white/5"
                  >
                    <Building2 className={cx(ic, 'shrink-0 text-brand-300')} />
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-brand-300" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-brand-300" />}
                  </button>
                  {expanded && (
                    <div className="pb-1 pl-3">
                      {d.folders.length ? <FolderNav folders={d.folders} current={current} /> : <p className="px-2 py-1 text-xs text-brand-400">{t('structure.noFolders')}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Section>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { info, keys, lock, logout, refresh } = useUnlocked();
  const can = useCan();
  const qc = useQueryClient();

  // Schlüsselpflege nach dem Entsperren (Tenant-Init, Vertrauensanker, Recovery-Hinterlegung, Schlüsselverteilung)
  const [maintenance, setMaintenance] = useState<MaintenanceResult | null>(null);
  const [maintenanceRun, setMaintenanceRun] = useState(0);
  const [showRotation, setShowRotation] = useState(true);
  useEffect(() => {
    let alive = true;
    runKeyMaintenance(info, keys)
      .then(async (result) => {
        if (!alive) return;
        setMaintenance(result);
        setShowRotation(true);
        await refresh();
        await qc.invalidateQueries();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, maintenanceRun, info.tenant?.id]);
  const [open, setOpen] = useState(false);
  const structure = useStructure();

  // Einführung: Checkliste (Fortschritt im Menü) und Kurztour beim ersten Öffnen
  const checklist = useChecklist();
  const progress = checklistProgress(checklist.data);
  const checklistOpen = !!checklist.data && !checklist.data.hiddenAt && progress.done < progress.total;
  const [tour, setTour] = useState(() => !!info.onboarding && !info.onboarding.tourCompletedAt);
  const startTour = useCallback(() => {
    setOpen(false);
    setTour(true);
  }, []);
  const closeTour = useCallback(async () => {
    setTour(false);
    try {
      await setOnboarding({ tourCompleted: true });
      await refresh();
    } catch {
      /* nicht kritisch: dann erscheint die Tour beim nächsten Mal erneut */
    }
  }, [refresh]);
  const tourValue = useMemo(() => ({ startTour }), [startTour]);
  const ic = 'h-4 w-4';
  const sysIc = 'h-4 w-4 text-gold-400';
  const tenantAdminNav =
    info.tenant &&
    (can('tenant.users.invite') || can('tenant.users.confirm') || can('tenant.users.manage') || can('tenant.roles.manage') || can('tenant.structure.manage') || can('tenant.audit.read') || can('tenant.settings.manage') || structure.data?.departments.some((d) => d.canManage));

  const sidebar = (
    <aside className="theme-fixed flex h-full w-64 flex-col bg-brand-950 text-white">
      <div className="px-4 py-4">
        <Logo dark />
        <TenantSwitcher onNavigate={() => setOpen(false)} />
      </div>
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-4" onClick={() => setOpen(false)}>
        <VaultNav />
        <Section title={t('nav.tools')} tour="nav-tools">
          <NavItem to="/tools/generator" icon={<Wand2 className={ic} />}>
            {t('nav.generator')}
          </NavItem>
          {/* System-Admins finden Sicherheitsbericht und Import/Export in den Systemeinstellungen */}
          {!info.permissions.isSystemAdmin && (
            <>
              <NavItem to="/tools/report" icon={<ShieldCheck className={ic} />}>
                {t('nav.report')}
              </NavItem>
              <NavItem to="/tools/transfer" icon={<Upload className={ic} />}>
                {t('nav.transfer')}
              </NavItem>
            </>
          )}
          <NavItem to="/tools/extension" icon={<Puzzle className={ic} />}>
            {t('nav.extension')}
          </NavItem>
        </Section>
        {tenantAdminNav && (
          <Section title={t('nav.admin')} tone="admin" note={t('nav.adminsOnly')} tour="nav-admin">
            {(can('tenant.users.invite') || can('tenant.users.confirm') || can('tenant.users.manage') || can('tenant.roles.manage')) && (
              <NavItem to="/admin/users" icon={<Users className={ic} />}>
                {t('nav.users')}
              </NavItem>
            )}
            {(can('tenant.structure.manage') || structure.data?.departments.some((d) => d.canManage)) && (
              <NavItem to="/admin/structure" icon={<Building2 className={ic} />}>
                {t('nav.structure')}
              </NavItem>
            )}
            {can('tenant.roles.manage') && (
              <NavItem to="/admin/roles" icon={<KeyRound className={ic} />}>
                {t('nav.roles')}
              </NavItem>
            )}
            {can('tenant.audit.read') && (
              <NavItem to="/admin/audit" icon={<ClipboardList className={ic} />}>
                {t('nav.audit')}
              </NavItem>
            )}
            {can('tenant.settings.manage') && (
              <NavItem to="/admin/settings" icon={<SlidersHorizontal className={ic} />}>
                {t('nav.tenantSettings')}
              </NavItem>
            )}
          </Section>
        )}
        {info.permissions.isSystemAdmin && (
          <Section title={t('nav.system')} tone="system" note={t('nav.systemAdminsOnly')} tour="nav-system">
            <NavItem to="/system/admins" icon={<UserCog className={sysIc} />}>
              {t('nav.systemAdmins')}
            </NavItem>
            <NavItem to="/system/settings" icon={<Settings className={sysIc} />}>
              {t('nav.systemSettings')}
            </NavItem>
            <NavItem to="/system/emergency" icon={<LifeBuoy className={sysIc} />} tour="nav-emergency">
              {t('nav.emergency')}
            </NavItem>
            <NavItem to="/system/audit" icon={<ClipboardList className={sysIc} />}>
              {t('nav.audit')}
            </NavItem>
          </Section>
        )}
      </nav>
      <div className="border-t border-white/10 p-3">
        <NavLink
          to="/help"
          data-tour="nav-help"
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx('mb-1 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors', isActive ? 'bg-white/10 font-medium text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white')
          }
        >
          <CircleHelp className="h-4 w-4 shrink-0 opacity-80" />
          <span className="flex-1 truncate">{t('nav.help')}</span>
          {checklistOpen && (
            <span className="rounded-full bg-gold-500/20 px-1.5 py-0.5 text-[11px] font-semibold text-gold-300" title={t('checklist.progress', progress)}>
              {progress.done}/{progress.total}
            </span>
          )}
        </NavLink>
        <NavLink to="/account" data-tour="nav-account" onClick={() => setOpen(false)} className="block rounded-md px-2 py-1.5 hover:bg-white/5">
          <p className="truncate text-sm font-medium">{info.user.name || info.user.email}</p>
          <p className="truncate text-xs text-brand-300">{info.user.email}</p>
        </NavLink>
        <div className="mt-2 flex items-center justify-between gap-1">
          <div className="flex items-center gap-2">
            <LanguageSwitch dark persist />
            <ThemeToggle />
          </div>
          <div className="flex">
            <button type="button" title={t('nav.lock')} onClick={lock} className="rounded-md p-1.5 text-brand-200 hover:bg-white/10 hover:text-white">
              <Lock className="h-4 w-4" />
            </button>
            <button type="button" title={t('nav.logout')} onClick={() => void logout()} className="rounded-md p-1.5 text-brand-200 hover:bg-white/10 hover:text-white">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-2 px-2 text-[11px] tracking-wide text-brand-400">Bastion v{__APP_VERSION__}</p>
      </div>
    </aside>
  );

  return (
    <TourContext.Provider value={tourValue}>
      <div className="flex h-full">
        {tour && <Tour onClose={closeTour} />}
        <div className="hidden md:block">{sidebar}</div>
        {open && (
          <div className="fixed inset-0 z-40 flex md:hidden">
            {sidebar}
            <div className="flex-1 bg-black/40" onClick={() => setOpen(false)} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 md:hidden">
            <button type="button" onClick={() => setOpen(true)} className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" aria-label="Menu">
              <Menu className="h-5 w-5" />
            </button>
            <Logo dark={theme === 'dark'} />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <TrustAnchorBanner state={maintenance} onPinned={() => setMaintenanceRun((n) => n + 1)} />
            {showRotation && <RotationNotice result={maintenance?.rotation} onClose={() => setShowRotation(false)} className="m-4 mb-0" />}
            <Outlet />
          </main>
          <ReauthHost />
        </div>
      </div>
    </TourContext.Provider>
  );
}
