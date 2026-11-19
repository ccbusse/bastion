// Kritische Aktionen von System-Admins nur nach erneuter Eingabe des Masterpassworts; Hinweise an andere System-Admins
// und an Kontoinhaber (neues Gerät, Passwortwechsel, 2FA)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WRONG_HASH } from './lib/client.mjs';
import { MOCK_HOST, smtp, until } from './lib/mocks.mjs';
import { as, signedIn, T, U } from './lib/state.mjs';
import { totp } from './lib/totp.mjs';

const NO = { reauth: false };
const SMTP = { host: MOCK_HOST, port: 18028, security: 'none', username: '', fromAddress: 'bastion@sectest.test' };

let mail;
const recipients = () => mail.state.mails.flatMap((m) => m.to);

before(async () => {
  mail = await smtp(18028);
  const S = await signedIn('S');
  assert.equal((await S.put('/system/smtp', SMTP)).status, 200);
});
after(async () => {
  const S = await signedIn('S');
  await S.put('/system/smtp', { host: '', port: 25, security: 'none', username: '', password: null, fromAddress: 'b@sectest.test' });
  await mail?.close();
});

describe('Erneute Passworteingabe für kritische Aktionen', () => {
  // Jede Anfrage würde ohne Bestätigung etwas verändern; mit frischer Sitzung muss der Server sie vorher ablehnen
  const critical = (S) => [
    ['Tenant löschen', () => S.del(`/system/tenants/${T.t2.id}?confirm=t2`, NO)],
    ['System-Admin einladen', () => S.post('/system/admins', { email: 'boese@sectest.test' }, NO)],
    ['Tenant-Admin einladen', () => S.post(`/system/tenants/${T.t2.id}/admins`, { email: 'boese@t2.test' }, NO)],
    ['Tenant beitreten', () => S.post(`/system/tenants/${T.t1.id}/join`, {}, NO)],
    ['Tenant anlegen und beitreten', () => S.post('/system/tenants', { name: 'X', slug: 'reauth-x', addSelfAsAdmin: true }, NO)],
    ['2FA-Pflicht abschalten', () => S.put('/system/settings', { requireMfaForSystemAdmins: false }, NO)],
    ['SMTP ändern', () => S.put('/system/smtp', { ...SMTP, host: 'mail.example.test' }, NO)],
    ['Exportziel anlegen', () => S.post('/emergency/auto/targets', { name: 'x', type: 'FOLDER', enabled: false, keep: 1, config: { path: 'x' } }, NO)],
    ['Exportziel testen', () => S.post('/emergency/auto/test', { name: 'x', type: 'WEBDAV', config: { url: 'https://nas.example.test/x/', username: '' } }, NO)],
    ['Exportziel löschen', () => S.post('/emergency/auto/targets/00000000-0000-0000-0000-000000000000/delete', {}, NO)],
    ['Zeitplan des Exports ändern', () => S.put('/emergency/auto/settings', { enabled: false }, NO)],
  ];

  it('ohne Bestätigung: 403 REAUTH_REQUIRED, nichts wird ausgeführt', async () => {
    const S = await signedIn('S');
    for (const [what, call] of critical(S)) {
      const r = await call();
      assert.equal(r.status, 403, `${what}: ${r.status} ${JSON.stringify(r.data)}`);
      assert.equal(r.data.message, 'REAUTH_REQUIRED', what);
    }
    const admins = (await S.get('/system/admins')).data.map((a) => a.email);
    assert.ok(!admins.includes('boese@sectest.test'));
    assert.ok((await S.get('/system/tenants')).data.some((t) => t.id === T.t2.id));
  });

  it('falsches Passwort gibt nichts frei', async () => {
    const S = await signedIn('S');
    assert.equal((await S.post('/auth/verify', { authHash: WRONG_HASH })).status, 401);
    assert.equal((await S.put('/system/settings', {}, NO)).data.message, 'REAUTH_REQUIRED');
  });

  it('die Bestätigung gilt nur für die eigene Sitzung', async () => {
    const S1 = await signedIn('S');
    const S2 = await signedIn('S');
    assert.equal((await S1.post('/auth/verify', { authHash: await S1.authHash() })).status, 200);
    assert.equal((await S1.put('/system/settings', {}, NO)).status, 200);
    assert.equal((await S2.put('/system/settings', {}, NO)).data.message, 'REAUTH_REQUIRED');
  });

  it('wird im Audit-Log protokolliert', async () => {
    const S = await signedIn('S');
    await S.post('/auth/verify', { authHash: await S.authHash() });
    const rows = (await S.get('/system/audit?action=auth.reauthenticated')).data;
    assert.ok(rows.some((r) => r.actorEmail === U.S.email));
  });
});

