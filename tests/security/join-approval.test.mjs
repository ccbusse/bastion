// Beitritt von System-Admins zu einem Tenant nur mit Zustimmung eines Tenant-Admins (Standard für jeden Tenant)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MOCK_HOST, smtp, until } from './lib/mocks.mjs';
import { signedIn, T, U } from './lib/state.mjs';

const NO = { reauth: false };
const dbContainer = process.env.BASTION_TEST_DB_CONTAINER;
const sql = (statement) =>
  execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'bastion', '-d', 'bastion', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' }).trim();
const needsDb = { skip: dbContainer ? false : 'BASTION_TEST_DB_CONTAINER fehlt (nur über run.sh)' };

let mail;
let S;
let A;
const recipients = () => mail.state.mails.flatMap((m) => m.to);
const isMember = async () => (await S.get('/auth/session')).data.tenants.some((x) => x.id === T.t1.id);
const tenantRow = async () => (await S.get('/system/tenants')).data.find((x) => x.id === T.t1.id);
const openRequest = async (admin = A) => (await admin.get('/tenant/join-requests')).data.find((r) => r.userId === U.S.id);

/** Offene Anfrage von S an T1 stellen. */
async function request() {
  const r = await S.post(`/system/tenants/${T.t1.id}/join`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.requested, true);
  assert.equal(r.data.joined, false);
  return openRequest();
}

before(async () => {
  mail = await smtp(18029);
  S = await signedIn('S');
  A = await signedIn('A');
  assert.equal((await S.put('/system/smtp', { host: MOCK_HOST, port: 18029, security: 'none', username: '', fromAddress: 'bastion@sectest.test' })).status, 200);
});
after(async () => {
  await S.del(`/system/tenants/${T.t1.id}/join`);
  if (await isMember()) await S.post(`/system/tenants/${T.t1.id}/leave`);
  await A.patch('/tenant', { requireJoinApproval: true });
  await S.put('/system/smtp', { host: '', port: 25, security: 'none', username: '', password: null, fromAddress: 'b@sectest.test' });
  await mail?.close();
});
beforeEach(async () => {
  await S.del(`/system/tenants/${T.t1.id}/join`);
  if (await isMember()) await S.post(`/system/tenants/${T.t1.id}/leave`);
  mail.state.mails.length = 0;
});

