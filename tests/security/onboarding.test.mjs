// Einführung: Checkliste "Erste Schritte" nur mit den Schritten der eigenen Rolle, Tour-/Checklisten-Merker nur für das
// eigene Konto, Stand des Datenbank-Backups nur für System-Admins.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, describe, it } from 'node:test';
import { signedIn } from './lib/state.mjs';

const dbContainer = process.env.BASTION_TEST_DB_CONTAINER;
const sql = (statement) =>
  execFileSync('docker', ['exec', '-i', dbContainer, 'psql', '-U', 'bastion', '-d', 'bastion', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' }).trim();
const needsDb = { skip: dbContainer ? false : 'BASTION_TEST_DB_CONTAINER fehlt (nur über run.sh)' };

const groups = (r) => r.data.groups.map((g) => g.id);
const step = (r, group, id) => r.data.groups.find((g) => g.id === group)?.steps.find((s) => s.id === id);

describe('Einführung und Backup-Status', () => {
  let S, A, ED, RM;
  before(async () => {
    [S, A, ED, RM] = await Promise.all([signedIn('S'), signedIn('A'), signedIn('ED'), signedIn('RM')]);
  });

  it('Benutzer sehen nur die Schritte für ihr eigenes Konto', async () => {
    for (const a of [ED, RM]) {
      const r = await a.get('/onboarding/checklist');
      assert.equal(r.status, 200);
      assert.deepEqual(groups(r), ['basics']);
      assert.deepEqual(r.data.groups[0].steps.map((s) => s.id).sort(), ['extension', 'firstItem', 'mfa']);
    }
  });

  it('Tenant-Admins sehen zusätzlich ihre Organisation, abgeleitet aus dem tatsächlichen Zustand', async () => {
    const r = await A.get('/onboarding/checklist');
    assert.deepEqual(groups(r), ['basics', 'tenantAdmin']);
    // Der Testaufbau legt Ordner an und lädt Mitglieder ein
    assert.equal(step(r, 'tenantAdmin', 'structure').state, 'done');
    assert.equal(step(r, 'tenantAdmin', 'invite').state, 'done');
    assert.ok(['open', 'waiting', 'done'].includes(step(r, 'tenantAdmin', 'emergencyApproval').state));
  });

  it('System-Admins sehen die Schritte der Installation', async () => {
    const r = await S.get('/onboarding/checklist');
    assert.ok(groups(r).includes('systemAdmin'));
    assert.equal(step(r, 'systemAdmin', 'secondAdmin').state, 'done');
    assert.equal(step(r, 'systemAdmin', 'tenant').state, 'done');
    assert.equal(step(r, 'systemAdmin', 'dbBackup').state, 'open');
  });

  it('Tour- und Checklisten-Merker gelten nur für das eigene Konto und lassen sich zurücksetzen', async () => {
    assert.equal((await ED.post('/onboarding', { tourCompleted: true, checklistHidden: true })).status, 200);
    let session = (await ED.get('/auth/session')).data;
    assert.ok(session.onboarding.tourCompletedAt);
    assert.ok(session.onboarding.checklistHiddenAt);
    assert.ok((await ED.get('/onboarding/checklist')).data.hiddenAt);
    // Andere Konten bleiben unberührt
    assert.equal((await RM.get('/auth/session')).data.onboarding.checklistHiddenAt, null);

    assert.equal((await ED.post('/onboarding', { tourCompleted: false, checklistHidden: false })).status, 200);
    session = (await ED.get('/auth/session')).data;
    assert.equal(session.onboarding.tourCompletedAt, null);
    assert.equal(session.onboarding.checklistHiddenAt, null);
  });

  it('ungültige Werte werden abgelehnt', async () => {
    assert.equal((await ED.post('/onboarding', { tourCompleted: 'ja' })).status, 400);
  });

  it('den Stand des Datenbank-Backups sehen nur System-Admins', async () => {
    for (const a of [A, ED, RM]) assert.equal((await a.get('/system/db-backup')).status, 403);
    const r = await S.get('/system/db-backup');
    assert.equal(r.status, 200);
  });

  it('der vom Backup-Dienst gemeldete Stand wird bewertet', needsDb, async () => {
    const report = (value) =>
      sql(`INSERT INTO system_settings (key, value, updated_at) VALUES ('backup.database', '${JSON.stringify(value)}'::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    const now = new Date();
    const iso = (offsetHours) => new Date(now.getTime() + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      sql(`DELETE FROM system_settings WHERE key = 'backup.database'`);
      assert.equal((await S.get('/system/db-backup')).data.state, 'unknown');

      report({ configured: false, schedule: '02:30', keep: 14, count: 0, reportedAt: iso(0) });
      assert.equal((await S.get('/system/db-backup')).data.state, 'notConfigured');

      report({ configured: true, schedule: '02:30', keep: 14, count: 3, lastAttemptAt: iso(-1), lastSuccessAt: iso(-1), lastFile: 'bastion-x.dump.age', lastSizeKiB: 12, lastError: null, reportedAt: iso(0) });
      const ok = (await S.get('/system/db-backup')).data;
      assert.equal(ok.state, 'ok');
      assert.equal(ok.report.lastFile, 'bastion-x.dump.age');
      assert.equal(step(await S.get('/onboarding/checklist'), 'systemAdmin', 'dbBackup').state, 'done');

      report({ configured: true, lastAttemptAt: iso(-0.5), lastSuccessAt: iso(-30), lastError: 'pg_dump fehlgeschlagen', reportedAt: iso(0) });
      assert.equal((await S.get('/system/db-backup')).data.state, 'failing');

      report({ configured: true, lastAttemptAt: iso(-30), lastSuccessAt: iso(-30), lastError: null, reportedAt: iso(-30) });
      assert.equal((await S.get('/system/db-backup')).data.state, 'stale');

      // Unlesbarer Inhalt führt nicht zu einem Fehler
      report({ configured: 'kaputt' });
      assert.equal((await S.get('/system/db-backup')).data.state, 'unknown');
    } finally {
      sql(`DELETE FROM system_settings WHERE key = 'backup.database'`);
    }
  });
});
