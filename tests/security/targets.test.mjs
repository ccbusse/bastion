// Exportziele und SMTP: Zugangsdaten an das Ziel gebunden (F-02), keine internen Ziele (F-03), nur verschlüsselte Anmeldung (F-10)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MOCK_HOST, smtp, until, webdav } from './lib/mocks.mjs';
import { signedIn } from './lib/state.mjs';

let S;
const dav = (port) => ({ url: `http://${MOCK_HOST}:${port}/x/`, username: '' });

before(async () => (S = await signedIn('S')));

describe('Gespeicherte Zugangsdaten sind an das Ziel gebunden (F-02)', () => {
  let legit;
  let evil;
  let target;
  // WebDAV mit Anmeldung verlangt HTTPS (F-10). Das Ziel zeigt daher auf eine https-Adresse; der Server lehnt die
  // Umleitung ab, bevor er eine Verbindung aufbaut. Die Gegenstellen prüfen, dass kein Zugangsdatum ankommt.
  before(async () => {
    legit = await webdav(18081);
    evil = await webdav(18082);
    const r = await S.post('/emergency/auto/targets', {
      name: 'NAS',
      type: 'WEBDAV',
      enabled: false,
      keep: 5,
      config: { url: 'https://nas.example.test/x/', username: 'backup' },
      secrets: { password: 'Gespeichertes-Testpasswort' },
    });
    assert.equal(r.status, 201);
    target = r.data;
    assert.equal(JSON.stringify(r.data).includes('Gespeichertes-Testpasswort'), false, 'Passwort wird nie zurückgegeben');
  });
  after(async () => {
    await S.post(`/emergency/auto/targets/${target.id}/delete`);
    await legit.close();
    await evil.close();
  });

  it('Test mit gespeicherter ID und anderer Adresse ohne Passwort wird abgelehnt', async () => {
    const r = await S.post('/emergency/auto/test', { id: target.id, name: 'x', type: 'WEBDAV', config: { url: 'https://andere.example.test/x/', username: 'backup' } });
    assert.equal(r.status, 400);
    assert.equal(r.data.message, 'SECRETS_REQUIRED_FOR_NEW_DESTINATION');
  });
  it('anderer Benutzername ohne Passwort wird abgelehnt', async () => {
    const r = await S.post('/emergency/auto/test', { id: target.id, name: 'x', type: 'WEBDAV', config: { url: 'https://nas.example.test/x/', username: 'anderer' } });
    assert.equal(r.data.message, 'SECRETS_REQUIRED_FOR_NEW_DESTINATION');
  });
  it('Speichern mit neuer Adresse ohne Passwort wird abgelehnt, Name ändern geht', async () => {
    const base = { name: 'NAS', type: 'WEBDAV', enabled: false, keep: 5 };
    assert.equal((await S.put(`/emergency/auto/targets/${target.id}`, { ...base, config: { url: 'https://andere.example.test/x/', username: 'backup' } })).status, 400);
    assert.equal((await S.put(`/emergency/auto/targets/${target.id}`, { ...base, name: 'NAS neu', config: { url: 'https://nas.example.test/x/', username: 'backup' } })).status, 200);
  });
  it('kein Zugangsdatum erreicht die Gegenstellen', () => {
    assert.deepEqual(legit.state.auth, []);
    assert.deepEqual(evil.state.auth, []);
  });
  it('Verbindungstests werden protokolliert', async () => {
    await S.post('/emergency/auto/test', { name: 'x', type: 'WEBDAV', config: dav(18081) });
    const rows = (await S.get('/system/audit?action=emergency.target_tested')).data;
    assert.ok(rows.length >= 1);
    assert.equal(JSON.stringify(rows[0].metadata).includes('Testpasswort'), false);
  });
});

