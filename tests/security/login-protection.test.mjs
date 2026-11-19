// Schutz der Anmeldung (F-05): Sperre je IP, Gerätecookie gegen Aussperren, kontoweites Limit gegen verteiltes Raten;
// Zähler in der Datenbank (überstehen einen Neustart, keine Adressen im Klartext)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { Actor, BASE, nextIp, sleep, WRONG_HASH } from './lib/client.mjs';
import { as, U } from './lib/state.mjs';

const dbContainer = process.env.BASTION_TEST_DB_CONTAINER;
const appContainer = process.env.BASTION_TEST_APP_CONTAINER;
const sql = (statement) =>
  execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'bastion', '-d', 'bastion', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' }).trim();
const needsContainers = { skip: dbContainer && appContainer ? false : 'BASTION_TEST_DB_CONTAINER/BASTION_TEST_APP_CONTAINER fehlen (nur über run.sh)' };

const deviceCookie = (a) => a.jar.bastion_device;
const attempt = (email, ip, authHash = WRONG_HASH, cookie) => new Actor(email, 'x', { ip }).post('/auth/login', { email, authHash }, cookie ? { headers: { cookie } } : {});

describe('Sperre je Konto und IP-Adresse, Gerätecookie', () => {
  it('Angreifer hinter derselben IP sperrt neue Geräte, aber nicht das bekannte Gerät des Opfers', async () => {
    const ip = nextIp();
    const victim = as('LK', { ip });
    await victim.login();
    const cookie = deviceCookie(victim);
    assert.ok(cookie, 'Gerätecookie nach erfolgreicher Anmeldung');

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt(U.LK.email, ip)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);

    const goodHash = await victim.authHash();
    assert.equal((await attempt(U.LK.email, ip, goodHash)).status, 429, 'neues Gerät hinter derselben IP ist gesperrt');
    assert.equal((await attempt(U.LK.email, ip, goodHash, cookie)).status, 200, 'bekanntes Gerät kann sich anmelden');
  });

  it('gefälschtes oder fremdes Gerätecookie hilft nicht', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await attempt(U.VW.email, ip);
    const vw = as('VW', { ip });
    const goodHash = await vw.authHash();
    const forged = `bastion_device=${'A'.repeat(22)}.${'A'.repeat(22)}`;
    assert.equal((await attempt(U.VW.email, ip, goodHash, forged)).status, 429);
    const other = as('ED');
    await other.login();
    assert.equal((await attempt(U.VW.email, ip, goodHash, deviceCookie(other))).status, 429, 'Cookie eines anderen Kontos');
  });
});

describe('Kontoweites Limit für unbekannte Geräte', () => {
  it('nach 20 Fehlversuchen von 20 IP-Adressen sind neue Geräte gesperrt, bekannte nicht', async () => {
    const known = as('LA');
    await known.login();
    const cookie = deviceCookie(known);
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await attempt(U.LA.email, nextIp())).status);
    assert.deepEqual(statuses, [...Array(20).fill(401), 429]);
    const goodHash = await known.authHash();
    assert.equal((await attempt(U.LA.email, nextIp(), goodHash)).status, 429, 'neues Gerät von neuer IP');
    assert.equal((await attempt(U.LA.email, nextIp(), goodHash, cookie)).status, 200, 'bekanntes Gerät');
  });

  it('unbekannte Adressen verhalten sich gleich (keine Enumeration über die Sperre)', async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await attempt('niemand@nirgends.test', nextIp())).status);
    assert.deepEqual(statuses, [...Array(20).fill(401), 429]);
  });

  it('die Überschreitung wird protokolliert', async () => {
    const A = as('A');
    await A.login();
    const rows = (await A.get('/tenant/audit?action=auth.login_account_limited')).data;
    assert.ok(rows.some((r) => r.actorEmail === U.LA.email));
  });
});

describe('Zähler in der Datenbank', () => {
  it('die Sperre übersteht einen Neustart; gespeichert werden nur HMAC-Werte', needsContainers, async () => {
    const ip = nextIp();
    const email = 'neustart@nirgends.test';
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt(email, ip)).status);
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);

    assert.ok(Number(sql('SELECT count(*) FROM login_throttle')) > 0);
    assert.equal(sql("SELECT count(*) FROM login_throttle WHERE key !~ '^[kau]:[0-9a-f]{32}$'"), '0', 'nur HMAC-Schlüssel');

    execFileSync('docker', ['restart', appContainer]);
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
      if (!up) await sleep(1000);
    }
    assert.ok(up, 'Instanz nach dem Neustart erreichbar');
    assert.equal((await attempt(email, ip)).status, 429, 'nach dem Neustart weiter gesperrt');
    assert.equal((await attempt(email, nextIp())).status, 401, 'andere IP-Adresse nicht betroffen');
  });
});
