/**
 * Bastion Notfall-Werkzeug: öffnet ein Notfall-Backup vollständig offline im Browser.
 * Benötigt: Backup-Datei, Code vom Schlüsselblatt und Passphrase. Es werden keine Daten übertragen
 * (Content-Security-Policy: connect-src 'none').
 *
 * Alle Inhalte aus dem Backup werden ausschließlich als Text eingefügt (textContent), nie als HTML.
 */
import Papa from 'papaparse';
import { de } from '../src/i18n/de';
import { BackupFile, decryptBackupItems, openBackupPayload, openEmergencyKey, parseBackupFile, RestoredItem } from '../src/lib/crypto/emergency';
import { ITEM_FIELDS } from '../src/lib/items';
import { parseTotp, totpCode, type TotpConfig } from '../src/lib/totp';
import type { ItemType } from '../src/lib/types';
import './style.css';

declare const __APP_VERSION__: string;

const ERRORS: Record<string, string> = {
  BACKUP_FILE_INVALID: 'Die Datei ist kein Bastion-Notfall-Backup.',
  BACKUP_VERSION_UNSUPPORTED: 'Diese Backup-Version wird von diesem Werkzeug nicht unterstützt. Bitte das Werkzeug aus derselben Bastion-Version verwenden.',
  SHEET_CODE_LENGTH: 'Der Code vom Schlüsselblatt ist unvollständig (55 Zeichen).',
  SHEET_CODE_INVALID: 'Der Code vom Schlüsselblatt enthält ungültige Zeichen.',
  SHEET_CODE_CHECKSUM: 'Der Code vom Schlüsselblatt ist fehlerhaft. Bitte auf Tippfehler prüfen.',
  EMERGENCY_UNLOCK_FAILED: 'Schlüsselblatt und Passphrase passen nicht zu diesem Backup.',
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: (Node | string | null | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

const app = document.getElementById('app')!;
let file: BackupFile | null = null;
let items: RestoredItem[] = [];

function errorText(e: unknown) {
  const code = e instanceof Error ? e.message : String(e);
  return ERRORS[code] ?? `Unerwarteter Fehler: ${code}`;
}

function header() {
  return h(
    'header',
    {},
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'B'), h('div', {}, h('h1', {}, 'Bastion – Notfall-Werkzeug'), h('p', {}, `Offline · Version ${__APP_VERSION__}`))),
    h('p', { class: 'offline' }, 'Dieses Werkzeug arbeitet vollständig offline. Es werden keine Daten übertragen.'),
  );
}

// ---------- Schritt 1: Datei und Schlüssel ----------

function renderUnlock(message?: string) {
  app.replaceChildren(header());
  const main = h('main', {});
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', id: 'file' }) as HTMLInputElement;
  const fileInfo = h('div', { class: 'fileinfo' });
  const code = h('input', { type: 'text', id: 'code', autocomplete: 'off', spellcheck: 'false', placeholder: 'XXXXX-XXXXX-XXXXX-…' }) as HTMLInputElement;
  const pass = h('input', { type: 'password', id: 'pass', autocomplete: 'off' }) as HTMLInputElement;
  const status = h('p', { class: 'status' });
  const error = h('p', { class: 'error' }, message ?? '');
  const button = h('button', { type: 'submit', class: 'primary' }, 'Backup entschlüsseln') as HTMLButtonElement;

  fileInput.addEventListener('change', async () => {
    error.textContent = '';
    fileInfo.replaceChildren();
    file = null;
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      file = parseBackupFile(await f.text());
      fileInfo.append(
        h(
          'dl',
          {},
          h('dt', {}, 'Erstellt'),
          h('dd', {}, new Date(file.createdAt).toLocaleString('de-DE')),
          h('dt', {}, 'Fingerprint'),
          h('dd', { class: 'mono' }, file.fingerprint),
          h('dt', {}, 'Inhalt'),
          h('dd', {}, `${file.stats.items} Einträge · ${file.stats.tenants} Tenants · ${file.stats.folders} Ordner · ${file.stats.users} persönliche Tresore`),
        ),
        h('p', { class: 'hint' }, 'Vergleichen Sie den Fingerprint mit dem auf Ihrem Schlüsselblatt.'),
      );
    } catch (e) {
      error.textContent = errorText(e);
    }
  });

  const form = h(
    'form',
    { class: 'card' },
    h('h2', {}, '1. Backup-Datei'),
    h('label', { for: 'file' }, 'Datei bastion-notfall-backup-….json auswählen'),
    fileInput,
    fileInfo,
    h('h2', {}, '2. Notfallschlüssel'),
    h('label', { for: 'code' }, 'Code vom Schlüsselblatt'),
    code,
    h('label', { for: 'pass' }, 'Passphrase'),
    pass,
    error,
    status,
    button,
  ) as HTMLFormElement;

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    if (!file) {
      error.textContent = 'Bitte zuerst eine Backup-Datei auswählen.';
      return;
    }
    button.disabled = true;
    try {
      status.textContent = 'Schlüssel wird abgeleitet … (das kann bis zu einer Minute dauern)';
      const privateKey = await openEmergencyKey(file.keyId, file.keyProtection, code.value, pass.value);
      status.textContent = 'Backup wird entschlüsselt …';
      const payload = await openBackupPayload(file, privateKey);
      const result = await decryptBackupItems(payload, privateKey);
      items = result.items;
      pass.value = '';
      code.value = '';
      renderItems(result.failed);
    } catch (e) {
      error.textContent = errorText(e);
      status.textContent = '';
    } finally {
      button.disabled = false;
    }
  });

  main.append(
    form,
    h(
      'section',
      { class: 'card muted' },
      h('h2', {}, 'Hinweise'),
      h(
        'ul',
        {},
        h('li', {}, 'Verwenden Sie für das Entschlüsseln möglichst einen vertrauenswürdigen Rechner ohne Internetverbindung.'),
        h('li', {}, 'Entschlüsselte Inhalte bleiben nur in diesem Browserfenster. Schließen Sie das Fenster nach der Verwendung.'),
        h('li', {}, 'Exportierte CSV- und JSON-Dateien enthalten alle Passwörter im Klartext. Löschen Sie sie nach der Verwendung sicher.'),
      ),
    ),
  );
  app.append(main);
}

