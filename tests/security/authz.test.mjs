// Zugriffskontrolle: Mandantentrennung (horizontal) und Rollen (vertikal)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { FAKE_ENC } from './lib/client.mjs';
import { signedIn, T, U } from './lib/state.mjs';

const t1 = T.t1;
const t2 = T.t2;
const itemBody = (folderId) => ({ id: randomUUID(), type: 'LOGIN', folderId, overview: FAKE_ENC, secret: FAKE_ENC });
const SIG = 'A'.repeat(86) + '==';
const WRAPPED = 'A'.repeat(684);

describe('Mandantentrennung: Admin von T2 gegen T1', () => {
  let B;
  before(async () => (B = await signedIn('B')));
  const cases = [
    ['Eintrag ändern', () => B.put(`/items/${t1.item1}`, { type: 'LOGIN', folderId: t2.f1, overview: FAKE_ENC, secret: FAKE_ENC, revision: 1 })],
    ['Eintrag löschen', () => B.del(`/items/${t1.item1}`)],
    ['Eintrag-Ereignis', () => B.post(`/items/${t1.item1}/events`, { event: 'reveal' })],
    ['Eintrag in T1-Ordner anlegen', () => B.post('/items', itemBody(t1.f1))],
    ['Import in T1-Ordner', () => B.post('/items/bulk', { items: [itemBody(t1.f1)] })],
    ['Ordner ändern', () => B.patch(`/folders/${t1.f1}`, { name: 'x' })],
    ['Ordner löschen', () => B.del(`/folders/${t1.f1}`)],
    ['Empfänger einer T1-Abteilung', () => B.get(`/departments/${t1.dept}/recipients`)],
    ['Ordner unter T1-Abteilung anlegen', () => B.post('/folders', { departmentId: t1.dept, name: 'x', keys: [{ userId: U.B.id, wrappedKey: WRAPPED }] })],
    ['Abteilung ändern', () => B.patch(`/departments/${t1.dept}`, { name: 'x' })],
    ['Benutzer deaktivieren', () => B.post(`/users/${U.ED.id}/disable`)],
    ['Benutzer bestätigen', () => B.post(`/users/${U.ED.id}/confirm`, { fingerprint: '0000-0000-0000-0000' })],
    ['Benutzer beglaubigen', () => B.post(`/users/${U.ED.id}/endorse`, { signature: SIG })],
    ['Recovery-Daten', () => B.get(`/users/${U.ED.id}/recovery`)],
    ['T1-Benutzer einer T2-Rolle zuweisen', () => B.post('/assignments', { userId: U.ED.id, roleId: t2.roles.editor, scopeType: 'TENANT' })],
    ['T2-Benutzer einer T1-Rolle zuweisen', () => B.post('/assignments', { userId: U.ED2.id, roleId: t1.roles.tenant_admin, scopeType: 'TENANT' })],
    ['Zuweisungen eines T1-Ordners', () => B.get(`/assignments?scopeType=FOLDER&folderId=${t1.f1}`)],
    ['Rolle ändern', () => B.patch(`/roles/${t1.roles.rolemgr}`, { name: 'x' })],
    ['Ordnerschlüssel verteilen', () => B.post('/keys/folders', { grants: [{ folderId: t1.f1, userId: U.B.id, wrappedKey: WRAPPED }] })],
    ['Notfall-Prüfung eines T1-Benutzers', () => B.get(`/emergency/user/${U.ED.id}/disable-check`)],
    ['Geheim-Schlüssel eines T1-Ordners', () => B.post(`/folders/${t1.f1}/secret-key`, { wrappedSecretKey: WRAPPED, items: [] })],
  ];
  for (const [name, call] of cases) {
    it(`${name} -> abgewiesen`, async () => {
      const r = await call();
      assert.ok([403, 404].includes(r.status), `${r.status} ${JSON.stringify(r.data)}`);
    });
  }
});

describe('Betrachter (view auf F1)', () => {
  let VW;
  before(async () => (VW = await signedIn('VW')));
  it('sieht nur F1, ohne Geheimteil und ohne Geheim-Schlüssel', async () => {
    const items = (await VW.get('/items')).data;
    assert.ok(items.some((i) => i.id === t1.item1));
    assert.ok(!items.some((i) => i.id === t1.item2));
    assert.ok(items.every((i) => i.secret === null || i.personal));
    assert.ok((await VW.get('/keys/folders')).data.every((k) => !k.wrappedSecretKey));
  });
  it('darf nicht bearbeiten und nichts "anzeigen" protokollieren', async () => {
    assert.equal((await VW.put(`/items/${t1.item1}`, { type: 'LOGIN', folderId: t1.f1, overview: FAKE_ENC, secret: FAKE_ENC, revision: 1 })).status, 403);
    assert.equal((await VW.post(`/items/${t1.item1}/events`, { event: 'reveal' })).status, 400);
    assert.equal((await VW.get('/users')).status, 403);
  });
});

