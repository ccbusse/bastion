// Papierkorb: Löschen verschiebt nur, Wiederherstellen und endgültiges Löschen mit denselben Rechten wie das Löschen,
// Mandantentrennung, Schlüsselerneuerung erfasst den Papierkorb, automatisches Leeren nach Ablauf der Frist.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { BASE, C, sleep, wrapSigned } from './lib/client.mjs';
import { signedIn, T } from './lib/state.mjs';

const t1 = T.t1;
const dbContainer = process.env.BASTION_TEST_DB_CONTAINER;
const appContainer = process.env.BASTION_TEST_APP_CONTAINER;
const sql = (statement) =>
  execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'bastion', '-d', 'bastion', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' }).trim();
const needsContainers = { skip: dbContainer && appContainer ? false : 'BASTION_TEST_DB_CONTAINER/BASTION_TEST_APP_CONTAINER fehlen (nur über run.sh)' };

async function folderKeys(a, folderId) {
  const k = (await a.get('/keys/folders')).data.find((x) => x.folderId === folderId);
  return {
    ov: await C.importAesKey(await C.rsaUnwrap(a.keys.privateKey, k.wrappedKey)),
    sec: k.wrappedSecretKey ? await C.importAesKey(await C.rsaUnwrap(a.keys.privateKey, k.wrappedSecretKey)) : null,
  };
}

/** Eintrag in F1 anlegen (verschlüsselt wie im Web-Client). */
async function createItem(a, name) {
  const keys = await folderKeys(a, t1.f1);
  const id = randomUUID();
  const r = await a.post('/items', {
    id,
    type: 'LOGIN',
    folderId: t1.f1,
    overview: await C.encryptJson(keys.ov, { name }, C.AAD.item(id, 'overview')),
    secret: await C.encryptJson(keys.sec ?? keys.ov, { password: 'geheim' }, C.AAD.item(id, 'secret')),
  });
  assert.equal(r.status, 201);
  return id;
}

const listed = async (a, id) => (await a.get('/items')).data.some((i) => i.id === id);
const inTrash = async (a, id) => (await a.get('/items/trash')).data.find((i) => i.id === id);
const auditRow = async (A, action, id) => (await A.get(`/tenant/audit?action=${action}`)).data.find((r) => r.targetId === id);

