// Legt die Testdaten an (frische Instanz erforderlich) und schreibt sie nach .build/state.json.
// Aufbau:
//   System-Admins S und S2
//   Tenant t1: Admins A, A2 · Abteilung IT mit Ordner "Offen" (F1) und "Gesperrt" (F2, ohne Vererbung)
//              ED Bearbeiter F1 · VW Betrachter F1 · UM Benutzerverwaltung · DM Manager Abteilung · RM Rollenverwalter
//              sowie je ein eigenes Konto für Tests, die Konten verändern (MF, RC, LK, LA, NT, RV)
//   Tenant t2: Admin B · ED2 Bearbeiter
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Actor, C, distribute, ok, wrapSigned } from './lib/client.mjs';

const initial = process.env.BASTION_INITIAL_ADMIN_PASSWORD;
if (!initial) throw new Error('BASTION_INITIAL_ADMIN_PASSWORD fehlt (Initialpasswort der Testinstanz)');
const pw = (n) => `Test!${n}-Pw-${randomUUID().slice(0, 8)}X9`;
const state = { users: {}, tenants: {} };
const remember = (key, a, extra = {}) => (state.users[key] = { email: a.email, password: a.password, ...extra });

// ---------- System-Admin ----------
const S = new Actor('sysadmin@sectest.test', pw('S'));
ok(await S.post('/auth/setup/login', { username: 'admin', password: initial }), 'setup login');
ok(await S.post('/auth/setup/complete', { ...(await C.createAccount(S.password, null)).bundle, email: S.email, name: 'Sys Admin' }), 'setup complete');
await S.unlock();
remember('S', S, { id: S.info.user.id });

async function acceptInvite(email, inviteUrl, name) {
  const token = inviteUrl.split('#')[1];
  const a = new Actor(email, pw(name));
  const d = ok(await a.post('/invitations/describe', { token }), 'describe');
  const { bundle } = await C.createAccount(a.password, d.tenantId ? { id: d.tenantId, recoveryPublicKey: d.recoveryPublicKey, signingPublicKey: d.signingPublicKey } : null);
  ok(await a.post('/invitations/accept', { ...bundle, token, name }), 'accept');
  return { a, publicKey: bundle.publicKey, tenantId: d.tenantId };
}

async function createFolder(a, deptId, name, inherit) {
  const rec = ok(await a.get(`/departments/${deptId}/recipients?inherit=${inherit}`), 'recipients');
  const raw = C.randomBytes(32);
  const secretRaw = C.randomBytes(32);
  // Die Kennung vergibt der Client: Die Herkunftsnachweise der Schlüssel sind an sie gebunden
  const id = randomUUID();
  const keys = [];
  for (const r of rec) keys.push({ userId: r.userId, ...(await wrapSigned(a, id, r.userId, r.publicKey, raw, r.reveal ? secretRaw : null)) });
  const f = ok(await a.post('/folders', { id, departmentId: deptId, name, inheritPermissions: inherit, keys }), 'folder');
  return { id: f.id, ov: await C.importAesKey(raw), sec: await C.importAesKey(secretRaw) };
}

async function makeItem(a, folder, name, password) {
  const id = randomUUID();
  const ov = folder ? folder.ov : a.keys.personalKey;
  const sec = folder ? folder.sec : a.keys.personalKey;
  ok(
    await a.post('/items', {
      id,
      type: 'LOGIN',
      folderId: folder ? folder.id : null,
      overview: await C.encryptJson(ov, { name, url: 'https://example.test', username: 'user' }, C.AAD.item(id, 'overview')),
      secret: await C.encryptJson(sec, { password }, C.AAD.item(id, 'secret')),
    }),
    'item',
  );
  return id;
}

// ---------- Zweiter System-Admin (Empfänger der Hinweise an andere System-Admins) ----------
{
  const inv = ok(await S.post('/system/admins', { email: 'sysadmin2@sectest.test', name: 'S2' }), 'invite S2');
  const { a, publicKey } = await acceptInvite('sysadmin2@sectest.test', inv.inviteUrl, 'S2');
  ok(await S.post(`/users/${inv.userId}/confirm`, { fingerprint: await C.fingerprint(publicKey) }), 'confirm S2');
  remember('S2', a, { id: inv.userId });
}