describe('Hinweise an die anderen System-Admins', () => {
  it('neuer System-Admin und SMTP-Änderung: S2 wird informiert, S nicht', async () => {
    const S = await signedIn('S');
    mail.state.mails.length = 0;
    assert.equal((await S.post('/system/admins', { email: 'sysadmin3@sectest.test' })).status, 201);
    assert.ok(await until(() => recipients().includes(U.S2.email)));

    mail.state.mails.length = 0;
    assert.equal((await S.put('/system/smtp', SMTP)).status, 200);
    assert.ok(await until(() => recipients().includes(U.S2.email)));
    assert.ok(!recipients().includes(U.S.email));
  });

  it('2FA-Pflicht für System-Admins abgeschaltet: S2 wird informiert', async () => {
    // Mit aktiver Pflicht wäre S ohne eigenen zweiten Faktor sofort eingeschränkt (wie in mfa.test.mjs)
    const S = await signedIn('S');
    const secret = (await S.post('/mfa/totp/setup', { authHash: await S.authHash() })).data.secret;
    assert.equal((await S.post('/mfa/totp/enable', { code: totp(secret) })).status, 200);
    try {
      assert.equal((await S.put('/system/settings', { requireMfaForSystemAdmins: true })).status, 200);
      mail.state.mails.length = 0;
      assert.equal((await S.put('/system/settings', { requireMfaForSystemAdmins: false })).status, 200);
      assert.ok(await until(() => recipients().includes(U.S2.email)));
      assert.ok(!recipients().includes(U.S.email));
    } finally {
      await S.put('/system/settings', { requireMfaForSystemAdmins: false });
      await S.post('/mfa/totp/disable', { authHash: await S.authHash() });
    }
  });
});

describe('Hinweise an den Kontoinhaber', () => {
  it('Anmeldung aus einem unbekannten Browser, nicht aus einem bekannten', async () => {
    const known = as('RV');
    await known.login(); // setzt das Gerätecookie
    mail.state.mails.length = 0;
    const again = as('RV');
    again.jar = { ...known.jar };
    delete again.jar[Object.keys(again.jar).find((k) => /_sid$/.test(k))];
    await again.login();
    await new Promise((d) => setTimeout(d, 1000));
    assert.ok(!recipients().includes(U.RV.email), 'bekanntes Gerät löst keine Mail aus');

    await as('RV').login();
    assert.ok(await until(() => recipients().includes(U.RV.email)), 'unbekanntes Gerät löst eine Mail aus');
  });

  it('2FA einrichten nur mit dem Masterpasswort; Mail an den Inhaber', async () => {
    const RV = await signedIn('RV');
    assert.equal((await RV.post('/mfa/totp/setup', {})).status, 400, 'ohne Passwort');
    assert.equal((await RV.post('/mfa/totp/setup', { authHash: WRONG_HASH })).status, 401, 'falsches Passwort');
    const setup = await RV.post('/mfa/totp/setup', { authHash: await RV.authHash() });
    assert.equal(setup.status, 200);
    mail.state.mails.length = 0;
    try {
      assert.equal((await RV.post('/mfa/totp/enable', { code: totp(setup.data.secret) })).status, 200);
      assert.ok(await until(() => recipients().includes(U.RV.email)), 'Hinweis an den Inhaber');
    } finally {
      assert.equal((await RV.post('/mfa/totp/disable', { authHash: await RV.authHash() })).status, 200);
    }
  });

  it('Anmeldung über die Browser-Erweiterung', async () => {
    mail.state.mails.length = 0;
    await as('RV').login({ headers: { 'x-bastion-client': 'extension', origin: 'chrome-extension://abcdef' }, body: { deviceLabel: 'Test' } });
    assert.ok(await until(() => recipients().includes(U.RV.email)));
  });
});
