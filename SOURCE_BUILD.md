# Building InkUp for Firefox from source

This is the source for the InkUp Firefox add-on, as uploaded to addons.mozilla.org. It is a pnpm workspace: the
extension is `extensions/web`, and it imports the workspace packages `packages/core` (`@inkup/core`) and
`packages/protocol` (`@inkup/protocol`).

Requirements: Node.js 26 and pnpm 12 (`corepack enable pnpm`, or `npm install -g pnpm@12`), on macOS or Linux.

From the directory this file is in:

```sh
pnpm install --frozen-lockfile
pnpm build:firefox
```

The built add-on is `extensions/web/.output/firefox-mv3/`; its `manifest.json` matches the submitted one.
`pnpm zip:firefox` packs the same build as `extensions/web/.output/inkup-<version>-firefox.zip`.

`pnpm install` copies the ONNX Runtime and Silero VAD files the extension ships (`extensions/web/public/ort` and
`public/vad`) out of `node_modules`, from the versions `pnpm-lock.yaml` pins. They are not in this archive.

The full repository, with tests and the local Host, is <https://github.com/liatrio-labs/inkup>.
