// Fügt das gebaute Notfall-Werkzeug (dist-tool) zu einer einzigen, offline lauffähigen HTML-Datei zusammen.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = 'dist-tool';
const out = join('dist', 'tools');
const html = readFileSync(join(src, 'index.html'), 'utf8');
const asset = (ref) => readFileSync(join(src, ref.replace(/^\.\//, '')), 'utf8');

let result = html
  .replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, ref) => `<style>${asset(ref)}</style>`)
  .replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, ref) => `<script type="module">${asset(ref).replace(/<\/script/gi, '<\/script')}</script>`);
if (/(src|href)="\.\/assets\//.test(result)) throw new Error('Notfall-Werkzeug: nicht alle Dateien eingebettet');

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'bastion-notfall-werkzeug.html'), result);
rmSync(src, { recursive: true, force: true });
console.log(`Notfall-Werkzeug: ${join(out, 'bastion-notfall-werkzeug.html')} (${Math.round(result.length / 1024)} KB)`);

