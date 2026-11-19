import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Notfall-Werkzeug: eigenständige Seite, die anschließend zu einer einzigen HTML-Datei zusammengefügt wird (scripts/inline-tool.mjs)
const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();

export default defineConfig({
  root: 'tool',
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: '../dist-tool',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 5000,
    rollupOptions: { output: { codeSplitting: false } },
  },
});