describe('Beitrittsanfrage eines System-Admins', () => {
  it('ist für bestehende Tenants eingeschaltet', async () => {
    assert.equal((await A.get('/tenant')).data.requireJoinApproval, true);
    assert.equal((await tenantRow()).requireJoinApproval, true);
  });

  it('Beitritt erzeugt nur eine Anfrage: keine Mitgliedschaft, Tenant-Admins werden informiert, Audit-Eintrag', async () => {
    const req = await request();
    assert.ok(req, 'Anfrage für Tenant-Admins sichtbar');
    assert.ok(!(await isMember()));
    assert.ok((await tenantRow()).joinRequestedUntil);
    assert.equal((await S.post(`/system/tenants/${T.t1.id}/switch`)).status, 400);
    assert.equal((await S.get(`/users/${U.ED.id}/recovery`)).status, 403);
    assert.ok(await until(() => recipients().includes(U.A.email) && recipients().includes(U.A2.email)));
    assert.ok(!recipients().includes(U.S.email));
    const audit = (await A.get('/tenant/audit?action=tenant.sysadmin_join_requested')).data;
    assert.ok(audit.some((r) => r.actorEmail === U.S.email));
  });

  it('nur Tenant-Admins des eigenen Tenants sehen und entscheiden Anfragen', async () => {
    const req = await request();
    const ED = await signedIn('ED');
    assert.equal((await ED.get('/tenant/join-requests')).status, 403);
    assert.equal((await ED.post(`/tenant/join-requests/${req.id}/approve`)).status, 403);
    assert.equal((await ED.post(`/tenant/join-requests/${req.id}/reject`)).status, 403);
    const B = await signedIn('B');
    assert.ok(!(await openRequest(B)), 'Tenant-Admin eines anderen Tenants sieht die Anfrage nicht');
    assert.equal((await B.post(`/tenant/join-requests/${req.id}/approve`)).status, 404);
    assert.equal((await B.post(`/tenant/join-requests/${req.id}/reject`)).status, 404);
    // System-Admin ohne Mitgliedschaft kann nichts entscheiden und die Einstellung nicht ändern
    assert.equal((await S.post(`/tenant/join-requests/${req.id}/approve`)).status === 200, false);
    assert.ok(!(await isMember()));
  });

  it('Zustimmung verlangt die erneute Passworteingabe', async () => {
    const req = await request();
    const fresh = await signedIn('A');
    const r = await fresh.post(`/tenant/join-requests/${req.id}/approve`, {}, NO);
    assert.equal(r.status, 403);
    assert.equal(r.data.message, 'REAUTH_REQUIRED');
    assert.ok(!(await isMember()));
  });

  it('Zustimmung: System-Admin wird Tenant-Admin, erhält aber ohne Beglaubigung keine Schlüssel; Mail an ihn und die anderen Admins', async () => {
    const req = await request();
    mail.state.mails.length = 0;
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/approve`)).status, 200);
    assert.ok(await isMember());
    assert.ok(!(await openRequest()));
    const S1 = await signedIn('S');
    await S1.post(`/system/tenants/${T.t1.id}/switch`);
    assert.equal((await S1.get('/keys/folders')).data.length, 0);
    assert.ok(await until(() => recipients().includes(U.S.email) && recipients().includes(U.A2.email)));
    const audit = (await A.get('/tenant/audit?action=tenant.sysadmin_join_approved')).data;
    assert.ok(audit.some((r) => r.actorEmail === U.A.email));
  });

  it('Ablehnung: keine Mitgliedschaft, Anfrage entfernt, System-Admin wird informiert', async () => {
    const req = await request();
    mail.state.mails.length = 0;
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/reject`)).status, 200);
    assert.ok(!(await isMember()));
    assert.ok(!(await openRequest()));
    assert.equal((await tenantRow()).joinRequestedUntil, null);
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/approve`)).status, 404);
    assert.ok(await until(() => recipients().includes(U.S.email)));
  });

  it('der System-Admin kann seine Anfrage zurückziehen', async () => {
    const req = await request();
    assert.equal((await S.del(`/system/tenants/${T.t1.id}/join`)).status, 200);
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/approve`)).status, 404);
    assert.equal((await S.del(`/system/tenants/${T.t1.id}/join`)).status, 404);
  });

  it('abgelaufene Anfragen lassen sich nicht mehr annehmen', needsDb, async () => {
    const req = await request();
    sql(`UPDATE tenant_join_requests SET expires_at = now() - interval '1 minute' WHERE id = '${req.id}'`);
    assert.ok(!(await openRequest()));
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/approve`)).status, 404);
    assert.ok(!(await isMember()));
  });
});

describe('Einstellung „Beitritt nur mit Zustimmung“', () => {
  it('kann ein System-Admin über die Systemverwaltung nicht abschalten', async () => {
    await S.patch(`/system/tenants/${T.t1.id}`, { requireJoinApproval: false });
    assert.equal((await tenantRow()).requireJoinApproval, true);
  });

  it('Abschalten durch einen Tenant-Admin informiert die anderen; danach tritt der System-Admin direkt bei', async () => {
    assert.equal((await A.patch('/tenant', { requireJoinApproval: false })).status, 200);
    try {
      assert.ok(await until(() => recipients().includes(U.A2.email)));
      assert.ok(!recipients().includes(U.A.email));
      const r = await S.post(`/system/tenants/${T.t1.id}/join`);
      assert.equal(r.status, 200);
      assert.equal(r.data.joined, true);
      assert.ok(await isMember());
    } finally {
      if (await isMember()) await S.post(`/system/tenants/${T.t1.id}/leave`);
      assert.equal((await A.patch('/tenant', { requireJoinApproval: true })).status, 200);
    }
  });
});
