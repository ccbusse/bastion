// Testclient: bildet den Browser-Client nach (gleiche Krypto-Module wie der Web-Client, siehe build-crypto.mjs).
// Läuft ausschließlich gegen eine Testinstanz (Standard: http://127.0.0.1:13000, siehe compose.test.yml).
import * as C from '../.build/crypto.mjs';

export const BASE = process.env.BASTION_URL ?? 'http://127.0.0.1:13000';
export { C };

// Zufälliger Startwert je Prozess: node --test startet jede Testdatei in einem eigenen Prozess
let ipCounter = Math.floor(Math.random() * 60_000);
/** Jede simulierte Person bekommt eine eigene IP-Adresse (X-Forwarded-For), damit sich IP-basierte Limits nicht überschneiden. */
export const nextIp = () => {
  ipCounter = (ipCounter + 1) % 65_000;
  return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

export class Actor {
  constructor(email, password, opts = {}) {
    this.email = email;
    this.password = password;
    this.ip = opts.ip ?? nextIp();
    this.jar = {};
    this.bearer = null;
    this.keys = null;
    this.info = null;
  }

  get cookie() {
    return Object.values(this.jar).join('; ') || null;
  }

  /**
   * Wie der Web-Client: Verlangt der Server für eine kritische Aktion die erneute Passworteingabe (403 REAUTH_REQUIRED),
   * wird die Sitzung mit dem Masterpasswort bestätigt und die Anfrage einmal wiederholt. `{ reauth: false }` schaltet das ab.
   */
  async req(method, path, body, opts = {}) {
    const r = await this.send(method, path, body, opts);
    if (r.status === 403 && r.data?.message === 'REAUTH_REQUIRED' && opts.reauth !== false && this.password) {
      const v = await this.send('POST', '/auth/verify', { authHash: await this.authHash() });
      if (v.status === 200) return this.send(method, path, body, opts);
    }
    return r;
  }

  async send(method, path, body, opts = {}) {
    const headers = { 'x-requested-with': 'bastion', origin: BASE, 'x-forwarded-for': this.ip, ...(opts.headers ?? {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
      else if (this.cookie && !headers.cookie) headers.cookie = this.cookie;
    }
    for (const h of opts.omit ?? []) delete headers[h];
    const res = await fetch(BASE + '/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const name = kv.slice(0, kv.indexOf('='));
      if (/=$/.test(kv) || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) delete this.jar[name];
      else this.jar[name] = kv;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b = {}, o) { return this.req('POST', p, b, o); }
  put(p, b = {}, o) { return this.req('PUT', p, b, o); }
  patch(p, b = {}, o) { return this.req('PATCH', p, b, o); }
  del(p, o) { return this.req('DELETE', p, undefined, o); }

  async authHash(password = this.password) {
    const kdf = (await this.post('/auth/prelogin', { email: this.email })).data;
    return (await C.deriveLoginKeys(password, kdf)).authHash;
  }

  /** Anmeldung (Web-Client: Cookie). Mit `totp` wird der zweite Faktor gleich mit erledigt. */
  async login(opts = {}) {
    const r = await this.post('/auth/login', { email: this.email, authHash: await this.authHash(), ...(opts.body ?? {}) }, opts);
    if (r.status !== 200) throw new Error(`Login ${this.email}: ${r.status} ${JSON.stringify(r.data)}`);
    if (r.data.token) this.bearer = r.data.token;
    if (r.data.mfaRequired && opts.totp) {
      const m = await this.post('/auth/login/mfa', { code: await opts.totp() });
      if (m.status !== 200) throw new Error(`MFA ${this.email}: ${m.status}`);
      if (m.data.token) this.bearer = m.data.token;
    }
    return r;
  }

  async unlock() {
    this.info = (await this.get('/auth/session')).data;
    this.keys = await C.unlock(this.password, this.info.keys);
    return this.info;
  }
}

/** Schlüsselpaket mit Herkunftsnachweis des Absenders (wie wrapSigned im Web-Client). */
export async function wrapSigned(a, folderId, recipientId, publicKey, raw, secretRaw) {
  const wrappedKey = await C.rsaWrap(publicKey, raw);
  const wrappedSecretKey = secretRaw ? await C.rsaWrap(publicKey, secretRaw) : undefined;
  const binding = { tenantId: a.info.tenant.id, folderId, recipientId, signerId: a.info.user.id };
  return { wrappedKey, ...(wrappedSecretKey ? { wrappedSecretKey } : {}), signature: await C.signFolderKey(a.keys.signKey, binding, wrappedKey, wrappedSecretKey) };
}

/** Eigener Vertrauensanker (entschlüsselt) für den aktiven Tenant; null, wenn keiner festgehalten ist. */
export async function anchorOf(a) {
  const sealed = (await a.get('/keys/anchor')).data.anchor;
  return sealed ? C.openAnchor(a.keys.accountKeyRaw, a.info.tenant.id, sealed) : null;
}

/** Schlüsselpaket eines Ordners, wie es der Server ausliefert. */
export async function folderKeyPackage(a, folderId) {
  return (await a.get('/keys/folders')).data.find((x) => x.folderId === folderId) ?? null;
}

/** Prüfung des Herkunftsnachweises wie im Web-Client (dieselbe Funktion, gegen den eigenen Vertrauensanker). */
export async function packageTrusted(a, pkg) {
  return C.folderKeyTrusted({ userId: a.info.user.id, publicKey: a.keys.publicKey }, await anchorOf(a), pkg);
}

/** Ordnerschlüssel an berechtigte, beglaubigte Empfänger verteilen (wie distributePendingKeys im Web-Client). */
export async function distribute(a) {
  const pending = ok(await a.get('/keys/pending'), 'pending');
  const wrapped = ok(await a.get('/keys/folders'), 'keys');
  const grants = [];
  for (const f of pending.folders) {
    const w = wrapped.find((x) => x.folderId === f.folderId);
    const raw = await C.rsaUnwrap(a.keys.privateKey, w.wrappedKey);
    const sraw = w.wrappedSecretKey ? await C.rsaUnwrap(a.keys.privateKey, w.wrappedSecretKey) : null;
    for (const r of f.recipients) {
      const withSecret = r.needsSecret && !!sraw;
      if (!r.needsKey && !withSecret) continue;
      grants.push({ folderId: f.folderId, userId: r.userId, ...(await wrapSigned(a, f.folderId, r.userId, r.publicKey, raw, withSecret ? sraw : null)) });
    }
  }
  if (grants.length) ok(await a.post('/keys/folders', { grants }), 'share');
  if (pending.recovery.length) {
    const d = ok(await a.get('/keys/tenant-recovery'), 'tenant-recovery');
    const wk = await C.rsaUnwrap(a.keys.privateKey, d.wrappedKey);
    const recovery = await Promise.all(pending.recovery.map(async (r) => ({ userId: r.userId, wrappedKey: await C.rsaWrap(r.publicKey, wk) })));
    ok(await a.post('/keys/recovery', { grants: recovery }), 'recovery share');
  }
}

/** Erwartet einen Erfolgsstatus und liefert die Daten. */
export function ok(r, what) {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const FAKE_ENC = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA';
export const WRONG_HASH = 'B'.repeat(43) + '=';