describe('Keine internen Ziele (F-03)', () => {
  for (const url of ['http://db:5432/', 'http://bastion:3000/', 'http://127.0.0.1:3000/', 'http://localhost/', 'http://169.254.169.254/latest/', 'http://[::1]/']) {
    it(`${url} wird abgelehnt`, async () => {
      const t = await S.post('/emergency/auto/test', { name: 'p', type: 'WEBDAV', config: { url, username: '' } });
      assert.equal(t.data.ok, false);
      assert.match(t.data.error, /nicht zulässig/);
    });
  }
  it('Speichern eines internen Ziels -> 400 TARGET_NOT_ALLOWED', async () => {
    const r = await S.post('/emergency/auto/targets', { name: 'intern', type: 'WEBDAV', enabled: false, keep: 1, config: { url: 'http://db:5432/', username: '' } });
    assert.equal(r.data.message, 'TARGET_NOT_ALLOWED');
  });
  it('SFTP und SMB auf interne Hosts werden abgelehnt', async () => {
    for (const body of [
      { type: 'SFTP', config: { host: 'db', port: 5432, username: 'x' }, secrets: { password: 'x' } },
      { type: 'SMB', config: { host: '127.0.0.1', share: 'x' } },
    ]) {
      const r = await S.post('/emergency/auto/test', { name: 'p', ...body });
      assert.match(r.data.error ?? '', /nicht zulässig/, JSON.stringify(r.data));
    }
  });
  it('Cloud-Speicher (S3) gibt es als Ziel nicht mehr', async () => {
    const body = { name: 'p', type: 'S3', enabled: false, keep: 1, config: { bucket: 'abc', accessKeyId: 'x' }, secrets: { secretAccessKey: 'y' } };
    assert.equal((await S.post('/emergency/auto/test', body)).status, 400);
    assert.equal((await S.post('/emergency/auto/targets', body)).status, 400);
  });
  it('externes Ziel ist erlaubt', async () => {
    const m = await webdav(18084);
    try {
      const r = await S.post('/emergency/auto/test', { name: 'p', type: 'WEBDAV', config: dav(18084) });
      assert.equal(r.data.ok, true, JSON.stringify(r.data));
    } finally {
      await m.close();
    }
  });
  it('Weiterleitungen werden nicht verfolgt', async () => {
    const m = await webdav(18083, { redirectTo: 'http://db:5432/' });
    try {
      const r = await S.post('/emergency/auto/test', { name: 'p', type: 'WEBDAV', config: dav(18083) });
      assert.equal(r.data.ok, false);
      assert.match(r.data.error, /leitet/);
    } finally {
      await m.close();
    }
  });
  it('SMTP-Server db bzw. 127.0.0.1 wird abgelehnt', async () => {
    for (const host of ['db', '127.0.0.1']) {
      const r = await S.put('/system/smtp', { host, port: 25, security: 'starttls', username: '', fromAddress: 'b@sectest.test' });
      assert.equal(r.data.message, 'SMTP_HOST_NOT_ALLOWED');
    }
  });
});

describe('Anmeldung nur verschlüsselt (F-10)', () => {
  it('WebDAV mit Benutzername über http wird abgelehnt, über https bzw. ohne Benutzer erlaubt', async () => {
    const http = await S.post('/emergency/auto/targets', { name: 'w', type: 'WEBDAV', enabled: false, keep: 1, config: { url: 'http://nas.example.test/x/', username: 'u' }, secrets: { password: 'p' } });
    assert.equal(http.data.message, 'WEBDAV_HTTPS_REQUIRED');
    const https = await S.post('/emergency/auto/targets', { name: 'w2', type: 'WEBDAV', enabled: false, keep: 1, config: { url: 'https://nas.example.test/x/', username: 'u' }, secrets: { password: 'p' } });
    assert.equal(https.status, 201);
    await S.post(`/emergency/auto/targets/${https.data.id}/delete`);
  });
  it('SMTP-Anmeldung ohne TLS wird abgelehnt, Relay ohne Anmeldung erlaubt', async () => {
    assert.equal((await S.put('/system/smtp', { host: 'mail.example.test', port: 25, security: 'none', username: 'x', password: 'y', fromAddress: 'a@sectest.test' })).data.message, 'SMTP_AUTH_REQUIRES_TLS');
    assert.equal((await S.put('/system/smtp', { host: 'mail.example.test', port: 25, security: 'none', username: '', fromAddress: 'a@sectest.test' })).status, 200);
  });
});

describe('SMTP-Passwort ist an Server, Port und Benutzer gebunden (F-02)', () => {
  let mail;
  before(async () => (mail = await smtp(18025)));
  after(async () => {
    await S.put('/system/smtp', { host: '', port: 25, security: 'none', username: '', password: null, fromAddress: 'b@sectest.test' });
    await mail.close();
  });
  it('Port ändern ohne Passwort wird abgelehnt, Absender ändern nicht', async () => {
    const base = { host: MOCK_HOST, port: 18025, security: 'starttls', username: 'mailer', fromAddress: 'b@sectest.test' };
    assert.equal((await S.put('/system/smtp', { ...base, password: 'Smtp-Testpasswort' })).status, 200);
    assert.equal((await S.put('/system/smtp', { ...base, fromAddress: 'neu@sectest.test' })).status, 200);
    assert.equal((await S.put('/system/smtp', { ...base, port: 18026 })).data.message, 'SMTP_PASSWORD_REQUIRED');
  });
  it('ohne Benutzer wird das alte Passwort verworfen statt umgeleitet', async () => {
    assert.equal((await S.put('/system/smtp', { host: MOCK_HOST, port: 18025, security: 'none', username: '', fromAddress: 'b@sectest.test' })).status, 200);
    assert.equal((await S.get('/system/smtp')).data.hasPassword, false);
    await S.post('/system/smtp/test', { to: 'x@sectest.test' });
    await until(() => mail.state.mails.length > 0);
    assert.deepEqual(mail.state.auth, []);
  });
});
