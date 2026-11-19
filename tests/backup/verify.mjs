// Prüft nach einer Wiederherstellung, dass sich Testkonten anmelden, ihre Schlüssel entsperren und dieselben Einträge sehen.
//   node tests/backup/verify.mjs record DATEI    Stand vor dem Backup festhalten
//   node tests/backup/verify.mjs compare DATEI   Stand nach der Wiederherstellung vergleichen
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { signedIn } from '../security/lib/state.mjs';

const [mode, file] = process.argv.slice(2);
const accounts = ['A', 'ED', 'VW', 'ED2'];

const snapshot = {};
for (const key of accounts) {
  const a = await signedIn(key);
  const r = await a.get('/items');
  assert.equal(r.status, 200, `Einträge von ${key}`);
  const items = Array.isArray(r.data) ? r.data : (r.data.items ?? []);
  snapshot[key] = items.map((i) => `${i.id}:${i.updatedAt ?? ''}`).sort();
}

if (mode === 'record') {
  assert.ok(Object.values(snapshot).some((s) => s.length > 0), 'Testdaten enthalten keine Einträge');
  writeFileSync(file, JSON.stringify(snapshot));
  console.log('Stand festgehalten:', Object.entries(snapshot).map(([k, v]) => `${k}=${v.length}`).join(' '));
} else if (mode === 'compare') {
  assert.deepEqual(snapshot, JSON.parse(readFileSync(file, 'utf8')));
  console.log('Anmeldung, Entsperren und Einträge nach der Wiederherstellung identisch.');
} else {
  throw new Error('Aufruf: verify.mjs record|compare DATEI');
}
