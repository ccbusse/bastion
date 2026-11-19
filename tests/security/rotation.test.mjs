// Ordnerschlüssel erneuern nach Rechteentzug: ein behaltener alter Schlüssel ist danach wertlos; nicht lesbare Einträge
// werden gemeldet und nur nach Bestätigung (mit Vermerk im Audit-Log) übernommen
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { C, FAKE_ENC, folderKeyPackage, packageTrusted, wrapSigned } from './lib/client.mjs';
import { signedIn, T, U } from './lib/state.mjs';

const t1 = T.t1;

/** Ordner- und Geheim-Schlüssel eines Benutzers für einen Ordner (wie loadFolderKeys im Web-Client). */
async function folderKeys(a, folderId) {
  const k = (await a.get('/keys/folders')).data.find((x) => x.folderId === folderId);
  if (!k) return null;
  return {
    ov: await C.importAesKey(await C.rsaUnwrap(a.keys.privateKey, k.wrappedKey)),
    sec: k.wrappedSecretKey ? await C.importAesKey(await C.rsaUnwrap(a.keys.privateKey, k.wrappedSecretKey)) : null,
  };
}

/** Neu verschlüsseln wie rotateFolderKey im Web-Client (gemeinsamer Code: reencryptFolderItems). */
async function reencrypt(a, folderId, raw, secretRaw) {
  const old = await folderKeys(a, folderId);
  // Wie der Web-Client: einschließlich Papierkorb (der Server verlangt alle Einträge des Ordners)
  const items = [...(await a.get('/items')).data, ...(await a.get('/items/trash')).data].filter((i) => i.folderId === folderId);
  return C.reencryptFolderItems({ key: old.ov, secretKey: old.sec }, { overview: await C.importAesKey(raw), secret: await C.importAesKey(secretRaw) }, items);
}

/** Rotation wie rotateFolderKey im Web-Client, nach Bestätigung nicht lesbarer Einträge (Empfänger ohne erneute Prüfung der Beglaubigung). */
async function rotate(a, folderId) {
  const recipients = (await a.get(`/folders/${folderId}/key-recipients`)).data;
  const raw = C.randomBytes(32);
  const secretRaw = C.randomBytes(32);
  const { items, unreadable } = await reencrypt(a, folderId, raw, secretRaw);
  const keys = await Promise.all(
    recipients.map(async (r) => ({ userId: r.userId, ...(await wrapSigned(a, folderId, r.userId, r.publicKey, raw, r.reveal ? secretRaw : null)) })),
  );
  return a.post(`/folders/${folderId}/rotate-key`, { keys, items, keptUnreadable: unreadable.length ? unreadable.map((u) => u.id) : undefined });
}

