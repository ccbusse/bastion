import { getSession, getSettings } from './storage';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Normalisiert die eingegebene Tresor-Adresse auf ihre Herkunft (Schema + Host + Port). */
export function normalizeVaultUrl(input: string): string {
  const raw = input.trim().replace(/\/+$/, '');
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  const local = !__STORE_BUILD__ && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  // Nur HTTPS; unverschlüsselt ausschließlich für lokale Tests
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new ApiError(0, 'HTTPS_REQUIRED');
  if (url.username || url.password) throw new ApiError(0, 'INVALID_URL');
  return url.origin;
}

/**
 * API-Aufruf an den Tresor. Cookies werden nie mitgesendet (credentials: 'omit');
 * die Erweiterung authentifiziert sich ausschließlich mit ihrem eigenen Bearer-Token.
 */
export async function api<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown, opts: { base?: string; auth?: boolean } = {}): Promise<T> {
  const base = opts.base ?? (await getSettings()).vaultUrl;
  if (!base) throw new ApiError(0, 'NO_VAULT');
  const headers: Record<string, string> = { 'x-requested-with': 'bastion', 'x-bastion-client': 'extension' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth !== false) {
    const { token } = await getSession();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string | string[] };
    const code = Array.isArray(data.message) ? data.message[0] : data.message;
    throw new ApiError(res.status, code && /^[A-Z_]+$/.test(code) ? code : res.status === 429 ? 'TOO_MANY_REQUESTS' : 'UNKNOWN');
  }
  return (await res.json()) as T;
}
