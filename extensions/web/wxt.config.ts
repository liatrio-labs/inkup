import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import type { Browser } from 'wxt/browser';
import { writeDevIcons } from './scripts/dev-icons';

// ts-ebml requires `ebml`, whose package.json "browser" field points at an IIFE build that exports nothing when
// bundled; the UMD build of the same version does (ADR 0024).
const fromTsEbml = createRequire(createRequire(import.meta.url).resolve('ts-ebml'));
const EBML_UMD = fromTsEbml.resolve('ebml').replace(/ebml\.js$/, 'ebml.umd.js');

// onnxruntime-web's bundles name their wasm with `new URL('ort-wasm-simd-threaded.asyncify.wasm', import.meta.url)`,
// so Vite emitted a second 26.9 MB copy under assets/. The extension always sets `wasmPaths` to the copy in
// public/ort (scripts/copy-wasm-assets.mjs), so point that default at it too and let Vite emit nothing
// (docs/spikes/README.md "Build size", ADR 0024).
const ORT_WASM_REF = /new URL\((["'])(ort-wasm-simd-threaded\.asyncify\.wasm)\1,\s*import\.meta\.url\)/g;
const dedupeOrtWasm = {
  name: 'var:dedupe-ort-wasm',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('onnxruntime-web') || !ORT_WASM_REF.test(code)) return null;
    ORT_WASM_REF.lastIndex = 0;
    return { code: code.replace(ORT_WASM_REF, 'new URL("/ort/$2", self.location.href)'), map: null };
  },
};

// vad-web imports `onnxruntime-web/wasm` from the root dependency (1.30), whose plain wasm build shipped as a second
// 14 MB file in public/vad. Resolve that import to the onnxruntime-web build transformers.js pins (1.31-dev), in its
// WebGPU flavour, so the VAD loads the same public/ort/ort-wasm-simd-threaded.asyncify.wasm as Whisper and one ORT
// wasm file ships (ADR 0024). vad-web only uses InferenceSession, Tensor and env.wasm, which
// are unchanged across these versions; tests/e2e/ort-assets.spec.ts and the Voice Command e2e run the VAD on it.
const fromTransformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'));
const TRANSFORMERS_ORT = fromTransformers
  .resolve('onnxruntime-web/webgpu')
  .replace(/ort\.webgpu\.min\.js$/, 'ort.webgpu.bundle.min.mjs');
const vadUsesTransformersOrt = {
  name: 'var:vad-uses-transformers-ort',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (importer?.includes('@ricky0123/vad-web') && /^onnxruntime-web(\/wasm)?$/.test(source)) return TRANSFORMERS_ORT;
    return null;
  },
};

// Only the release workflows set INKUP_RELEASE_BUILD=1. Every other build (`wxt dev`, `pnpm build`, build:firefox,
// build:safari) is a development build: its icons carry construction stripes (src/lib/dev-stripes.ts). The
// background reads it as __INKUP_RELEASE_BUILD__; the manifest's icons come from scripts/dev-icons.ts.
const RELEASE_BUILD = process.env.INKUP_RELEASE_BUILD === '1';