describe('Schlüsselerneuerung nach Rechteentzug', () => {
  let A;
  let RV;
  let rvOldKeys;
  const corrupt = randomUUID();

  before(async () => {
    A = await signedIn('A');
    // Eintrag, den niemand entschlüsseln kann (z. B. nach einem fehlerhaften Import)
    assert.equal((await A.post('/items', { id: corrupt, type: 'LOGIN', folderId: t1.f1, overview: FAKE_ENC, secret: FAKE_ENC })).status, 201);
    RV = await signedIn('RV');
    rvOldKeys = await folderKeys(RV, t1.f1);
    assert.ok(rvOldKeys, 'RV hält den Ordnerschlüssel von F1');
  });

  it('nach Entzug der Rechte wird die Erneuerung empfohlen', async () => {
    const a = (await A.get(`/assignments?scopeType=FOLDER&folderId=${t1.f1}`)).data.find((x) => x.userId === U.RV.id);
    assert.equal((await A.del(`/assignments/${a.id}`)).status, 200);
    const f1 = (await A.get('/structure')).data.departments.flatMap((d) => d.folders).find((f) => f.id === t1.f1);
    assert.equal(f1.keyRotationRecommended, true);
    assert.ok(!(await RV.get('/items')).data.some((i) => i.id === t1.item1), 'der Server liefert die Einträge nicht mehr aus');
  });

  it('nur Manager des Ordners dürfen erneuern', async () => {
    const ED = await signedIn('ED');
    assert.equal((await ED.get(`/folders/${t1.f1}/key-recipients`)).status, 403);
    assert.equal((await ED.post(`/folders/${t1.f1}/rotate-key`, { keys: [{ userId: U.ED.id, wrappedKey: 'A'.repeat(684) }], items: [] })).status, 403);
  });

  it('veraltete Revisionen werden abgelehnt', async () => {
    const raw = C.randomBytes(32);
    const keys = [{ userId: U.A.id, ...(await wrapSigned(A, t1.f1, U.A.id, A.keys.publicKey, raw, raw)) }];
    const r = await A.post(`/folders/${t1.f1}/rotate-key`, { keys, items: [] });
    assert.equal(r.status, 409);
  });

  it('Schlüsselpakete ohne gültigen Herkunftsnachweis werden abgelehnt', async () => {
    const r = await A.post(`/folders/${t1.f1}/rotate-key`, { keys: [{ userId: U.A.id, wrappedKey: 'A'.repeat(684), wrappedSecretKey: 'A'.repeat(684) }], items: [] });
    assert.equal(r.status, 400);
    assert.equal(r.data.message, 'INVALID_KEY_SIGNATURE');
  });

  it('nicht lesbare Einträge werden gemeldet, lesbare neu verschlüsselt', async () => {
    const { items, unreadable } = await reencrypt(A, t1.f1, C.randomBytes(32), C.randomBytes(32));
    assert.ok(unreadable.some((u) => u.id === corrupt && u.name === null), 'beschädigter Eintrag wird gemeldet');
    assert.ok(!unreadable.some((u) => u.id === t1.item1), 'lesbarer Eintrag wird nicht gemeldet');
    const kept = items.find((i) => i.id === corrupt);
    assert.equal(kept.overview, FAKE_ENC, 'unverändert, falls bestätigt übernommen');
    assert.notEqual(items.find((i) => i.id === t1.item1).overview, (await A.get('/items')).data.find((i) => i.id === t1.item1).overview);
  });

  it('nach der Erneuerung ist der alte Schlüssel wertlos, Berechtigte lesen weiter', async () => {
    const r = await rotate(A, t1.f1);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const item = (await A.get('/items')).data.find((i) => i.id === t1.item1);
    await assert.rejects(C.decryptJson(rvOldKeys.ov, item.overview, C.AAD.item(item.id, 'overview')), 'alter Ordnerschlüssel');
    await assert.rejects(C.decryptJson(rvOldKeys.sec ?? rvOldKeys.ov, item.secret, C.AAD.item(item.id, 'secret')), 'alter Geheim-Schlüssel');

    const ED = await signedIn('ED');
    const edKeys = await folderKeys(ED, t1.f1);
    const edItem = (await ED.get('/items')).data.find((i) => i.id === t1.item1);
    assert.deepEqual(await C.decryptJson(edKeys.sec, edItem.secret, C.AAD.item(edItem.id, 'secret')), { password: 'secret-t1-f1' });
    assert.equal(await packageTrusted(ED, await folderKeyPackage(ED, t1.f1)), true, 'neuer Schlüssel trägt einen gültigen Herkunftsnachweis');
    assert.equal(await folderKeys(RV, t1.f1), null, 'RV erhält keinen neuen Schlüssel');

    const f1 = (await A.get('/structure')).data.departments.flatMap((d) => d.folders).find((f) => f.id === t1.f1);
    assert.equal(f1.keyRotationRecommended, false);
    const audit = (await A.get('/tenant/audit?action=folder.key_rotated')).data;
    assert.ok(audit.some((r) => r.metadata?.keptUnreadable?.includes(corrupt)), 'bestätigt übernommene, unlesbare Einträge im Audit-Log');
  });
});
