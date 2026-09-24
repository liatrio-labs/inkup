// Guards the checked-in fixture WAVs (scripts/gen-fixture-audio.sh): format and the deliberate silences
// that Voice Command and VAD tests depend on.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AUDIO = join(__dirname, '../../fixtures/audio');

function readWav(file: string) {
  const buf = readFileSync(file);
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      const samples = new Int16Array(buf.buffer, buf.byteOffset + off + 8, size / 2);
      return { ...fmt!, samples };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

/** Silent runs of at least `minSec`, from 20 ms RMS windows below -45 dBFS. */
function silences(samples: Int16Array, rate: number, minSec: number) {
  const win = rate / 50;
  const runs: { start: number; end: number }[] = [];
  let runStart: number | undefined;
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += (samples[j]! / 32768) ** 2;
    const db = 10 * Math.log10(sum / win + 1e-12);
    const t = i / rate;
    if (db < -45) runStart ??= t;
    else if (runStart !== undefined) {
      if (t - runStart >= minSec) runs.push({ start: runStart, end: t });
      runStart = undefined;
    }
  }
  const end = samples.length / rate;
  if (runStart !== undefined && end - runStart >= minSec) runs.push({ start: runStart, end });
  return runs;
}

const wavs = readdirSync(AUDIO).filter((f) => f.endsWith('.wav'));

describe('fixture audio', () => {
  it('has the expected fixtures', () => {
    expect(wavs.sort()).toEqual([
      'drafts-session.wav',
      'review-scratch-that.wav',
      'review-two-notes.wav',
      'voice-commands.wav',
      'voice-session.wav',
    ]);
  });

  it.each(wavs)('%s is 16 kHz mono PCM16 with one ≥1.2s silence per scripted gap', (name) => {
    const wav = readWav(join(AUDIO, name));
    expect(wav).toMatchObject({ channels: 1, sampleRate: 16000, bits: 16 });
    const script = readFileSync(join(AUDIO, name.replace('.wav', '.txt')), 'utf8').trim();
    const scriptedGaps = script
      .split('|')
      .filter((p) => p.trim().startsWith('~') && Number(p.trim().slice(1)) >= 1.2).length;
    const found = silences(wav.samples, wav.sampleRate, 1.2);
    expect(found).toHaveLength(scriptedGaps);
  });
});
