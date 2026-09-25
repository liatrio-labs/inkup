import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STRIPE_RGB, stripedIcon } from '@/lib/dev-stripes';
import { decodePng, encodePng, writeDevIcons } from '../../scripts/dev-icons';

const iconDir = join(import.meta.dirname, '../../public/icon');

describe('the static development icons (scripts/dev-icons.ts)', () => {
  it('reads the committed icons and writes PNGs that read back to the same pixels', () => {
    for (const size of [16, 32, 48, 96, 128]) {
      const icon = decodePng(readFileSync(join(iconDir, `${size}.png`)));
      expect([icon.width, icon.height]).toEqual([size, size]);
      const striped = stripedIcon(icon, size);
      const back = decodePng(encodePng(striped));
      expect(back.data).toEqual(striped.data);
    }
  });

  it('writes a striped copy of every public/icon size, the same bytes each time', () => {
    const out = mkdtempSync(join(tmpdir(), 'dev-icons-'));
    try {
      expect(writeDevIcons(iconDir, out)).toEqual([16, 32, 48, 96, 128]);
      const first = readFileSync(join(out, '128.png'));
      writeDevIcons(iconDir, out);
      expect(readFileSync(join(out, '128.png')).equals(first)).toBe(true);
      const px = decodePng(first);
      expect(Array.from(px.data.subarray(0, 4))).toEqual([...STRIPE_RGB[0], 255]);
    } finally {
      rmSync(out, { recursive: true });
    }
  });
});
