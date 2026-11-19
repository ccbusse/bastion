// Admin-Wiederherstellung (F-01): Der wiederherstellende Admin darf den neuen persönlichen Schlüssel nicht kennen
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Actor, C, FAKE_ENC } from './lib/client.mjs';
import { signedIn, U } from './lib/state.mjs';

describe('Wiederherstellung und Pflicht-Passwortwechsel', () => {
  it('ohne Nachweis (Recovery-Proof) ist keine Wiederherstellung möglich', async () => {
    const A = await signedIn('A');
    const r = await A.post(`/users/${U.ED.id}/recover`, {
      ...(await C.rewrapForPassword('Temp-Pw-ohne-Nachweis-1!', C.randomBytes(32), C.randomBytes(32))),
      recoveryProof: 'A'.repeat(43) + '=',
    });
    assert.equal(r.status, 403);
  });

  it('nach dem Pflicht-Passwortwechsel kann der Admin neue persönliche Einträge nicht entschlüsseln', async () => {
    // Admin führt die Wiederherstellung aus (wie recoverUser im Web-Client) und merkt sich dabei den vorläufigen PersonalKey
    const A = await signedIn('A');
    const tr = (await A.get('/keys/tenant-recovery')).data;
    const { recoveryKey } = await C.openTenantAdminKeys(A.info.tenant.id, A.keys, tr);
    const { recoveryAccountKey } = (await A.get(`/users/${U.RC.id}/recovery`)).data;
    const accountKeyRaw = await C.rsaUnwrap(recoveryKey, recoveryAccountKey);
    const adminKnownPersonalKey = C.randomBytes(32);
    const temp = `Temp!Recovery-${randomUUID().slice(0, 8)}`;
    const recover = await A.post(`/users/${U.RC.id}/recover`, {
      ...(await C.rewrapForPassword(temp, accountKeyRaw, adminKnownPersonalKey)),
      recoveryProof: await C.recoveryProof(accountKeyRaw),
    });
    assert.equal(recover.status, 200);

    // Benutzer: eingeschränkt, bis ein eigenes Passwort gesetzt ist
    const rc = new Actor(U.RC.email, temp);
    await rc.login();
    await rc.unlock();
    assert.equal((await rc.post('/items', { id: randomUUID(), type: 'LOGIN', folderId: null, overview: FAKE_ENC, secret: FAKE_ENC })).status, 403);

    // Pflicht-Passwortwechsel wie im Web-Client (ForcePasswordChangePage): neuer PersonalKey
    const next = `Neu!RC-${randomUUID().slice(0, 8)}-X9`;
    const { payload } = await C.rewrapAfterRecovery(next, rc.keys.accountKeyRaw);
    assert.equal((await rc.post('/auth/change-password', { currentAuthHash: await rc.authHash(), ...payload })).status, 200);
    rc.password = next;
    await rc.unlock();
    assert.ok(!Buffer.from(rc.keys.personalKeyRaw).equals(Buffer.from(adminKnownPersonalKey)), 'PersonalKey wurde ersetzt');

    // Neuer persönlicher Eintrag: für den Benutzer lesbar, für den Admin nicht
    const id = randomUUID();
    await rc.post('/items', {
      id,
      type: 'LOGIN',
      folderId: null,
      overview: await C.encryptJson(rc.keys.personalKey, { name: 'privat' }, C.AAD.item(id, 'overview')),
      secret: await C.encryptJson(rc.keys.personalKey, { password: 'PRIVAT' }, C.AAD.item(id, 'secret')),
    });
    const stored = (await rc.get('/items')).data.find((i) => i.id === id);
    assert.deepEqual(await C.decryptJson(rc.keys.personalKey, stored.secret, C.AAD.item(id, 'secret')), { password: 'PRIVAT' });
    await assert.rejects(C.decryptJson(await C.importAesKey(adminKnownPersonalKey), stored.secret, C.AAD.item(id, 'secret')));

    // Ein späterer normaler Passwortwechsel behält den PersonalKey (Eintrag bleibt lesbar)
    const next2 = `Neu2!RC-${randomUUID().slice(0, 8)}-X9`;
    const rewrapped = await C.rewrapForPassword(next2, rc.keys.accountKeyRaw, rc.keys.personalKeyRaw);
    assert.equal((await rc.post('/auth/change-password', { currentAuthHash: await rc.authHash(), ...rewrapped })).status, 200);
    rc.password = next2;
    await rc.unlock();
    assert.deepEqual(await C.decryptJson(rc.keys.personalKey, stored.secret, C.AAD.item(id, 'secret')), { password: 'PRIVAT' });
  });
});
