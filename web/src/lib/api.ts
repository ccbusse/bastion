export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(code);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Erneute Passworteingabe für kritische Aktionen: Der Server antwortet mit 403 REAUTH_REQUIRED, solange die Sitzung nicht
 * kürzlich bestätigt wurde. Der registrierte Handler fragt das Masterpasswort ab (POST /auth/verify) und liefert true,
 * wenn bestätigt wurde; die Anfrage wird dann einmal wiederholt. Parallele Anfragen teilen sich eine Abfrage.
 */
type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;
let pendingReauth: Promise<boolean> | null = null;

export function setReauthHandler(handler: ReauthHandler | null) {
  reauthHandler = handler;
}

function requestReauth(): Promise<boolean> {
  if (!reauthHandler) return Promise.resolve(false);
  pendingReauth ??= reauthHandler().finally(() => {
    pendingReauth = null;
  });
  return pendingReauth;
}

export async function api<T = unknown>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  try {
    return await request<T>(path, method, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.code === 'REAUTH_REQUIRED' && (await requestReauth())) return request<T>(path, method, body);
    throw e;
  }
}

async function request<T>(path: string, method: Method, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'bastion', Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string | string[]; issues?: { path: string; message: string }[] };
    const code = Array.isArray(data.message) ? data.message[0] : data.message;
    // Nur eine fehlende bzw. abgelaufene Sitzung meldet ab – nicht ein falsches Passwort bei einer erneuten Passworteingabe
    if (res.status === 401 && !path.startsWith('/auth/') && (code === 'NOT_AUTHENTICATED' || code === 'SESSION_EXPIRED')) {
      window.dispatchEvent(new CustomEvent('bastion:unauthorized'));
    }
    throw new ApiError(res.status, code && /^[A-Z_]+$/.test(code) ? code : res.status === 429 ? 'TOO_MANY_REQUESTS' : 'UNKNOWN', data.issues);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as T;
}

export const get = <T>(path: string) => api<T>(path, 'GET');
export const post = <T>(path: string, body?: unknown) => api<T>(path, 'POST', body ?? {});
export const put = <T>(path: string, body?: unknown) => api<T>(path, 'PUT', body ?? {});
export const patch = <T>(path: string, body?: unknown) => api<T>(path, 'PATCH', body ?? {});
export const del = <T>(path: string) => api<T>(path, 'DELETE');