describe('Bearbeiter (edit auf F1)', () => {
  let ED;
  before(async () => (ED = await signedIn('ED')));
  it('kein Zugriff auf den gesperrten Ordner F2', async () => {
    assert.equal((await ED.del(`/items/${t1.item2}`)).status, 404);
    assert.equal((await ED.post('/items', itemBody(t1.f2))).status, 403);
  });
  it('kann Unternehmenseinträge weder in den persönlichen Tresor noch nach F2 verschieben', async () => {
    const item = (await ED.get('/items')).data.find((i) => i.id === t1.item1);
    const body = { type: 'LOGIN', overview: item.overview, secret: item.secret, revision: item.revision };
    assert.equal((await ED.put(`/items/${t1.item1}`, { ...body, folderId: null })).status, 403);
    assert.equal((await ED.put(`/items/${t1.item1}`, { ...body, folderId: t1.f2 })).status, 403);
  });
  it('keine Verwaltungsrechte', async () => {
    for (const r of [
      await ED.post('/users/invite', { email: 'x1@t1.test' }),
      await ED.post('/roles', { name: 'x', permissions: ['vault.view'] }),
      await ED.patch('/tenant', { requireMfa: false }),
      await ED.get('/tenant/audit'),
      await ED.post('/assignments', { userId: U.ED.id, roleId: t1.roles.manager, scopeType: 'FOLDER', folderId: t1.f1 }),
      await ED.post('/keys/folders', { grants: [{ folderId: t1.f1, userId: U.VW.id, wrappedSecretKey: WRAPPED }] }),
      await ED.get('/system/tenants'),
      await ED.get('/emergency/status'),
      await ED.get('/keys/tenant-recovery'),
    ]) {
      assert.equal(r.status, 403, JSON.stringify(r.data));
    }
  });
  it('Massenzuweisung: ownerId/tenantId im Request werden ignoriert', async () => {
    const r = await ED.post('/items', { ...itemBody(t1.f1), ownerId: U.A.id, tenantId: t2.id, createdById: U.A.id });
    assert.equal(r.status, 201);
    assert.equal(r.data.personal, false);
    assert.equal(r.data.folderId, t1.f1);
  });
});

describe('Benutzerverwaltung (invite/confirm/manage)', () => {
  let UM;
  before(async () => (UM = await signedIn('UM')));
  it('kann Admins und System-Admins nicht verwalten', async () => {
    assert.equal((await UM.post(`/users/${U.A.id}/disable`)).status, 403);
    assert.equal((await UM.post(`/users/${U.S.id}/disable`)).status, 403);
  });
  it('keine Admin-Funktionen, keine Rechteausweitung', async () => {
    assert.equal((await UM.post(`/users/${U.ED.id}/reset-mfa`, { authHash: 'A'.repeat(43) + '=' })).status, 403);
    assert.equal((await UM.get(`/users/${U.ED.id}/recovery`)).status, 403);
    assert.equal((await UM.post('/users/invite', { email: 'x2@t1.test', assignments: [{ roleId: t1.roles.tenant_admin, scopeType: 'TENANT' }] })).status, 403);
    assert.equal((await UM.post('/users/invite', { email: 'x3@t1.test', assignments: [{ roleId: t1.roles.editor, scopeType: 'FOLDER', folderId: t1.f1 }] })).status, 403);
    assert.equal((await UM.post(`/users/${U.VW.id}/endorse`, { signature: SIG })).status, 403);
  });
});

describe('Rollenverwalter (roles.manage + users.invite)', () => {
  let RM;
  before(async () => (RM = await signedIn('RM')));
  it('keine Rechteausweitung über Rollen', async () => {
    assert.equal((await RM.post('/assignments', { userId: U.RM.id, roleId: t1.roles.tenant_admin, scopeType: 'TENANT' })).status, 403);
    assert.equal((await RM.post('/roles', { name: 'evil1', permissions: ['tenant.admin'] })).status, 403);
    assert.equal((await RM.post('/roles', { name: 'evil2', permissions: ['tenant.audit.read'] })).status, 403);
    assert.equal((await RM.patch(`/roles/${t1.roles.rolemgr}`, { permissions: ['tenant.roles.manage', 'tenant.users.invite', 'tenant.users.manage'] })).status, 403);
    assert.equal((await RM.patch(`/roles/${t1.roles.editor}`, { permissions: ['vault.manage'] })).status, 400);
  });
  it('kann sich keine Tresorrechte geben, die er nicht hat', async () => {
    const role = (await RM.post('/roles', { name: `vaultmgr-${randomUUID().slice(0, 6)}`, permissions: ['vault.manage'] })).data;
    assert.equal((await RM.post('/assignments', { userId: U.RM.id, roleId: role.id, scopeType: 'TENANT' })).status, 403);
    assert.equal((await RM.post('/assignments', { userId: U.RM.id, roleId: role.id, scopeType: 'FOLDER', folderId: t1.f2 })).status, 403);
  });
  it('kann die Admin-Zuweisung eines anderen nicht entfernen', async () => {
    const a = (await RM.get('/assignments?scopeType=TENANT')).data.find((x) => x.userId === U.A2.id);
    assert.ok(a);
    assert.equal((await RM.del(`/assignments/${a.id}`)).status, 403);
  });
  it('kann sich eigene Rechte nicht entziehen (Zuweisung, Rolle kürzen oder löschen)', async () => {
    const own = (await RM.get('/assignments?scopeType=TENANT')).data.find((x) => x.userId === U.RM.id);
    assert.ok(own);
    assert.equal((await RM.del(`/assignments/${own.id}`)).status, 400);
    const r = await RM.patch(`/roles/${t1.roles.rolemgr}`, { permissions: ['tenant.roles.manage'] });
    assert.equal(r.status, 400);
    assert.equal(r.data.message, 'ROLE_ASSIGNED_TO_SELF');
    assert.equal((await RM.del(`/roles/${t1.roles.rolemgr}`)).status, 400);
  });
});