// ---------- Schritt 2: Einträge ----------

const typeLabel = (t: string) => (de.itemType as Record<string, string>)[t] ?? t;
const fieldLabel = (k: string) => (de.field as Record<string, string>)[k] ?? k;

function fieldsOf(i: RestoredItem) {
  const defs = ITEM_FIELDS[i.type as ItemType] ?? [];
  const known = new Set(['name', 'last4', ...defs.map((d) => d.key)]);
  const out: { key: string; value: string; sensitive: boolean; mono: boolean }[] = [];
  for (const d of defs) {
    const v = (d.part === 'overview' ? i.overview : i.secret)?.[d.key];
    if (v) out.push({ key: d.key, value: v, sensitive: !!d.sensitive, mono: !!d.mono });
  }
  // Unbekannte Felder (z. B. aus neueren Versionen) trotzdem anzeigen
  for (const src of [i.overview, i.secret ?? {}]) {
    for (const [k, v] of Object.entries(src)) if (!known.has(k) && v) out.push({ key: k, value: String(v), sensitive: false, mono: false });
  }
  return out;
}

// ---------- 2FA-Codes (TOTP) ----------

/** Alle angezeigten Code-Felder; ein gemeinsamer Takt aktualisiert die sichtbaren (entfernte werden übersprungen). */
const totpFields = new Map<HTMLElement, { cfg: TotpConfig; code: HTMLElement; left: HTMLElement; shown: boolean }>();

function totpDisplay(cfg: TotpConfig) {
  const code = h('span', { class: 'mono value totp' }, '······');
  const left = h('span', { class: 'hint' });
  const copy = h('button', { type: 'button' }, 'Kopieren');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText((code.textContent ?? '').replace(/\s/g, '')).catch(() => undefined);
    copy.textContent = 'Kopiert';
    setTimeout(() => (copy.textContent = 'Kopieren'), 1500);
  });
  const wrap = h('span', { class: 'totp-wrap' }, code, left, h('span', { class: 'actions' }, copy));
  totpFields.set(wrap, { cfg, code, left, shown: false });
  // erst nach dem Einhängen in die Seite berechnen
  setTimeout(() => void tickTotp(), 0);
  return wrap;
}

async function tickTotp() {
  const now = Date.now();
  for (const [el, entry] of totpFields) {
    const { cfg, code, left } = entry;
    if (!el.isConnected) {
      // Nach einer Neuzeichnung (z. B. Suche) entfernte Felder aufräumen, noch nicht eingehängte behalten
      if (entry.shown) totpFields.delete(el);
      continue;
    }
    entry.shown = true;
    try {
      const c = await totpCode(cfg, now);
      code.textContent = c.length > 4 ? `${c.slice(0, c.length / 2)} ${c.slice(c.length / 2)}` : c;
      left.textContent = `noch ${cfg.period - (Math.floor(now / 1000) % cfg.period)} s`;
    } catch {
      code.textContent = 'ungültiges Secret';
      left.textContent = '';
    }
  }
}
setInterval(() => void tickTotp(), 1000);

