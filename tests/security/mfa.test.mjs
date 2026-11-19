// Zweiter Faktor: Replay-Schutz, Sperre, Wiederherstellungscodes, MFA-Pflicht für System-Admins (F-06)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { as, signedIn, U } from './lib/state.mjs';
import { totp } from './lib/totp.mjs';

/** Neue Person mit MFA-Sitzung (Passwort geprüft, zweiter Faktor offen). */
async function mfaSession(key) {
  const a = as(key);
  const r = await a.post('/auth/login', { email: a.email, authHash: await a.authHash() });
  assert.equal(r.data.mfaRequired, true);
  return a;
}

describe('TOTP für ein Konto (MF)', () => {
  let A;
  let secret;
  let enableCode;
  let recovery;

  before(async () => {
    A = await signedIn('A');
    const mf = await signedIn('MF');
    secret = (await mf.post('/mfa/totp/setup', { authHash: await mf.authHash() })).data.secret;
    enableCode = totp(secret);
    const r = await mf.post('/mfa/totp/enable', { code: enableCode });
    assert.equal(r.status, 200);
    recovery = r.data.recoveryCodes;
  });
  after(async () => {
    await A.post(`/users/${U.MF.id}/reset-mfa`, { authHash: await A.authHash() });
    await A.post(`/users/${U.MF.id}/unlock`);
  });

  it('MFA-Sitzung hat keinen Zugriff auf Daten', async () => {
    const s = await mfaSession('MF');
    assert.equal((await s.get('/items')).status, 401);
    assert.equal((await s.get('/auth/session')).status, 401);
  });
  it('der Aktivierungscode kann nicht erneut verwendet werden (Replay)', async () => {
    const s = await mfaSession('MF');
    assert.equal((await s.post('/auth/login/mfa', { code: enableCode })).status, 401);
  });
  it('nach Fehlversuchen ist das Konto gesperrt, auch für gültige Codes', async () => {
    const s = await mfaSession('MF');
    for (let i = 1; i <= 5; i++) {
      const r = await s.post('/auth/login/mfa', { code: String(100000 + i) });
      assert.ok([401, 429].includes(r.status));
    }
    assert.equal((await s.post('/auth/login/mfa', { code: totp(secret) })).status, 429);
    assert.equal((await s.post('/auth/login/mfa', { code: recovery[0] })).status, 429);
    assert.equal((await A.post(`/users/${U.MF.id}/unlock`)).status, 200);
  });
  it('Wiederherstellungscodes gelten genau einmal', async () => {
    const s1 = await mfaSession('MF');
    assert.equal((await s1.post('/auth/login/mfa', { code: recovery[1] })).status, 200);
    const s2 = await mfaSession('MF');
    assert.equal((await s2.post('/auth/login/mfa', { code: recovery[1] })).status, 401);
  });
});

describe('MFA-Pflicht für System-Admins (F-06)', () => {
  let S;
  before(async () => {
    S = await signedIn('S');
    const secret = (await S.post('/mfa/totp/setup', { authHash: await S.authHash() })).data.secret;
    assert.equal((await S.post('/mfa/totp/enable', { code: totp(secret) })).status, 200);
  });
  after(async () => {
    await S.put('/system/settings', { requireMfaForSystemAdmins: false });
    await S.post('/mfa/totp/disable', { authHash: await S.authHash() });
  });

  it('2FA lässt sich bei aktiver Pflicht nicht deaktivieren', async () => {
    assert.equal((await S.put('/system/settings', { requireMfaForSystemAdmins: true })).status, 200);
    assert.equal((await S.post('/mfa/totp/disable', { authHash: await S.authHash() })).status, 403);
  });
  it('ohne Pflicht ist das Deaktivieren erlaubt', async () => {
    assert.equal((await S.put('/system/settings', { requireMfaForSystemAdmins: false })).status, 200);
    assert.equal((await S.post('/mfa/totp/disable', { authHash: await S.authHash() })).status, 200);
  });
});
