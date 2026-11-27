// Baut die Store-Version und packt sie als ZIP für den Upload.
//   node scripts/store-zip.mjs            → Chrome Web Store
//   node scripts/store-zip.mjs --firefox  → addons.mozilla.org (Paket + Quellcode-ZIP für die Prüfung durch Mozilla)
// Eigener ZIP-Schreiber, damit Pfade auf allen Systemen mit "/" getrennt sind und manifest.json im Wurzelverzeichnis liegt.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const firefox = process.argv.includes('--firefox');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(root, '..');
const version = readFileSync(resolve(repo, 'VERSION'), 'utf8').trim();
const dist = resolve(root, 'dist');
const out = resolve(root, firefox ? `bastion-extension-firefox-${version}.zip` : `bastion-extension-store-${version}.zip`);

execSync('npm run build', {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, BASTION_STORE: '1', ...(firefox ? { BASTION_TARGET: 'firefox' } : {}) },
});

const walk = (dir, files = []) => {
  for (const name of readdirSync(dir).sort()) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
};

// Fester Zeitstempel (1.1.2026), damit das Paket bei gleichem Inhalt identisch ist
const dosTime = 0;
const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

/** Schreibt die Dateien als ZIP; Namen relativ zu base, immer mit "/" getrennt. */
function writeZip(files, base, target) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(base, file).split(sep).join('/'), 'utf8');
    const data = readFileSync(file);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8-Dateinamen
    head.writeUInt16LE(8, 8); // Deflate
    head.writeUInt16LE(dosTime, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(target, Buffer.concat([...local, ...central, end]));
}

const built = walk(dist);
writeZip(built, dist, out);
console.log(`Store-Paket: ${out} (${built.length} Dateien)`);

if (firefox) {
  // Mozilla verlangt bei gebündeltem Code den Quellcode samt Bauanleitung (BUILD-FIREFOX.md).
  // Enthalten: alle von Git erfassten bzw. nicht ignorierten Dateien der Erweiterung und die mitbenutzten Module des Web-Clients.
  const paths = ['VERSION', 'branding', 'extension','web/src/lib/crypto', 'web/src/lib/items.ts', 'web/src/lib/totp.ts', 'web/src/lib/types.ts'];
  const listed = execSync(`git ls-files --cached --others --exclude-standard -- ${paths.join(' ')}`, { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((p) => resolve(repo, p))
    .filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile())
    .sort();
  const sourceOut = resolve(root, `bastion-extension-firefox-${version}-source.zip`);
  writeZip(listed, repo, sourceOut);
  console.log(`Quellcode für Mozilla: ${sourceOut} (${listed.length} Dateien)`);
}
