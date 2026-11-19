// Audit-Log: Integrität mit externem Anker (F-09), Protokollierung von Exporten (F-08)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signedIn, T, U } from './lib/state.mjs';

describe('Audit-Kette (F-09)', () => {
  it('ist intakt und liefert den Kettenkopf', async () => {
    const S = await signedIn('S');
    const r = (await S.get('/system/audit/verify')).data;
    assert.equal(r.ok, true);
    assert.equal(r.legacyEntries, 0);
    assert.match(r.head.hash, /^h1:/);
  });
  it('ein früherer Kettenkopf wird als Anker erkannt, ein falscher nicht', async () => {
    const S = await signedIn('S');
    const head = (await S.get('/system/audit/verify')).data.head;
    const good = (await S.get(`/system/audit/verify?anchorId=${head.id}&anchorHash=${encodeURIComponent(head.hash)}`)).data;
    assert.equal(good.ok, true);
    assert.equal(good.anchorOk, true);
    const bad = (await S.get(`/system/audit/verify?anchorId=${head.id}&anchorHash=${encodeURIComponent('h1:' + '0'.repeat(64))}`)).data;
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'ANCHOR_MISMATCH');
    const missing = (await S.get(`/system/audit/verify?anchorId=999999999&anchorHash=${encodeURIComponent(head.hash)}`)).data;
    assert.equal(missing.reason, 'ANCHOR_MISMATCH');
  });
  it('nur System-Admins dürfen prüfen', async () => {
    const A = await signedIn('A');
    assert.equal((await A.get('/system/audit/verify')).status, 403);
  });
});

describe('Export von Unternehmenseinträgen (F-08)', () => {
  it('wird protokolliert, nur mit Ordnern, auf die der Benutzer Zugriff hat', async () => {
    const ED = await signedIn('ED');
    assert.equal((await ED.post('/items/export-event', { count: 3, folders: [T.t1.f1, T.t1.f2, T.t2.f1] })).status, 200);
    const A = await signedIn('A');
    const row = (await A.get('/tenant/audit?action=items.exported')).data.find((x) => x.actorEmail === ED.email);
    assert.ok(row);
    assert.deepEqual(row.metadata.folders, [T.t1.f1]);
    assert.equal(row.metadata.count, 3);
  });
});

describe('Abruf der Einträge (items.listed)', () => {
  it('der erste vollständige Abruf je Sitzung wird protokolliert, weitere derselben Sitzung nicht', async () => {
    const A = await signedIn('A');
    const mine = async () => (await A.get('/tenant/audit?action=items.listed')).data.filter((r) => r.actorEmail === U.A.email).length;
    const before = await mine();
    const B = await signedIn('A'); // neue Sitzung (wie ein neues Gerät)
    assert.equal((await B.get('/items')).status, 200);
    await Promise.all([B.get('/items'), B.get('/items')]);
    assert.equal(await mine(), before + 1, 'genau ein Eintrag für die neue Sitzung');
    const row = (await A.get('/tenant/audit?action=items.listed')).data.find((r) => r.actorEmail === U.A.email);
    assert.equal(row.metadata.client, 'WEB');
    assert.equal(typeof row.metadata.items, 'number');
  });
});
