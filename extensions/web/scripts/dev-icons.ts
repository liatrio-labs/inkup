// The static icons of a development build (src/lib/dev-stripes.ts): the manifest's icons, which the browser shows
// before the background draws and on its extensions page. wxt.config.ts writes a striped copy of each
// public/icon/<size>.png into .wxt/dev-icons and points the manifest at icon-dev/<size>.png. A release build keeps
// public/icon as it is. The PNG code handles what scripts/gen-icons.sh writes (8-bit RGBA, not interlaced), with
// node:zlib, so the build needs no image library.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { type Pixels, stripedIcon } from '../src/lib/dev-stripes';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(png: Buffer): Pixels {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8);
      if (depth !== 8 || colour !== 6 || interlace !== 0) throw new Error('only 8-bit RGBA, non-interlaced PNGs');
    } else if (type === 'IDAT') idat.push(body);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? data[y * stride + i - 4]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y > 0 ? data[(y - 1) * stride + i - 4]! : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[y * stride + i] = (line[i]! + pred) & 0xff;
    }
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), body])) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

export function encodePng({ width, height, data }: Pixels): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Writes the striped icon for every public/icon/<size>.png into `outDir`, and returns the sizes. */
export function writeDevIcons(iconDir: string, outDir: string): number[] {
  mkdirSync(outDir, { recursive: true });
  const sizes = readdirSync(iconDir)
    .map((f) => /^(\d+)\.png$/.exec(f)?.[1])
    .filter((s): s is string => s !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  for (const size of sizes) {
    const icon = decodePng(readFileSync(join(iconDir, `${size}.png`)));
    writeFileSync(join(outDir, `${size}.png`), encodePng(stripedIcon(icon, size)));
  }
  return sizes;
}