function itemRow(i: RestoredItem) {
  const details = h('details', { class: 'item' });
  details.append(
    h('summary', {}, h('span', { class: 'name' }, i.overview.name || '(ohne Bezeichnung)'), h('span', { class: 'type' }, typeLabel(i.type)), h('span', { class: 'sub' }, i.overview.username ?? i.overview.url ?? '')),
  );
  const dl = h('dl', {});
  for (const f of fieldsOf(i)) {
    const value = h('span', { class: f.mono || f.sensitive ? 'mono value' : 'value' }, f.sensitive ? '••••••••' : f.value);
    const actions = h('span', { class: 'actions' });
    if (f.sensitive) {
      const show = h('button', { type: 'button' }, 'Anzeigen');
      show.addEventListener('click', () => {
        const hidden = value.textContent === '••••••••';
        value.textContent = hidden ? f.value : '••••••••';
        show.textContent = hidden ? 'Verbergen' : 'Anzeigen';
      });
      actions.append(show);
    }
    const copy = h('button', { type: 'button' }, 'Kopieren');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(f.value).catch(() => undefined);
      copy.textContent = 'Kopiert';
      setTimeout(() => (copy.textContent = 'Kopieren'), 1500);
    });
    actions.append(copy);
    dl.append(h('dt', {}, fieldLabel(f.key)), h('dd', {}, value, actions));
    if (f.key === 'totp') {
      const cfg = parseTotp(f.value.trim());
      if (cfg) dl.append(h('dt', {}, 'Aktueller 2FA-Code'), h('dd', {}, totpDisplay(cfg)));
    }
  }
  if (!i.secret) dl.append(h('dt', {}, 'Hinweis'), h('dd', {}, 'Der Geheimteil dieses Eintrags konnte nicht entschlüsselt werden.'));
  dl.append(h('dt', {}, 'Geändert'), h('dd', {}, new Date(i.updatedAt).toLocaleString('de-DE')));
  details.append(dl);
  return details;
}

function renderItems(failed: number) {
  app.replaceChildren(header());
  const main = h('main', {});
  const search = h('input', { type: 'search', placeholder: 'Suchen (Bezeichnung, Benutzername, URL, Ordner) …', class: 'search' }) as HTMLInputElement;
  const list = h('div', { class: 'list' });
  const counter = h('span', {});

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q
      ? items.filter((i) => [i.overview.name, i.overview.username, i.overview.url, i.location, i.tenant].some((v) => v?.toLowerCase().includes(q)))
      : items;
    counter.textContent = `${shown.length} von ${items.length} Einträgen`;
    list.replaceChildren();
    let group = '';
    for (const i of shown) {
      const g = `${i.tenant ?? '—'} · ${i.location}`;
      if (g !== group) {
        group = g;
        list.append(h('h3', {}, g));
      }
      list.append(itemRow(i));
    }
  };
  search.addEventListener('input', draw);

  const csv = h('button', { type: 'button' }, 'Als CSV speichern');
  csv.addEventListener('click', () => exportCsv());
  const json = h('button', { type: 'button' }, 'Als JSON speichern');
  json.addEventListener('click', () => save(JSON.stringify(items, null, 2), 'bastion-notfall-klartext.json', 'application/json'));
  const close = h('button', { type: 'button' }, 'Schließen');
  close.addEventListener('click', () => {
    items = [];
    renderUnlock();
  });

  main.append(
    h(
      'div',
      { class: 'toolbar' },
      search,
      h('div', { class: 'buttons' }, csv, json, close),
    ),
    h('p', { class: 'summary' }, counter, failed ? ` · ${failed} Einträge konnten nicht entschlüsselt werden.` : ''),
    h('p', { class: 'warning' }, 'Achtung: CSV- und JSON-Exporte enthalten alle Passwörter im Klartext.'),
    list,
  );
  app.append(main);
  draw();
}

function save(data: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** CSV im verbreiteten Format (Ordner, Name, Benutzername, Passwort, URL, TOTP, Notizen); importierbar z. B. in KeePass. */
function exportCsv() {
  const rows = items.map((i) => {
    const s = i.secret ?? {};
    const extras = fieldsOf(i)
      .filter((f) => !['username', 'url', 'password', 'totp', 'notes'].includes(f.key))
      .map((f) => `${fieldLabel(f.key)}: ${f.value}`);
    return {
      Tenant: i.tenant ?? '',
      Ordner: i.location,
      Typ: typeLabel(i.type),
      Bezeichnung: i.overview.name ?? '',
      Benutzername: i.overview.username ?? '',
      Passwort: s.password ?? '',
      URL: i.overview.url ?? '',
      TOTP: s.totp ?? '',
      Notizen: [s.notes ?? '', ...extras].filter(Boolean).join('\n'),
    };
  });
  save('﻿' + Papa.unparse(rows), 'bastion-notfall-klartext.csv', 'text/csv');
}

renderUnlock();
