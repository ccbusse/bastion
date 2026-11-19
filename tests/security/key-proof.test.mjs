// Herkunftsnachweis für Ordnerschlüssel: Ein untergeschobener Schlüssel wird weder vom Server angenommen noch vom
// Client verwendet – auch nicht, wenn ihn jemand mit Schreibzugriff direkt in die Datenbank einträgt.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { before, describe, it } from 'node:test';
import { anchorOf, C, distribute, folderKeyPackage, ok, packageTrusted, wrapSigned } from './lib/client.mjs';
import { signedIn, T, U } from './lib/state.mjs';

const t1 = T.t1;

// Direkter Datenbankzugriff (Angreifer mit Schreibzugriff auf die Datenbank); run.sh nennt den Datenbank-Container
const dbContainer = process.env.BASTION_TEST_DB_CONTAINER;
const sql = (statement) =>
  execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'bastion', '-d', 'bastion', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' }).trim();
const needsDb = { skip: dbContainer ? false : 'BASTION_TEST_DB_CONTAINER fehlt (nur über run.sh)' };

describe('Herkunftsnachweis für Ordnerschlüssel', () => {
  let A;
  let ED;
  let NT;
  let f3;
  let folderRaw;
  let secretRaw;

  /** Neuer Ordner in der Abteilung von T1 (wie createFolderKeys im Web-Client). */
  async function createFolder(a, body = {}, mutate = (k) => k) {
    const id = randomUUID();
    const recipients = ok(await a.get(`/departments/${t1.dept}/recipients?inherit=true`), 'recipients');
    folderRaw = C.randomBytes(32);
    secretRaw = C.randomBytes(32);
    const keys = [];
    for (const r of recipients) keys.push(mutate({ userId: r.userId, ...(await wrapSigned(a, id, r.userId, r.publicKey, folderRaw, r.reveal ? secretRaw : null)) }));
    return { id, res: await a.post('/folders', { id, departmentId: t1.dept, name: `Nachweis-${id.slice(0, 8)}`, inheritPermissions: true, keys, ...body }) };
  }

  before(async () => {
    A = await signedIn('A');
    ED = await signedIn('ED');
    NT = await signedIn('NT');
  });

  it('ausgelieferte Schlüsselpakete tragen einen gültigen Nachweis', async () => {
    const pkg = await folderKeyPackage(ED, t1.f1);
    assert.ok(pkg.signature, 'Signatur vorhanden');
    assert.equal(pkg.signer.userId, U.A.id, 'Absender ist der Tenant-Admin, der den Schlüssel verteilt hat');
    assert.equal(pkg.tenantId, t1.id);
    assert.equal(await packageTrusted(ED, pkg), true);
    // Selbst angelegter Ordner: eigener Nachweis
    const own = await folderKeyPackage(A, t1.f1);
    assert.equal(own.signer.userId, U.A.id);
    assert.equal(await packageTrusted(A, own), true);
    assert.equal((await anchorOf(ED)).folderKeyAuth, 1, 'neue Konten verwenden von Anfang an nur Schlüssel mit Nachweis');
  });

  it('manipulierte Schlüsselpakete erkennt der Client', async () => {
    const pkg = await folderKeyPackage(ED, t1.f1);
    const evil = C.randomBytes(32);
    const evilWrapped = await C.rsaWrap(ED.keys.publicKey, evil);
    assert.equal(await packageTrusted(ED, { ...pkg, wrappedKey: evilWrapped }), false, 'anderer Ordnerschlüssel');
    assert.equal(await packageTrusted(ED, { ...pkg, wrappedSecretKey: evilWrapped }), false, 'anderer Geheim-Schlüssel');
    assert.equal(await packageTrusted(ED, { ...pkg, signature: null, signer: null }), false, 'ohne Nachweis');
    assert.equal(await packageTrusted(ED, { ...pkg, folderId: t1.f2 }), false, 'Paket eines anderen Ordners');
    assert.equal(await packageTrusted(ED, { ...pkg, tenantId: T.t2.id }), false, 'Paket eines anderen Tenants');

    // Angreifer mit eigenem Schlüsselpaar: signiert korrekt, ist aber nicht vom Tenant beglaubigt
    const attacker = (await C.createAccount('Angreifer-Passwort-9!x', null)).keys;
    const attackerId = randomUUID();
    const sign = (signerId) => C.signFolderKey(attacker.signKey, { tenantId: t1.id, folderId: t1.f1, recipientId: U.ED.id, signerId }, evilWrapped, null);
    const forged = { ...pkg, wrappedKey: evilWrapped, wrappedSecretKey: null, strippedSecretHash: null };
    assert.equal(
      await packageTrusted(ED, { ...forged, signature: await sign(attackerId), signer: { userId: attackerId, publicKey: attacker.publicKey, endorsement: null } }),
      false,
      'Absender ohne Beglaubigung',
    );
    assert.equal(
      await packageTrusted(ED, { ...forged, signature: await sign(U.A.id), signer: { userId: U.A.id, publicKey: attacker.publicKey, endorsement: pkg.signer.endorsement } }),
      false,
      'fremde Beglaubigung passt nicht zum Schlüssel des Angreifers',
    );
    assert.equal(
      await packageTrusted(ED, { ...forged, signature: await sign(U.ED.id), signer: { userId: U.ED.id, publicKey: attacker.publicKey, endorsement: null } }),
      false,
      'als Empfänger ausgegeben: geprüft wird mit dessen eigenem Schlüssel',
    );
  });

  it('der Server nimmt Schlüsselpakete nur mit gültigem Nachweis an', async () => {
    const noId = await A.post('/folders', { departmentId: t1.dept, name: 'Ohne Kennung', keys: [{ userId: U.A.id, wrappedKey: 'A'.repeat(684), wrappedSecretKey: 'A'.repeat(684) }] });
    assert.equal(noId.status, 400);
    assert.equal(noId.data.message, 'FOLDER_ID_REQUIRED');

    const unsigned = await createFolder(A, {}, ({ signature, ...k }) => k);
    assert.equal(unsigned.res.status, 400);
    assert.equal(unsigned.res.data.message, 'INVALID_KEY_SIGNATURE');

    // Nachweis für einen anderen Ordner: an die Kennung gebunden
    const other = await createFolder(A, { id: randomUUID() });
    assert.equal(other.res.status, 400);
    assert.equal(other.res.data.message, 'INVALID_KEY_SIGNATURE');

    const created = await createFolder(A);
    assert.equal(created.res.status, 201, JSON.stringify(created.res.data));
    f3 = created.id;
    assert.equal((await A.post('/folders', { id: f3, departmentId: t1.dept, name: 'Doppelt', keys: [] })).status >= 400, true, 'Kennung ist vergeben');

    // Verteilung an einen neuen Berechtigten: ohne bzw. mit falschem Nachweis abgelehnt
    ok(await A.post('/assignments', { userId: U.NT.id, roleId: t1.roles.reader, scopeType: 'FOLDER', folderId: f3 }), 'assign');
    const good = await wrapSigned(A, f3, U.NT.id, NT.keys.publicKey, folderRaw, secretRaw);
    const { signature, ...noProof } = good;
    for (const grant of [noProof, { ...good, signature: (await wrapSigned(A, t1.f1, U.NT.id, NT.keys.publicKey, folderRaw, secretRaw)).signature }]) {
      const r = await A.post('/keys/folders', { grants: [{ folderId: f3, userId: U.NT.id, ...grant }] });
      assert.equal(r.status, 400);
      assert.equal(r.data.message, 'INVALID_KEY_SIGNATURE');
    }
    assert.equal(await folderKeyPackage(NT, f3), null);
    await distribute(A);
    const pkg = await folderKeyPackage(NT, f3);
    assert.ok(pkg.wrappedSecretKey);
    assert.equal(await packageTrusted(NT, pkg), true);
  });

  it('nach Entzug von „Passwörter anzeigen“ bleibt der Nachweis prüfbar', async () => {
    const reader = (await A.get(`/assignments?scopeType=FOLDER&folderId=${f3}`)).data.find((x) => x.userId === U.NT.id);
    ok(await A.post('/assignments', { userId: U.NT.id, roleId: t1.roles.viewer, scopeType: 'FOLDER', folderId: f3 }), 'viewer');
    assert.equal((await A.del(`/assignments/${reader.id}`)).status, 200);
    const stripped = await folderKeyPackage(NT, f3);
    assert.equal(stripped.wrappedSecretKey, null, 'Geheim-Schlüssel entfernt');
    assert.match(stripped.strippedSecretHash, /^[0-9a-f]{64}$/);
    assert.equal(await packageTrusted(NT, stripped), true, 'Signatur über den Ordnerschlüssel gilt weiter');
    assert.equal(await packageTrusted(NT, { ...stripped, strippedSecretHash: 'a'.repeat(64) }), false);
    assert.equal(await packageTrusted(NT, { ...stripped, strippedSecretHash: null }), false);

    // Recht erneut erteilt: Der Verteiler ersetzt das ganze Paket, der Nachweis deckt wieder beide Schlüssel ab
    ok(await A.post('/assignments', { userId: U.NT.id, roleId: t1.roles.reader, scopeType: 'FOLDER', folderId: f3 }), 'reader');
    await distribute(A);
    const again = await folderKeyPackage(NT, f3);
    assert.ok(again.wrappedSecretKey);
    assert.equal(again.strippedSecretHash, null);
    assert.equal(await packageTrusted(NT, again), true);
  });

  it('ein in die Datenbank geschriebener Schlüssel wird nicht verwendet', needsDb, async () => {
    const good = await folderKeyPackage(NT, f3);
    const evil = await C.rsaWrap(NT.keys.publicKey, C.randomBytes(32));
    const where = `folder_id = '${f3}' AND user_id = '${U.NT.id}'`;
    try {
      // 1. Schlüssel ausgetauscht, übrige Angaben belassen
      sql(`UPDATE folder_keys SET wrapped_key = '${evil}' WHERE ${where}`);
      const swapped = await folderKeyPackage(NT, f3);
      assert.equal(swapped.wrappedKey, evil, 'der Server liefert den untergeschobenen Schlüssel aus');
      assert.equal(await packageTrusted(NT, swapped), false, 'der Client verwendet ihn nicht');
      // 2. Als Schlüssel „aus der Zeit vor dem Nachweis“ getarnt: Das Konto hat die Übernahme bereits vermerkt
      sql(`UPDATE folder_keys SET signature = NULL, signer_id = NULL, signer_public_key = NULL, signer_endorsement = NULL WHERE ${where}`);
      const legacy = await folderKeyPackage(NT, f3);
      assert.equal(legacy.signature, null);
      assert.equal(await packageTrusted(NT, legacy), false);
      assert.equal((await anchorOf(NT)).folderKeyAuth, 1, 'Vermerk im Vertrauensanker: keine Übernahme ohne Nachweis');
    } finally {
      sql(`UPDATE folder_keys SET wrapped_key = '${good.wrappedKey}' WHERE ${where}`);
    }
  });

  it('einmalige Übernahme alter Schlüssel: nur eigene Pakete ohne Nachweis', needsDb, async () => {
    // Zustand vor Einführung des Nachweises nachstellen (der vorige Test hat ihn bereits entfernt)
    sql(`UPDATE folder_keys SET signature = NULL, signer_id = NULL, signer_public_key = NULL, signer_endorsement = NULL WHERE folder_id = '${f3}' AND user_id = '${U.NT.id}'`);
    const legacy = await folderKeyPackage(NT, f3);
    const tenantId = NT.info.tenant.id;
    const anchor = await C.sealAnchor(NT.keys.accountKeyRaw, tenantId, { ...(await anchorOf(NT)), folderKeyAuth: 1 });
    const self = { tenantId, folderId: f3, recipientId: U.NT.id, signerId: U.NT.id };

    const wrong = await NT.post('/keys/folders/attest', { attestations: [{ folderId: f3, signature: await C.signFolderKey(NT.keys.signKey, { ...self, folderId: t1.f1 }, legacy.wrappedKey, legacy.wrappedSecretKey) }], anchor });
    assert.equal(wrong.status, 400);

    const done = await NT.post('/keys/folders/attest', { attestations: [{ folderId: f3, signature: await C.signFolderKey(NT.keys.signKey, self, legacy.wrappedKey, legacy.wrappedSecretKey) }], anchor });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.attested, 1);
    const attested = await folderKeyPackage(NT, f3);
    assert.equal(attested.signer.userId, U.NT.id);
    assert.equal(await packageTrusted(NT, attested), true);

    // Pakete mit Nachweis lassen sich nicht nachträglich „übernehmen“ (der Absender bliebe sonst nicht nachvollziehbar)
    const f1 = await folderKeyPackage(NT, t1.f1);
    const again = await NT.post('/keys/folders/attest', {
      attestations: [{ folderId: t1.f1, signature: await C.signFolderKey(NT.keys.signKey, { ...self, folderId: t1.f1 }, f1.wrappedKey, f1.wrappedSecretKey) }],
      anchor,
    });
    assert.equal(again.data.attested, 0);
    assert.equal((await folderKeyPackage(NT, t1.f1)).signer.userId, U.A.id);
  });

  it('aufräumen', async () => {
    assert.equal((await A.del(`/folders/${f3}`)).status, 200);
  });
});
