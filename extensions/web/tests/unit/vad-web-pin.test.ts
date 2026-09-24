// src/entrypoints/offscreen/voice.ts feeds vad-web's MicVAD by hand: it resumes the private frameProcessor,
// calls processFrame and releases the private model (docs/decisions-log.md "Speech before the VAD loads").
// package.json's "^0.0.31" already allows only 0.0.31 (a caret on 0.0.x pins the patch).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('vad-web pin', () => {
  it('is 0.0.31, whose private API voice.ts relies on', () => {
    const pkg = JSON.parse(readFileSync(require.resolve('@ricky0123/vad-web/package.json'), 'utf8')) as {
      version: string;
    };
    expect(
      pkg.version,
      'vad-web changed: recheck voice.ts private-API use (frameProcessor.resume, processFrame, model.release) before bumping',
    ).toBe('0.0.31');
  });

  it('still has the private members voice.ts uses', () => {
    const src = readFileSync(require.resolve('@ricky0123/vad-web/dist/real-time-vad.js'), 'utf8');
    for (const member of [
      'this.processFrame =',
      'this.frameProcessor =',
      'this.model =',
      'this.frameProcessor.resume()',
    ]) {
      expect(src, `vad-web no longer has ${member}: recheck voice.ts before bumping`).toContain(member);
    }
  });
});