describe('Abteilungs-Manager (manage auf Abteilung, F2 ohne Vererbung)', () => {
  let DM;
  before(async () => (DM = await signedIn('DM')));
  it('sieht F1-, aber keine F2-Einträge', async () => {
    const items = (await DM.get('/items')).data;
    assert.ok(items.some((i) => i.id === t1.item1));
    assert.ok(!items.some((i) => i.id === t1.item2));
  });
  it('kann F2 nicht öffnen, ändern oder löschen', async () => {
    assert.equal((await DM.del(`/folders/${t1.f2}`)).status, 403);
    assert.equal((await DM.patch(`/folders/${t1.f2}`, { inheritPermissions: true })).status, 403);
    assert.equal((await DM.patch(`/folders/${t1.f2}`, { name: 'x' })).status, 403);
    assert.equal((await DM.post('/assignments', { userId: U.DM.id, roleId: t1.roles.viewer, scopeType: 'FOLDER', folderId: t1.f2 })).status, 403);
    assert.equal((await DM.get(`/assignments?scopeType=FOLDER&folderId=${t1.f2}`)).status, 403);
  });
  it('kann sich die eigene Manager-Zuweisung nicht entziehen', async () => {
    const own = (await DM.get(`/assignments?scopeType=DEPARTMENT&departmentId=${t1.dept}`)).data.find((x) => x.userId === U.DM.id);
    assert.ok(own);
    assert.equal((await DM.del(`/assignments/${own.id}`)).status, 400);
    assert.equal((await DM.get(`/assignments?scopeType=DEPARTMENT&departmentId=${t1.dept}`)).status, 200);
  });
});

describe('System-Admin', () => {
  it('ist vor Tenant-Admins geschützt', async () => {
    const A = await signedIn('A');
    assert.equal((await A.post(`/users/${U.S.id}/disable`)).status, 403);
    assert.equal((await A.post(`/users/${U.S.id}/reset-mfa`, { authHash: 'A'.repeat(43) + '=' })).status, 403);
    assert.equal((await A.get('/system/admins')).status, 403);
  });
  it('hat ohne Mitgliedschaft keinen Zugriff auf Tenant-Benutzer', async () => {
    const S = await signedIn('S');
    assert.equal((await S.get(`/users/${U.ED.id}/recovery`)).status, 403);
    assert.equal((await S.post(`/users/${U.ED.id}/disable`)).status, 403);
  });
  it('erhält nach Beitritt ohne Beglaubigung keine Schlüssel und kann kein Konto wiederherstellen', async () => {
    const S = await signedIn('S');
    // Beitritt nur mit Zustimmung eines Tenant-Admins (join-approval.test.mjs)
    assert.equal((await S.post(`/system/tenants/${t1.id}/join`)).data.requested, true);
    const A = await signedIn('A');
    const req = (await A.get('/tenant/join-requests')).data.find((r) => r.userId === U.S.id);
    assert.equal((await A.post(`/tenant/join-requests/${req.id}/approve`)).status, 200);
    await S.post(`/system/tenants/${t1.id}/switch`);
    try {
      assert.equal((await S.get('/items')).data.filter((i) => !i.personal).length, 0);
      assert.equal((await S.get('/keys/folders')).data.length, 0);
      const r = await S.post(`/users/${U.ED.id}/recover`, {
        authHash: 'A'.repeat(43) + '=',
        kdfSalt: 'A'.repeat(22) + '==',
        kdfMemory: 65536,
        kdfIterations: 3,
        kdfParallelism: 4,
        protectedAccountKey: FAKE_ENC,
        protectedPersonalKey: FAKE_ENC,
        recoveryProof: 'A'.repeat(43) + '=',
      });
      assert.equal(r.status, 403);
    } finally {
      await S.post(`/system/tenants/${t1.id}/leave`);
    }
  });
});