const PLAN = {
  t1: {
    admin: 'A',
    members: [
      ['A2', 'tenant_admin', 'TENANT'],
      ['ED', 'editor', 'F1'],
      ['VW', 'viewer', 'F1'],
      ['UM', 'user_manager', 'TENANT'],
      ['DM', 'manager', 'DEPT'],
      ['RM', 'rolemgr', 'TENANT'],
      ['MF', 'editor', 'F1'],
      ['RC', 'viewer', 'F1'],
      ['LK', 'viewer', 'F1'],
      ['LA', 'viewer', 'F1'],
      ['NT', 'editor', 'F1'],
      ['RV', 'viewer', 'F1'],
    ],
  },
  t2: { admin: 'B', members: [['ED2', 'editor', 'F1']] },
};

for (const [t, plan] of Object.entries(PLAN)) {
  const created = ok(await S.post('/system/tenants', { name: `Tenant ${t}`, slug: t, adminEmail: `${plan.admin.toLowerCase()}@${t}.test` }), 'tenant');
  const { a: A, publicKey } = await acceptInvite(`${plan.admin.toLowerCase()}@${t}.test`, created.invite.inviteUrl, plan.admin);
  ok(await S.post(`/users/${created.invite.userId}/confirm`, { fingerprint: await C.fingerprint(publicKey) }), 'confirm admin');
  await A.login();
  await A.unlock();
  ok(await A.post('/keys/tenant-init', await C.createTenantRecovery(A.info.tenant.id, A.info.user.id, A.keys)), 'tenant-init');
  await A.unlock();
  const tenantId = A.info.tenant.id;
  remember(plan.admin, A, { id: A.info.user.id, tenantId });
  const signingKey = (await C.openTenantAdminKeys(tenantId, A.keys, ok(await A.get('/keys/tenant-recovery'), 'tr'))).signingKey;

  const dept = ok(await A.post('/departments', { name: 'IT', description: '' }), 'dept');
  const f1 = await createFolder(A, dept.id, 'Offen', true);
  const f2 = await createFolder(A, dept.id, 'Gesperrt', false);
  const roles = ok(await A.get('/roles'), 'roles');
  const roleIds = Object.fromEntries(roles.map((r) => [r.key, r.id]));
  roleIds.rolemgr = ok(await A.post('/roles', { name: 'Rollenverwalter', description: '', permissions: ['tenant.roles.manage', 'tenant.users.invite'] }), 'role').id;
  state.tenants[t] = {
    id: tenantId,
    dept: dept.id,
    f1: f1.id,
    f2: f2.id,
    item1: await makeItem(A, f1, `${t}-offen`, `secret-${t}-f1`),
    item2: await makeItem(A, f2, `${t}-gesperrt`, `secret-${t}-f2`),
    roles: roleIds,
  };

  for (const [key, role, scope] of plan.members) {
    const email = `${key.toLowerCase()}@${t}.test`;
    const assignment =
      scope === 'TENANT'
        ? { roleId: roleIds[role], scopeType: 'TENANT' }
        : scope === 'DEPT'
          ? { roleId: roleIds[role], scopeType: 'DEPARTMENT', departmentId: dept.id }
          : { roleId: roleIds[role], scopeType: 'FOLDER', folderId: f1.id };
    const inv = ok(await A.post('/users/invite', { email, name: key, assignments: [assignment] }), 'invite');
    const { a, publicKey: pk } = await acceptInvite(email, inv.inviteUrl, key);
    ok(await A.post(`/users/${inv.userId}/confirm`, { fingerprint: await C.fingerprint(pk) }), 'confirm');
    ok(await A.post(`/users/${inv.userId}/endorse`, { signature: await C.signEndorsement(signingKey, tenantId, inv.userId, pk) }), 'endorse');
    remember(key, a, { id: inv.userId, tenantId });
  }
  await distribute(A);
}

mkdirSync(new URL('.build/', import.meta.url), { recursive: true });
writeFileSync(new URL('.build/state.json', import.meta.url), JSON.stringify(state, null, 2));
console.log(`Testdaten angelegt: ${Object.keys(state.users).length} Konten in ${Object.keys(state.tenants).length} Tenants`);
