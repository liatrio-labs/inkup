// Copies locally-bundled ONNX Runtime (ORT) wasm/mjs files and the Silero VAD model into public/.
// MV3 forbids remote code, so every .mjs/.wasm the runtimes load must ship inside the extension.
// Run automatically on postinstall so the copies always match the installed package versions.
//
//   public/vad/  -> @ricky0123/vad-web worklet + Silero models
//   public/ort/  -> the onnxruntime-web build pinned by @huggingface/transformers. The VAD runs on it too
//                   (wxt.config.ts `vadUsesTransformersOrt`), so only one ORT wasm ships.

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(root, 'package.json'));

const pkgDir = (name, from = req) => {
  const main = from.resolve(name);
  let dir = dirname(main);
  while (!readdirSync(dir).includes('package.json')) dir = dirname(dir);
  return dir;
};

function copy(files, fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const f of files) cpSync(join(fromDir, f), join(toDir, f));
  console.log(`copied ${files.length} files -> ${toDir.replace(`${root}/`, '')}`);
}

// vad-web
const vadDist = join(pkgDir('@ricky0123/vad-web'), 'dist');
rmSync(join(root, 'public/vad'), { recursive: true, force: true });
copy(['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx'], vadDist, join(root, 'public/vad'));

// transformers.js
const tfDir = pkgDir('@huggingface/transformers');
const tfOrtDist = join(pkgDir('onnxruntime-web', createRequire(join(tfDir, 'package.json'))), 'dist');
rmSync(join(root, 'public/ort'), { recursive: true, force: true });
copy(
  ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'],
  tfOrtDist,
  join(root, 'public/ort'),
);
