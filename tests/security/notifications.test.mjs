// Eingriffe von System-Admins werden gemeldet und erfordern das eigene Passwort (F-07); Einladungs-Kollisionen (F-04)
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WRONG_HASH } from './lib/client.mjs';
import { MOCK_HOST, smtp, until } from './lib/mocks.mjs';
import { signedIn, T, U } from './lib/state.mjs';

let S;
let A;
let mail;
const recipients = () => mail.state.mails.flatMap((m) => m.to);

before(async () => {
  S = await signedIn('S');
  A = await signedIn('A');
  mail = await smtp(18027);
  assert.equal((await S.put('/system/smtp', { host: MOCK_HOST, port: 18027, security: 'none', username: '', fromAddress: 'bastion@sectest.test' })).status, 200);
});
after(async () => {
  await S?.put('/system/smtp', { host: '', port: 25, security: 'none', username: '', password: null, fromAddress: 'b@sectest.test' });
  await mail?.close();
});

describe('2FA zurücksetzen (F-07)', () => {
  it('verlangt das eigene Masterpasswort', async () => {
    assert.equal((await A.post(`/users/${U.NT.id}/reset-mfa`, {})).status, 400);
    assert.equal((await A.post(`/users/${U.NT.id}/reset-mfa`, { authHash: WRONG_HASH })).status, 401);
  });
  it('informiert den Betroffenen', async () => {
    mail.state.mails.length = 0;
    assert.equal((await A.post(`/users/${U.NT.id}/reset-mfa`, { authHash: await A.authHash() })).status, 200);
    assert.ok(await until(() => recipients().includes(U.NT.email)));
  });
});

describe('System-Admin greift in einen Tenant ein (F-07)', () => {
  after(async () => S.post(`/system/tenants/${T.t1.id}/leave`));

  it('Beitrittsanfrage: alle Tenant-Admins werden informiert, der System-Admin nicht', async () => {
    mail.state.mails.length = 0;
    assert.equal((await S.post(`/system/tenants/${T.t1.id}/join`)).data.requested, true);
    assert.ok(await until(() => recipients().includes(U.A.email) && recipients().includes(U.A2.email)));
    assert.ok(!recipients().includes(U.S.email));
    // Zustimmung, damit die folgenden Eingriffe als Mitglied möglich sind
    const req = (await A.get('/tenant/join-requests')).data.find((r) => r.userId === U.S.id);
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/approve`)).status, 200);
    assert.equal((await S.post(`/system/tenants/${T.t1.id}/switch`)).status, 200);
  });
  it('2FA-Reset durch den System-Admin: Betroffener und Tenant-Admins werden informiert', async () => {
    await S.unlock();
    mail.state.mails.length = 0;
    assert.equal((await S.post(`/users/${U.NT.id}/reset-mfa`, { authHash: await S.authHash() })).status, 200);
    assert.ok(await until(() => [U.NT.email, U.A.email, U.A2.email].every((e) => recipients().includes(e))));
    assert.ok(!recipients().includes(U.S.email));
  });
  it('Einladung eines weiteren Tenant-Admins: bestehende Tenant-Admins werden informiert', async () => {
    mail.state.mails.length = 0;
    assert.equal((await S.post(`/system/tenants/${T.t2.id}/admins`, { email: 'neu-admin@t2.test' })).status, 201);
    assert.ok(await until(() => recipients().includes(U.B.email)));
  });
});

describe('Einladungs-Kollision über Tenant-Grenzen (F-04)', () => {
  it('wird im Tenant des Einladenden protokolliert, eigene Kollisionen nicht', async () => {
    const B = await signedIn('B');
    const count = async () => (await B.get('/tenant/audit?action=user.invite_collision')).data.length;
    const before = await count();
    assert.equal((await B.post('/users/invite', { email: U.ED.email })).status, 409);
    assert.equal(await count(), before + 1);
    assert.equal((await B.post('/users/invite', { email: U.ED2.email })).status, 409);
    assert.equal(await count(), before + 1);
  });
});
