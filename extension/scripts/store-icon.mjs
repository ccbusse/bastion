// Händlersymbol für den Chrome Web Store: 128×128, Logo 96×96 mittig mit 16 px transparentem Rand (Google-Vorgabe)
//   node scripts/store-icon.mjs [ZIEL.png]    (Standard: symbol-128x128.png im aktuellen Ordner)
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const logo = readFileSync(resolve(here, '../../branding/bastion-icon.svg'), 'utf8');
const inner = logo.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><g transform="translate(16 16) scale(1.5)">${inner}</g></svg>`;
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 }, background: 'rgba(0,0,0,0)' }).render().asPng();
const target = resolve(process.argv[2] ?? 'symbol-128x128.png');
writeFileSync(target, png);
console.log(`Händlersymbol erzeugt: ${target}`);