describe('Papierkorb', () => {
  let A, ED, VW, ED2;
  before(async () => {
    [A, ED, VW, ED2] = await Promise.all([signedIn('A'), signedIn('ED'), signedIn('VW'), signedIn('ED2')]);
  });

  it('Löschen verschiebt in den Papierkorb: aus der Liste (auch für die Erweiterung) verschwunden, im Papierkorb sichtbar', async () => {
    const id = await createItem(ED, 'Papierkorb 1');
    assert.equal((await ED.del(`/items/${id}`)).status, 200);
    assert.equal(await listed(ED, id), false);
    assert.equal(await listed(VW, id), false);
    const mine = await inTrash(ED, id);
    assert.ok(mine, 'im Papierkorb des Bearbeiters');
    assert.equal(mine.canEdit, true);
    assert.ok(Date.parse(mine.purgeAt) > Date.parse(mine.deletedAt));
    const viewer = await inTrash(VW, id);
    assert.ok(viewer, 'Betrachter sieht den Eintrag im Papierkorb');
    assert.equal(viewer.canEdit, false);
    assert.equal(viewer.secret, null, 'ohne reveal kein Geheimteil');
    assert.ok(await auditRow(A, 'item.deleted', id));
  });

  it('Betrachter dürfen weder wiederherstellen noch endgültig löschen, andere Tenants sehen nichts', async () => {
    const id = await createItem(ED, 'Papierkorb 2');
    await ED.del(`/items/${id}`);
    assert.equal((await VW.post(`/items/${id}/restore`)).status, 403);
    assert.equal((await VW.del(`/items/${id}/permanent`)).status, 403);
    assert.equal(await inTrash(ED2, id), undefined);
    assert.equal((await ED2.post(`/items/${id}/restore`)).status, 404);
    assert.equal((await ED2.del(`/items/${id}/permanent`)).status, 404);
    assert.ok(await inTrash(ED, id), 'unverändert im Papierkorb');
  });

  it('gelöschte Einträge lassen sich nicht bearbeiten, protokollieren oder erneut löschen', async () => {
    const id = await createItem(ED, 'Papierkorb 3');
    const item = (await ED.get('/items')).data.find((i) => i.id === id);
    await ED.del(`/items/${id}`);
    assert.equal((await ED.put(`/items/${id}`, { type: 'LOGIN', folderId: t1.f1, overview: item.overview, secret: item.secret, revision: item.revision + 1 })).status, 404);
    assert.equal((await ED.post(`/items/${id}/events`, { event: 'reveal' })).status, 404);
    assert.equal((await ED.del(`/items/${id}`)).status, 404);
  });

  it('Wiederherstellen bringt den Eintrag unverändert zurück; eine alte Revision kann ihn nicht überschreiben', async () => {
    const id = await createItem(ED, 'Papierkorb 4');
    const before = (await ED.get('/items')).data.find((i) => i.id === id);
    await ED.del(`/items/${id}`);
    assert.equal((await ED.post(`/items/${id}/restore`)).status, 200);
    const after = (await ED.get('/items')).data.find((i) => i.id === id);
    assert.ok(after, 'wieder in der Liste');
    assert.equal(after.overview, before.overview);
    assert.equal(after.secret, before.secret);
    assert.ok(after.revision > before.revision);
    assert.equal(await inTrash(ED, id), undefined);
    const stale = await ED.put(`/items/${id}`, { type: 'LOGIN', folderId: t1.f1, overview: before.overview, secret: before.secret, revision: before.revision });
    assert.equal(stale.status, 409, 'Bearbeitung mit der Revision von vor dem Löschen');
    assert.ok(await auditRow(A, 'item.restored', id));
  });

  it('endgültig löschen nur aus dem Papierkorb', async () => {
    const id = await createItem(ED, 'Papierkorb 5');
    assert.equal((await ED.del(`/items/${id}/permanent`)).status, 404, 'aktiver Eintrag');
    await ED.del(`/items/${id}`);
    assert.equal((await ED.del(`/items/${id}/permanent`)).status, 200);
    assert.equal(await inTrash(ED, id), undefined);
    assert.equal((await ED.post(`/items/${id}/restore`)).status, 404);
    assert.ok(await auditRow(A, 'item.purged', id));
  });

  it('persönliche Einträge: Papierkorb nur für den Besitzer', async () => {
    const id = randomUUID();
    const key = ED.keys.personalKey;
    assert.equal((await ED.post('/items', { id, type: 'NOTE', folderId: null, overview: await C.encryptJson(key, { name: 'privat' }, C.AAD.item(id, 'overview')), secret: await C.encryptJson(key, {}, C.AAD.item(id, 'secret')) })).status, 201);
    await ED.del(`/items/${id}`);
    assert.ok(await inTrash(ED, id));
    assert.equal(await inTrash(A, id), undefined, 'auch Tenant-Admins sehen ihn nicht');
    assert.equal((await A.post(`/items/${id}/restore`)).status, 404);
    assert.equal((await ED.post(`/items/${id}/restore`)).status, 200);
  });

  it('Schlüsselerneuerung muss den Papierkorb einschließen; wiederhergestellte Einträge sind danach mit dem neuen Schlüssel lesbar', async () => {
    const id = await createItem(ED, 'Papierkorb Rotation');
    await ED.del(`/items/${id}`);
    const old = await folderKeys(A, t1.f1);
    const raw = C.randomBytes(32);
    const secretRaw = C.randomBytes(32);
    const next = { overview: await C.importAesKey(raw), secret: await C.importAesKey(secretRaw) };
    const recipients = (await A.get(`/folders/${t1.f1}/key-recipients`)).data;
    const keys = await Promise.all(recipients.map(async (r) => ({ userId: r.userId, ...(await wrapSigned(A, t1.f1, r.userId, r.publicKey, raw, r.reveal ? secretRaw : null)) })));
    const active = (await A.get('/items')).data.filter((i) => i.folderId === t1.f1);
    const trash = (await A.get('/items/trash')).data.filter((i) => i.folderId === t1.f1);

    // Ohne Papierkorb (z. B. ein veralteter Client): abgelehnt, nichts geändert
    const partial = await C.reencryptFolderItems({ key: old.ov, secretKey: old.sec }, next, active);
    assert.equal((await A.post(`/folders/${t1.f1}/rotate-key`, { keys, items: partial.items, keptUnreadable: partial.unreadable.map((u) => u.id) })).status, 409);

    const full = await C.reencryptFolderItems({ key: old.ov, secretKey: old.sec }, next, [...active, ...trash]);
    assert.equal((await A.post(`/folders/${t1.f1}/rotate-key`, { keys, items: full.items, keptUnreadable: full.unreadable.length ? full.unreadable.map((u) => u.id) : undefined })).status, 200);

    const ED_ = await signedIn('ED');
    assert.equal((await ED_.post(`/items/${id}/restore`)).status, 200);
    const restored = (await ED_.get('/items')).data.find((i) => i.id === id);
    const fresh = await folderKeys(ED_, t1.f1);
    assert.equal((await C.decryptJson(fresh.ov, restored.overview, C.AAD.item(id, 'overview'))).name, 'Papierkorb Rotation');
  });

  it('nach Ablauf der Frist leert der Server den Papierkorb (mit Audit-Eintrag)', needsContainers, async () => {
    const id = await createItem(ED, 'Papierkorb abgelaufen');
    const keep = await createItem(ED, 'Papierkorb frisch');
    await ED.del(`/items/${id}`);
    await ED.del(`/items/${keep}`);
    sql(`UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = '${id}'`);
    // Der Dienst leert beim Start und danach stündlich
    execFileSync('docker', ['restart', appContainer]);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
      if (!up) await sleep(1000);
    }
    assert.ok(up, 'Instanz nach dem Neustart erreichbar');
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = sql(`SELECT count(*) FROM items WHERE id = '${id}'`) === '0';
      if (!gone) await sleep(500);
    }
    assert.ok(gone, 'abgelaufener Eintrag endgültig gelöscht');
    assert.equal(sql(`SELECT count(*) FROM items WHERE id = '${keep}'`), '1', 'Eintrag innerhalb der Frist bleibt');
    const A2 = await signedIn('A');
    const row = (await A2.get('/tenant/audit?action=items.purged_expired')).data.find((r) => r.metadata?.items?.includes(id));
    assert.ok(row, 'Audit-Eintrag items.purged_expired');
    assert.equal(row.metadata.retentionDays, 30);
  });
});
