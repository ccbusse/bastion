/**
 * Vorlagen für Exportziele: Der Benutzer gibt nur ein, was er kennt (Adresse, Benutzer, Passwort, Ordner),
 * daraus entstehen die technischen Einstellungen für den Server.
 */
export type TargetType = 'FOLDER' | 'SMB' | 'SFTP' | 'WEBDAV';
export type Preset = 'smb' | 'nextcloud' | 'storagebox' | 'sftp' | 'webdav' | 'folder';
export type Simple = Record<string, string | number | boolean>;

export const MAIN_PRESETS: Preset[] = ['smb', 'nextcloud', 'storagebox'];
export const OTHER_PRESETS: Preset[] = ['sftp', 'webdav', 'folder'];

export const PRESET_TYPE: Record<Preset, TargetType> = {
  smb: 'SMB',
  nextcloud: 'WEBDAV',
  storagebox: 'SFTP',
  sftp: 'SFTP',
  webdav: 'WEBDAV',
  folder: 'FOLDER',
};

/** Startwerte der einfachen Eingaben je Vorlage */
export const DEFAULTS: Record<Preset, Simple> = {
  smb: { location: '', username: '', domain: '' },
  nextcloud: { server: '', username: '', folder: 'Bastion-Notfall-Backup' },
  storagebox: { username: '', folder: 'bastion' },
  sftp: { host: '', port: 22, username: '', folder: 'bastion' },
  webdav: { url: '', username: '' },
  folder: { folder: '' },
};

/** Welche Felder geheim sind (werden nie angezeigt und nur bei Eingabe übertragen) */
export const SECRET_FIELDS: Record<Preset, string[]> = {
  smb: ['password'],
  nextcloud: ['password'],
  storagebox: ['password'],
  sftp: ['password', 'privateKey', 'passphrase'],
  webdav: ['password'],
  folder: [],
};

const str = (v: unknown) => String(v ?? '').trim();
const clean = (p: string) => p.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');

/** \\NAS\Freigabe\Ordner, //nas/freigabe/ordner oder smb://nas/freigabe/ordner → Host, Freigabe, Pfad */
export function parseShare(location: string) {
  const parts = location
    .trim()
    .replace(/^smb:/i, '')
    .split(/[\\/]+/)
    .filter(Boolean);
  return { host: parts[0] ?? '', share: parts[1] ?? '', path: parts.slice(2).join('/') };
}

export function normalizeUrl(server: string) {
  const s = server.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export class PresetError extends Error {}

/** Technische Konfiguration aus den einfachen Eingaben bauen. */
export function buildConfig(preset: Preset, simple: Simple, previous?: Record<string, unknown>): Record<string, unknown> {
  const base = { preset, simple };
  switch (preset) {
    case 'smb': {
      const { host, share, path } = parseShare(str(simple.location));
      if (!host || !share) throw new PresetError('SMB_LOCATION');
      return { ...base, host, share, path, username: str(simple.username), domain: str(simple.domain) };
    }
    case 'nextcloud': {
      if (!str(simple.server) || !str(simple.username)) throw new PresetError('REQUIRED');
      const folder = clean(str(simple.folder)) || 'Bastion-Notfall-Backup';
      const url = `${normalizeUrl(str(simple.server))}/remote.php/dav/files/${encodeURIComponent(str(simple.username))}/${folder.split('/').map(encodeURIComponent).join('/')}/`;
      return { ...base, url, username: str(simple.username) };
    }
    case 'storagebox': {
      const user = str(simple.username).toLowerCase();
      if (!/^u\d+(-sub\d+)?$/.test(user)) throw new PresetError('STORAGEBOX_USER');
      const host = `${user}.your-storagebox.de`;
      return { ...base, host, port: 23, username: user, path: clean(str(simple.folder)), hostKey: keepHostKey(previous, host, 23) };
    }
    case 'sftp': {
      const host = str(simple.host);
      const port = Number(simple.port) || 22;
      if (!host || !str(simple.username)) throw new PresetError('REQUIRED');
      return { ...base, host, port, username: str(simple.username), path: clean(str(simple.folder)), hostKey: keepHostKey(previous, host, port) };
    }
    case 'webdav':
      if (!str(simple.url)) throw new PresetError('REQUIRED');
      return { ...base, url: normalizeUrl(str(simple.url)), username: str(simple.username) };
    case 'folder':
      return { ...base, path: clean(str(simple.folder)) };
  }
}

/** Gemerkte SFTP-Server-Kennung nur behalten, wenn Host und Port gleich bleiben. */
function keepHostKey(previous: Record<string, unknown> | undefined, host: string, port: number) {
  return previous && previous.host === host && Number(previous.port) === port ? ((previous.hostKey as string | null) ?? null) : null;
}

/** Vorlage eines gespeicherten Ziels (ältere Ziele ohne Vorlage: aus der Art abgeleitet). */
export function presetOf(type: TargetType, config: Record<string, unknown>): Preset {
  const p = config.preset as Preset | undefined;
  if (p && p in PRESET_TYPE) return p;
  return ({ FOLDER: 'folder', SMB: 'smb', SFTP: 'sftp', WEBDAV: 'webdav' } as const)[type];
}

/** Einfache Eingaben eines gespeicherten Ziels (ältere Ziele: aus der technischen Konfiguration). */
export function simpleOf(preset: Preset, config: Record<string, unknown>): Simple {
  if (config.simple && typeof config.simple === 'object') return { ...DEFAULTS[preset], ...(config.simple as Simple) };
  const c = config as Record<string, string | number | boolean | null>;
  switch (preset) {
    case 'smb':
      return { location: `\\\\${c.host}\\${c.share}${c.path ? `\\${String(c.path).replace(/\//g, '\\')}` : ''}`, username: c.username ?? '', domain: c.domain ?? '' };
    case 'sftp':
      return { host: c.host ?? '', port: c.port ?? 22, username: c.username ?? '', folder: c.path ?? '' };
    case 'webdav':
      return { url: c.url ?? '', username: c.username ?? '' };
    case 'folder':
      return { folder: c.path ?? '' };
    default:
      return { ...DEFAULTS[preset] };
  }
}

/** Kurzbeschreibung für die Liste */
export function describeTarget(preset: Preset, simple: Simple, folderBase: string) {
  switch (preset) {
    case 'smb':
      return str(simple.location);
    case 'nextcloud':
      return `${normalizeUrl(str(simple.server)).replace(/^https?:\/\//, '')} · ${str(simple.folder)}`;
    case 'storagebox':
      return `${str(simple.username)} · ${str(simple.folder) || '/'}`;
    case 'sftp':
      return `${str(simple.username)}@${str(simple.host)}:${str(simple.folder) || '/'}`;
    case 'webdav':
      return str(simple.url);
    case 'folder':
      return `${folderBase}/${str(simple.folder)}`.replace(/\/+$/, '');
  }
}
