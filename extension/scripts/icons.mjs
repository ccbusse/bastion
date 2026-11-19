// Erzeugt die PNG-Symbole der Erweiterung aus dem Bastion-Logo (Chrome akzeptiert für das Manifest kein SVG)
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, '../../branding/bastion-icon.svg'), 'utf8');
const out = resolve(here, '../public/icons');
mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
  writeFileSync(resolve(out, `${size}.png`), png);
}
console.log('Symbole erzeugt:', out);