// A development build points the manifest's icons at striped copies of public/icon, made at build time. The action
// has no default_icon of its own, so the browser shows these in the toolbar too until the background draws.
function devIconsManifest(manifest: Browser.runtime.Manifest) {
  if (!manifest.icons) return;
  manifest.icons = Object.fromEntries(
    Object.entries(manifest.icons).map(([size, path]) => [size, path.replace(/^\/?icon\//, 'icon-dev/')]),
  );
}

/** A GUID, so no domain is claimed. */
const FIREFOX_ADDON_ID = '{a8ef2c28-c5c9-44cb-af98-84c05d0a66c7}';

// Firefox (docs/browsers.md): WXT already turns the side panel into sidebar_action and the background into an event
// page. Firefox has no sidePanel or offscreen permission (the sidebar and the background page stand in), and needs
// an add-on id; 140 is the first version that reads data_collection_permissions.
// Firefox has no tabCapture either: the page toolbar's Start is an extension frame that opens the picker itself
// (docs/spikes/toolbar-start.md), so pages may frame that one page. Chrome and Safari list nothing: a web-accessible
// page lets any site detect the extension.
function firefoxManifest(manifest: Browser.runtime.Manifest) {
  manifest.permissions = manifest.permissions?.filter(
    (p) => p !== 'sidePanel' && p !== 'offscreen' && p !== 'tabCapture',
  );
  Object.assign(manifest, {
    browser_specific_settings: {
      gecko: { id: FIREFOX_ADDON_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } },
    },
    web_accessible_resources: [{ resources: ['toolbar-start.html'], matches: ['<all_urls>'] }],
  });
}

// See docs/PLAN.md "Manifest" and docs/adr/0003-all-sites-host-permission.md.
export default defineConfig({
  srcDir: 'src',
  publicDir: 'public',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'InkUp',
    description: 'Record a spoken, drawn-on review of a web page and turn it into located Change Items.',
    // `scripting` is beyond P0-14's list: it injects the content script into tabs already open at install
    // (ADR 0003). `activeTab` lets the `snap` shortcut screenshot pages `<all_urls>` does not cover
    // (other extensions' pages, chrome://); it adds no install warning (ADR 0003).
    // `tabCapture` records the tab's video for a Session started from the page toolbar or Alt+Shift+R, where no
    // panel click can open the picker (docs/spikes/toolbar-start.md); Chrome only.
    permissions: [
      'sidePanel',
      'offscreen',
      'storage',
      'alarms',
      'unlimitedStorage',
      'downloads',
      'tabs',
      'scripting',
      'activeTab',
      'tabCapture',
    ],
    host_permissions: ['<all_urls>'],
    // A Host on another computer (network mode, ADR 0006) is plain http and ws on the LAN. `<all_urls>` covers it
    // already; the options page asks for these on Find hubs or Connect, so a browser that has not granted
    // `<all_urls>` (Firefox lets the user withhold it) still reaches the LAN Host once the reviewer agrees.
    optional_host_permissions: ['http://*/*', 'ws://*/*'],
    commands: {
      'toggle-session': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Start a Session on this tab, or stop the one recording',
      },
      'open-panel': {
        suggested_key: { default: 'Alt+Shift+P' },
        description: 'Open the panel',
      },
      'toggle-draw': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Toggle draw mode',
      },
      snap: {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Take a screenshot (the only way on pages where drawing is off)',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: { default_title: 'InkUp' },
  },
  // The Firefox sources zip AMO reviewers rebuild from (docs/browsers.md): the part of the pnpm workspace the build
  // reads, from the repo root, so @inkup/core and @inkup/protocol come along. Patterns are relative to the repo root.
  // public/ort and public/vad are copied from node_modules on install. scripts/verify-sources-zip.sh rebuilds from it.
  zip: {
    sourcesRoot: fileURLToPath(new URL('../..', import.meta.url)),
    includeSources: [
      'SOURCE_BUILD.md',
      'LICENSE',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      // The root `prepare` script; without a .git it exits at once.
      'scripts/install-hooks.mjs',
      'packages/{core,protocol}/{package.json,tsconfig.json}',
      'packages/{core,protocol}/src/**',
      'extensions/web/{package.json,tsconfig.json,wxt.config.ts,components.json}',
      'extensions/web/{src,public,assets}/**',
      'extensions/web/scripts/{copy-wasm-assets.mjs,dev-icons.ts}',
    ],
    excludeSources: ['extensions/web/public/{ort,vad}/**', '**/tests/**', '**/test/**', '**/fixtures/**'],
  },
  vite: () => ({
    define: { __INKUP_RELEASE_BUILD__: JSON.stringify(RELEASE_BUILD) },
    plugins: [tailwindcss(), dedupeOrtWasm, vadUsesTransformersOrt],
    resolve: { alias: [{ find: /^ebml$/, replacement: EBML_UMD }] },
  }),
  hooks: {
    'build:publicAssets': (wxt, files) => {
      if (RELEASE_BUILD) return;
      const out = join(wxt.config.wxtDir, 'dev-icons');
      for (const size of writeDevIcons(join(wxt.config.publicDir, 'icon'), out)) {
        files.push({ absoluteSrc: join(out, `${size}.png`), relativeDest: `icon-dev/${size}.png` });
      }
    },
    'build:manifestGenerated': (wxt, manifest) => {
      if (!RELEASE_BUILD) devIconsManifest(manifest);
      if (wxt.config.browser === 'firefox') firefoxManifest(manifest);
      // Safari has no side panel, offscreen document or downloads API; its adapter uses windows and a download link
      // instead (src/platform/safari, docs/spikes/safari.md), so the manifest does not ask for them.
      if (wxt.config.browser === 'safari') {
        delete manifest.side_panel;
        manifest.permissions = manifest.permissions?.filter(
          (p) => !['sidePanel', 'offscreen', 'downloads', 'tabCapture'].includes(p),
        );
        // `<all_urls>` covers the LAN Host in Safari; its manifest keeps to what docs/spikes/safari.md verified.
        delete (manifest as { optional_host_permissions?: string[] }).optional_host_permissions;
      }
    },
  },
});
