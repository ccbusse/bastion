// Authentifizierung, CSRF, Sessions, Erweiterungs-Token, Fehlerbehandlung
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { Actor, BASE, WRONG_HASH } from './lib/client.mjs';
import { as, signedIn, U } from './lib/state.mjs';

describe('Ohne Anmeldung', () => {
  const anon = new Actor('nobody@nowhere.test', 'x');
  for (const p of ['/items', '/users', '/system/tenants', '/emergency/status', '/keys/folders', '/extension', '/tenant/audit']) {
    it(`GET ${p} -> 401`, async () => assert.equal((await anon.get(p)).status, 401));
  }
  it('Ersteinrichtung ist nach Abschluss gesperrt', async () => {
    assert.equal((await anon.post('/auth/setup/login', { username: 'admin', password: 'irgendwas-langes' })).status, 401);
  });
  it('Prelogin: unbekannte Adresse liefert deterministische Fake-Parameter in gleicher Form', async () => {
    const a = (await anon.post('/auth/prelogin', { email: 'nobody@nowhere.test' })).data;
    const b = (await anon.post('/auth/prelogin', { email: 'nobody@nowhere.test' })).data;
    const real = (await anon.post('/auth/prelogin', { email: U.ED.email })).data;
    assert.equal(a.kdfSalt, b.kdfSalt);
    assert.deepEqual(Object.keys(a), Object.keys(real));
  });
  it('Fehlerantworten ohne Stacktrace', async () => {
    const r = await fetch(`${BASE}/api/auth/prelogin`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'bastion' }, body: '{"email": ' });
    assert.equal(r.status, 400);
    assert.doesNotMatch(await r.text(), /at \w+ \(|node_modules|\.ts:\d+/);
  });
  it('Große Requests werden abgelehnt (413)', async () => {
    // Nur die Größe ankündigen, keinen Body senden: Der Server muss allein anhand von Content-Length ablehnen, ohne auf
    // die Daten zu warten. Würde der Body mitgeschickt, schließt der Server die Verbindung oft noch während des Sendens
    // und der Client sieht EPIPE statt der 413-Antwort (zeitabhängig).
    const status = await new Promise((resolve, reject) => {
      const req = request(`${BASE}/api/auth/prelogin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'bastion', 'content-length': 6_000_000 },
      }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.setTimeout(10_000, () => req.destroy(new Error('Keine Antwort: Server wartet offenbar auf den Body')));
      req.on('error', (e) => { if (!req.res) reject(e); });
      req.flushHeaders();
    });
    assert.equal(status, 413);
  });
});

describe('CSRF', () => {
  it('ohne X-Requested-With -> 403', async () => {
    const a = await signedIn('ED');
    assert.equal((await a.post('/auth/locale', { locale: 'de' }, { omit: ['x-requested-with'] })).status, 403);
  });
  it('mit fremder Origin -> 403', async () => {
    const a = await signedIn('ED');
    assert.equal((await a.post('/auth/locale', { locale: 'de' }, { headers: { origin: 'https://evil.test' } })).status, 403);
  });
  it('Erweiterungs-Ausnahme gilt nicht mit Cookie', async () => {
    const a = await signedIn('ED');
    const r = await a.post('/auth/locale', { locale: 'de' }, { headers: { origin: 'chrome-extension://abc', 'x-bastion-client': 'extension' } });
    assert.equal(r.status, 403);
  });
});

describe('Sessions', () => {
  it('Session-Cookie ist HttpOnly und SameSite=Strict', async () => {
    const a = as('ED');
    const r = await a.post('/auth/login', { email: a.email, authHash: await a.authHash() });
    const sid = r.headers.getSetCookie().find((c) => /bastion_sid=/.test(c));
    assert.ok(sid);
    // Attributnamen und -werte sind laut RFC 6265 unabhängig von Groß-/Kleinschreibung
    assert.match(sid, /HttpOnly/i);
    assert.match(sid, /SameSite=Strict/i);
  });
  it('fremde Session lässt sich nicht widerrufen', async () => {
    const ed = await signedIn('ED');
    const vw = await signedIn('VW');
    const vwSession = (await vw.get('/auth/sessions')).data[0].id;
    assert.equal((await ed.del(`/auth/sessions/${vwSession}`)).status, 403);
  });
  it('nach Logout ist das Cookie ungültig', async () => {
    const a = await signedIn('ED');
    const cookie = a.cookie;
    await a.post('/auth/logout');
    assert.equal((await new Actor('x', 'x').req('GET', '/auth/session', undefined, { headers: { cookie } })).status, 401);
  });
  it('falsches Passwort -> 401', async () => {
    const a = as('ED');
    assert.equal((await a.post('/auth/login', { email: a.email, authHash: WRONG_HASH })).status, 401);
  });
});

describe('Reload-Schlüssel der Web-App', () => {
  it('gehört zur Sitzung und verfällt mit ihr', async () => {
    const a = await signedIn('ED');
    const first = await a.get('/auth/session/reload-key');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(first.data.key, 'base64').length, 32);
    assert.equal((await a.get('/auth/session/reload-key')).data.key, first.data.key);
    const other = await signedIn('ED');
    assert.notEqual((await other.get('/auth/session/reload-key')).data.key, first.data.key);
    const cookie = a.cookie;
    await a.post('/auth/logout');
    assert.equal((await new Actor('x', 'x').req('GET', '/auth/session/reload-key', undefined, { headers: { cookie } })).status, 401);
  });
});

describe('Browser-Erweiterung', () => {
  it('erhält ein Bearer-Token statt Cookie und nur freigegebene Endpunkte', async () => {
    const ext = as('ED');
    await ext.login({ headers: { 'x-bastion-client': 'extension', origin: 'chrome-extension://abcdef' }, body: { deviceLabel: 'Test' } });
    assert.ok(ext.bearer);
    assert.equal(ext.jar.bastion_sid, undefined);
    assert.equal((await ext.get('/items')).status, 200);
    assert.equal((await ext.post('/items', {})).status, 403);
    assert.equal((await ext.get('/users')).status, 403);
    // Vertrauensanker lesen (Prüfung der Ordnerschlüssel), Tenant-Wechsel nur für System-Admins, kein Reload-Schlüssel
    assert.equal((await ext.get('/keys/anchor')).status, 200);
    assert.equal((await ext.post(`/system/tenants/00000000-0000-0000-0000-000000000000/switch`, {})).status, 403);
    assert.equal((await ext.get('/auth/session/reload-key')).status, 403);
    assert.equal((await new Actor('x', 'x').req('GET', '/auth/session', undefined, { headers: { cookie: `bastion_sid=${ext.bearer}` } })).status, 401);
  });
  it('Web-Cookie taugt nicht als Bearer-Token', async () => {
    const a = await signedIn('ED');
    const token = a.jar.bastion_sid.split('=')[1];
    assert.equal((await new Actor('x', 'x').req('GET', '/auth/session', undefined, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  });
});
