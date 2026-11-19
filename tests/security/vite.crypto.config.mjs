// Bündelt die Krypto-Module des Web-Clients für den Testclient (ohne eigene Abhängigkeiten der Tests).
// Aufruf aus dem Hauptverzeichnis des Repos:  node web/node_modules/vite/bin/vite.js build --config tests/security/vite.crypto.config.mjs
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default {
  root: here,
  logLevel: 'warn',
  build: {
    outDir: `${here}.build`,
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    lib: { entry: `${here}crypto-entry.ts`, formats: ['es'], fileName: () => 'crypto.mjs' },
  },
};
