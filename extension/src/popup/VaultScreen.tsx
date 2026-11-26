import { ArrowLeft, Check, Copy, CreditCard, ExternalLink, Eye, EyeOff, FileText, Globe, KeyRound, Landmark, Lock, LogOut, Search, Terminal, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { VaultKeys } from '../../../web/src/lib/crypto/account';
import { ITEM_FIELDS, safeHref } from '../../../web/src/lib/items';
import { parseTotp, totpCode } from '../../../web/src/lib/totp';
import type { ItemType, SessionInfo, StructureInfo } from '../../../web/src/lib/types';
import { copySecret } from '../lib/clipboard';
import { fillTab } from '../lib/fill';
import { isFillableUrl, matchesPage } from '../lib/match';
import { getSession, getSettings, removeSession, setSession, setSettings, type SearchScope } from '../lib/storage';
import { loadVaultData, logEvent, switchTenant, type VaultItem } from '../lib/vault';
import { errorText, t } from './i18n';
import { Button, cx, ErrorBox, IconButton, LogoIcon } from './ui';

const typeIcons: Record<ItemType, typeof Globe> = { LOGIN: Globe, NOTE: FileText, CARD: CreditCard, BANK_ACCOUNT: Landmark, SSH_KEY: Terminal, API_KEY: KeyRound };

function subtitle(i: VaultItem) {
  const o = i.overview;
  return o.username || o.cardholder || o.bankName || o.host || o.service || i.location;
}

let lastTouch = 0;

/** Aktivität an den Service Worker melden (verlängert die automatische Sperre, gedrosselt). */
function touch() {
  const now = Date.now();
  if (now - lastTouch < 10_000) return;
  lastTouch = now;
  void chrome.runtime.sendMessage({ type: 'touch' }).catch(() => undefined);
}

function CopyField({ item, label, value, field, sensitive, mono }: { item: VaultItem; label: string; value: string; field: string; sensitive?: boolean; mono?: boolean }) {
  const [shown, setShown] = useState(!sensitive);
  const [done, setDone] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-white/5">
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="flex items-center gap-1">
        <p className={cx('min-w-0 flex-1 break-all text-sm text-slate-900 dark:text-slate-100', mono && 'font-mono', !shown && 'tracking-widest')}>{shown ? value : '••••••••••••'}</p>
        {sensitive && (
          <IconButton
            label={shown ? t.hide : t.show}
            onClick={() => {
              if (!shown) void logEvent(item, field);
              setShown((s) => !s);
            }}
          >
            {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </IconButton>
        )}
        <IconButton
          label={done ? t.copied : t.copy}
          onClick={async () => {
            await copySecret(value);
            void logEvent(item, field);
            touch();
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
        >
          {done ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </IconButton>
      </div>
    </div>
  );
}

function TotpField({ item, secret }: { item: VaultItem; secret: string }) {
  const cfg = useMemo(() => parseTotp(secret), [secret]);
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(30);
  useEffect(() => {
    if (!cfg) return;
    const tick = async () => {
      setCode(await totpCode(cfg));
      setLeft(cfg.period - (Math.floor(Date.now() / 1000) % cfg.period));
    };
    void tick();
    const id = setInterval(() => void tick(), 1000);
    return () => clearInterval(id);
  }, [cfg]);
  if (!cfg) return null;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <CopyField item={item} label={`${t.totp} · ${left}s`} value={code} field="totp" mono />
      </div>
    </div>
  );
}

function Detail({ item, tab, vaultUrl, onBack }: { item: VaultItem; tab?: chrome.tabs.Tab; vaultUrl: string; onBack: () => void }) {
  const Icon = typeIcons[item.type];
  const [message, setMessage] = useState('');
  const canFill = item.type === 'LOGIN' && !!item.secret?.password && !!tab?.url && matchesPage(item, tab.url);
  const href = safeHref(item.overview.url);
  return (
    <div className="flex min-h-[540px] flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-white/10">
        <IconButton label={t.back} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-white/10 dark:text-brand-200">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900 dark:text-white">{item.overview.name}</p>
          <p className="truncate text-[11px] text-slate-500">
            {t.types[item.type]} · {item.location}
          </p>
        </div>
      </div>
      <div className="scrollbar-thin flex-1 space-y-2 overflow-y-auto p-3">
        {message && <ErrorBox>{message}</ErrorBox>}
        {canFill && (
          <Button
            className="w-full"
            icon={<Wand2 className="h-4 w-4" />}
            onClick={async () => {
              const r = await fillTab(tab!, item.overview.username ?? '', item.secret!.password);
              if (r === 'filled') {
                await logEvent(item, 'autofill');
                window.close();
              } else setMessage(r === 'insecure' ? t.fillInsecure : r === 'origin-changed' ? t.fillChanged : t.fillNoForm);
            }}
          >
            {t.fill}
          </Button>
        )}
        {ITEM_FIELDS[item.type].map((f) => {
          const value = f.part === 'overview' ? item.overview[f.key] : item.secret?.[f.key];
          if (!value) return null;
          if (f.kind === 'totp') return <TotpField key={f.key} item={item} secret={value} />;
          return <CopyField key={f.key} item={item} label={t.fields[f.key] ?? f.key} value={value} field={f.key} sensitive={f.sensitive} mono={f.mono} />;
        })}
        {!item.secret && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">{t.noReveal}</p>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-3 py-2.5 dark:border-white/10">
        <span className="min-w-0 text-[11px] leading-snug text-slate-400">{t.readOnlyHint}</span>
        <div className="flex shrink-0 gap-1">
          {href && (
            <IconButton label={t.url} onClick={() => void chrome.tabs.create({ url: href })}>
              <Globe className="h-4 w-4" />
            </IconButton>
          )}
          <Button
            variant="secondary"
            className="whitespace-nowrap"
            icon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => void chrome.tabs.create({ url: `${vaultUrl}/vault?f=${item.personal ? 'personal' : item.folderId}&item=${item.id}` })}
          >
            {t.openInBastion}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ item, tab, onOpen, onError }: { item: VaultItem; tab?: chrome.tabs.Tab; onOpen: () => void; onError: (m: string) => void }) {
  const Icon = typeIcons[item.type];
  const fillable = item.type === 'LOGIN' && !!item.secret?.password && !!tab?.url && matchesPage(item, tab.url);
  return (
    <li className="group flex items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-white dark:hover:bg-white/5">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-white/10 dark:text-brand-200">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-900 dark:text-white">{item.overview.name}</span>
          <span className="block truncate text-xs text-slate-500">{subtitle(item)}</span>
        </span>
      </button>
      {fillable && (
        <Button
          variant="secondary"
          className="shrink-0"
          onClick={async () => {
            const r = await fillTab(tab!, item.overview.username ?? '', item.secret!.password);
            if (r === 'filled') {
              await logEvent(item, 'autofill');
              window.close();
            } else onError(r === 'insecure' ? t.fillInsecure : r === 'origin-changed' ? t.fillChanged : t.fillNoForm);
          }}
        >
          {t.fill}
        </Button>
      )}
    </li>
  );
}

/** Ordner-IDs eines Bereichs: ganze Abteilung oder ein Ordner samt aller Unterordner. */
function scopeFolders(structure: StructureInfo | null, dept: string, folder: string): Set<string> | null {
  if (!structure || !dept || dept === 'personal') return null;
  const d = structure.departments.find((x) => x.id === dept);
  if (!d) return null;
  if (!folder) return new Set(d.folders.map((f) => f.id));
  const out = new Set<string>([folder]);
  // Unterordner einschließen (Baum über parentId, Reihenfolge der Liste ist egal)
  for (let added = true; added; ) {
    added = false;
    for (const f of d.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) (out.add(f.id), (added = true));
  }
  return out;
}

const selectCls =
  'scope-select h-9 min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/10 px-2 text-[13px] text-white [color-scheme:dark] focus:border-gold-500 focus:outline-none disabled:opacity-40';

export function VaultScreen({
  info,
  keys,
  onLock,
  onLogout,
  onTenantSwitched,
}: {
  info: SessionInfo;
  keys: VaultKeys;
  onLock: () => void;
  onLogout: () => void;
  onTenantSwitched: () => void;
}) {
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [selected, setSelected] = useState<VaultItem | null>(null);
  const [vaultUrl, setVaultUrl] = useState('');
  const [structure, setStructure] = useState<StructureInfo | null>(null);
  // Suchbereich: dept "" = alle, "personal" = persönlicher Tresor, sonst Abteilung; folder "" = ganze Abteilung
  const [scope, setScope] = useState({ dept: '', folder: '' });
  const [switching, setSwitching] = useState(false);

  // Jede Bedienung im Popup verlängert die automatische Sperre
  useEffect(() => {
    document.addEventListener('pointerdown', touch, { passive: true });
    document.addEventListener('keydown', touch, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', touch);
      document.removeEventListener('keydown', touch);
    };
  }, []);

  useEffect(() => {
    touch();
    void getSettings().then((s) => setVaultUrl(s.vaultUrl ?? ''));
    // Die URL des aktiven Tabs ist durch activeTab nur nach dem Öffnen des Popups bekannt
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t));
    // Suche und geöffneten Eintrag aus dem Sitzungsspeicher übernehmen (überstehen das Schließen des Popups)
    void getSession().then((s) => s.popupQuery && setQuery(s.popupQuery));
    Promise.all([loadVaultData(info, keys, t.personal), getSettings(), getSession()])
      .then(([data, settings, session]) => {
        setItems(data.items);
        setStructure(data.structure);
        const open = session.popupSelected && data.items.find((i) => i.id === session.popupSelected);
        if (open) setSelected(open);
        else if (session.popupSelected) void removeSession(['popupSelected']);
        // Gemerkte Auswahl nur übernehmen, wenn sie zu diesem Tenant gehört und noch existiert
        const saved = settings.scope;
        const tenantId = info.tenant?.id ?? null;
        if (saved && saved.tenantId === tenantId) {
          const d = data.structure.departments.find((x) => x.id === saved.dept);
          if (saved.dept === 'personal') setScope({ dept: 'personal', folder: '' });
          else if (d) setScope({ dept: d.id, folder: d.folders.some((f) => f.id === saved.folder) ? saved.folder : '' });
        }
      })
      .catch((e) => setError(errorText(e)));
  }, [info, keys]);

  const changeQuery = (q: string) => {
    setQuery(q);
    void (q ? setSession({ popupQuery: q }) : removeSession(['popupQuery']));
  };
  const openItem = (i: VaultItem | null) => {
    setSelected(i);
    void (i ? setSession({ popupSelected: i.id }) : removeSession(['popupSelected']));
  };
  const changeTenant = async (id: string) => {
    if (id === info.tenant?.id) return;
    setSwitching(true);
    setError('');
    try {
      await switchTenant(id);
      onTenantSwitched();
    } catch (e) {
      setError(errorText(e));
      setSwitching(false);
    }
  };
  const canSwitchTenant = info.permissions.isSystemAdmin && info.tenants.length > 1;

  const changeScope = (next: { dept: string; folder: string }) => {
    setScope(next);
    const value: SearchScope = { tenantId: info.tenant?.id ?? null, ...next };
    void setSettings({ scope: value });
    touch();
  };
  const allowedFolders = useMemo(() => scopeFolders(structure, scope.dept, scope.folder), [structure, scope]);
  const currentDept = structure?.departments.find((d) => d.id === scope.dept);
  const scopeLabel =
    scope.dept === 'personal'
      ? t.personal
      : currentDept
        ? scope.folder
          ? `${currentDept.name} / ${currentDept.folders.find((f) => f.id === scope.folder)?.path ?? ''}`
          : currentDept.name
        : t.allItems;

  // Der Bereich gilt nur für die Liste und die Suche; "Für diese Seite" bietet immer alle passenden Anmeldedaten an
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inScope = (i: VaultItem) => (scope.dept === 'personal' ? i.personal : allowedFolders ? !i.personal && allowedFolders.has(i.folderId ?? '') : true);
    return (items ?? []).filter(inScope).filter((i) => !q || [i.overview.name, i.overview.username, i.overview.url, i.overview.service, i.overview.host, i.location].some((v) => v?.toLowerCase().includes(q)));
  }, [items, query, scope.dept, allowedFolders]);
  const forPage = useMemo(() => (tab?.url && isFillableUrl(tab.url) ? (items ?? []).filter((i) => matchesPage(i, tab.url!)) : []), [items, tab]);

  if (selected) return <Detail item={selected} tab={tab} vaultUrl={vaultUrl} onBack={() => openItem(null)} />;

  return (
    <div className="flex h-[540px] flex-col">
      <div className="bg-[radial-gradient(120%_140%_at_20%_0%,#26345e_0%,#111831_60%,#070b17_100%)] px-3 pb-3 pt-3 text-white">
        <div className="flex items-center gap-2">
          <LogoIcon className="h-6 w-6" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-extrabold tracking-[0.28em]">BASTION</p>
            {canSwitchTenant ? (
              <select
                aria-label={t.switchTenant}
                title={t.switchTenant}
                value={info.tenant?.id ?? ''}
                disabled={switching}
                onChange={(e) => void changeTenant(e.target.value)}
                className="tenant-select -ml-1 block max-w-full cursor-pointer truncate rounded bg-transparent px-1 text-[11px] text-brand-300 [color-scheme:dark] hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-gold-500 disabled:opacity-50"
              >
                {!info.tenant && <option value="">–</option>}
                {info.tenants.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            ) : (
              info.tenant && <p className="truncate text-[11px] text-brand-300">{info.tenant.name}</p>
            )}
          </div>
          <IconButton label={t.lock} onClick={onLock} className="text-brand-200 hover:bg-white/10 hover:text-white">
            <Lock className="h-4 w-4" />
          </IconButton>
          <IconButton label={t.logout} onClick={onLogout} className="text-brand-200 hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-300" />
          <input
            type="search"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && query && (e.preventDefault(), changeQuery(''))}
            placeholder={t.search}
            aria-label={t.search}
            autoFocus
            className="search-input h-10 w-full rounded-xl border border-white/10 bg-white/10 pl-9 pr-9 text-sm text-white placeholder:text-brand-300 focus:border-gold-500 focus:outline-none"
          />
          {query && (
            <IconButton label={t.clearSearch} onClick={() => changeQuery('')} className="absolute right-1 top-1/2 -translate-y-1/2 text-brand-200 hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <select aria-label={t.scopeDept} value={scope.dept} onChange={(e) => changeScope({ dept: e.target.value, folder: '' })} className={cx(selectCls, 'flex-[1.25]')}>
            <option value="">{t.allDepartments}</option>
            <option value="personal">{t.personal}</option>
            {structure?.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t.scopeFolder}
            value={scope.folder}
            disabled={!currentDept || !currentDept.folders.length}
            onChange={(e) => changeScope({ dept: scope.dept, folder: e.target.value })}
            className={selectCls}
          >
            <option value="">{t.allFolders}</option>
            {currentDept?.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {/* Unterordner eingerückt (geschützte Leerzeichen, normale würden zusammengefasst) */}
                {'\u00a0\u00a0\u00a0'.repeat(f.depth)}
                {f.name}
              </option>
            ))}
          </select>
          {scope.dept && (
            <IconButton label={t.resetScope} onClick={() => changeScope({ dept: '', folder: '' })} className="shrink-0 text-brand-200 hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
        {error && (
          <div className="p-2">
            <ErrorBox>{error}</ErrorBox>
          </div>
        )}
        {!items && !error && <p className="p-6 text-center text-sm text-slate-500">{t.loading}</p>}
        {items && !query && (
          <section className="mb-2">
            <p className="px-2.5 pb-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-gold-600 dark:text-gold-400">{t.thisPage}</p>
            {forPage.length ? (
              <ul>
                {forPage.map((i) => (
                  <Row key={i.id} item={i} tab={tab} onOpen={() => openItem(i)} onError={setError} />
                ))}
              </ul>
            ) : (
              <p className="px-2.5 pb-2 text-xs text-slate-400">{t.noMatches}</p>
            )}
          </section>
        )}
        {items && (
          <section>
            <p className="truncate border-t border-slate-200 px-2.5 pb-1 pt-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:border-white/10" title={scopeLabel}>
              {scopeLabel}
            </p>
            {filtered.length ? (
              <ul>
                {filtered.map((i) => (
                  <Row key={i.id} item={i} tab={tab} onOpen={() => openItem(i)} onError={setError} />
                ))}
              </ul>
            ) : (
              <p className="px-2.5 py-4 text-center text-xs text-slate-400">{t.empty}</p>
            )}
          </section>
        )}
      </div>
      <p className="border-t border-slate-200 px-3 py-1.5 text-right text-[10px] text-slate-400 dark:border-white/10">Bastion v{__APP_VERSION__}</p>
    </div>
  );
}
