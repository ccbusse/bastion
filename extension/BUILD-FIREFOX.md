# Building the Bastion Firefox add-on from source

This archive contains the complete source of the Bastion browser extension. The submitted package is produced by
Vite (bundled and minified); no other code generation, obfuscation or remote code is involved.

## Requirements

- Node.js 24 (tested with 24.22) and npm 11
- Any OS (Linux, macOS, Windows)

## Steps

```sh
cd extension
npm ci
npm run build:firefox
```

The output is `extension/bastion-extension-firefox-<version>.zip`, identical in content to the uploaded package
(`extension/dist/` holds the same files unpacked).

## Layout

- `extension/src` – background script, popup (React) and autofill code
- `web/src/lib/crypto`, `web/src/lib/items.ts`, `web/src/lib/totp.ts`, `web/src/lib/types.ts` – end-to-end encryption
  code shared with the Bastion web client
- `extension/vite.config.ts` – build configuration; `BASTION_TARGET=firefox` selects the Firefox manifest
- `branding` – SVG logo; `extension/scripts/icons.mjs` renders the PNG icons from it during the build
- `VERSION` – version number written into the manifest

## Third-party libraries

All from npm, versions pinned in `extension/package-lock.json`: react, react-dom, lucide-react,
@fontsource-variable/manrope, hash-wasm (Argon2id via WebAssembly, the reason for `wasm-unsafe-eval` in the CSP).

## Data handling

The extension talks only to the Bastion server whose address the user enters (host permission is requested for that
single origin at runtime). It sends no data to the developer or any third party.
