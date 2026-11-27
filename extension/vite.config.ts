import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Versionsnummer aus der zentralen Datei VERSION
const version = readFileSync(resolve(__dirname, '../VERSION'), 'utf8').trim();

// Store-Version (BASTION_STORE=1): nur HTTPS, kein unverschlüsselter Zugriff auf localhost (nur für die Entwicklung nötig)
const store = process.env.BASTION_STORE === '1';

// Ziel-Browser (BASTION_TARGET=firefox): eigenes Manifest, Hintergrundseite statt Service Worker, kein Offscreen-Dokument
const firefox = process.env.BASTION_TARGET === 'firefox';

// Add-on-ID für addons.mozilla.org. Wird mit der ersten Einreichung dauerhaft festgelegt und darf sich danach nie mehr ändern.
const geckoId = process.env.BASTION_GECKO_ID ?? 'bastion@ccbusse.github.io';

/**
 * Manifest V3. Bewusst minimale Rechte:
 * - kein dauerhaftes Content-Script, kein Zugriff auf alle Seiten: Ausfüllen nur über activeTab nach Klick/Tastenkürzel
 * - Host-Zugriff nur auf die eine Tresor-URL, die der Benutzer einträgt (optional_host_permissions)
 */
function manifest(): Plugin {
  return {
    name: 'bastion-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(
          {
            manifest_version: 3,
            name: 'Bastion',
            short_name: 'Bastion',
            description: '__MSG_extDescription__',
            default_locale: 'de',
            version,
            ...(firefox
              ? {
                  browser_specific_settings: {
                    gecko: {
                      id: geckoId,
                      // 140 ist die erste Version mit data_collection_permissions (zugleich ESR)
                      strict_min_version: '140.0',
                      // Bastion sammelt nichts für Dritte; Daten gehen nur an den eigenen Tresor-Server
                      data_collection_permissions: { required: ['none'] },
                    },
                    // Bewusst kein gecko_android: auf Android ungetestet. Mit dem Schlüssel erzwingt AMO die Android-Kompatibilität.
                  },
                }
              : { minimum_chrome_version: '120' }),
            icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
            action: { default_popup: 'popup.html', default_title: 'Bastion', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
            // Firefox kennt keinen Service Worker als Hintergrund, sondern eine ereignisgesteuerte Hintergrundseite
            background: firefox ? { scripts: ['background.js'], type: 'module' } : { service_worker: 'background.js', type: 'module' },
            permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'idle', ...(firefox ? [] : ['offscreen']), 'clipboardWrite'],
            optional_host_permissions: store ? ['https://*/*'] : ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
            commands: {
              'fill-login': { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' }, description: '__MSG_cmdFill__' },
              // Strg+Umschalt+Y öffnet in Firefox die Download-Bibliothek
              _execute_action: { suggested_key: firefox ? { default: 'Alt+Shift+B' } : { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' } },
            },
            content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
          },
          null,
          2,
        ),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), manifest()],
  define: { __APP_VERSION__: JSON.stringify(version), __STORE_BUILD__: JSON.stringify(store), __FIREFOX__: JSON.stringify(firefox) },
  // Die Krypto-Module des Web-Clients werden mitbenutzt; deren Abhängigkeit aus diesem Projekt auflösen
  resolve: { alias: { 'hash-wasm': resolve(__dirname, 'node_modules/hash-wasm') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        ...(firefox ? {} : { offscreen: resolve(__dirname, 'offscreen.html') }),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: { entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js') },
    },
  },
});
