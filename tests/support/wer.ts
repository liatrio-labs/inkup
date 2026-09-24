// Word error rate for the transcription proofs (pnpm eval:stt, pnpm test:e2e:whisper): word-level Levenshtein
// distance (substitutions + deletions + insertions) over the reference length, after lower-casing and dropping
// punctuation, so "Header." and "header" match.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length]! / ref.length;
}

export const AUDIO_DIR = join(import.meta.dirname, '../../fixtures/audio');

/** The spoken words of a fixture WAV: its sidecar script without the `~` silences. */
export function fixtureReference(name: string): string {
  return readFileSync(join(AUDIO_DIR, `${name}.txt`), 'utf8')
    .trim()
    .split('|')
    .filter((s) => !s.startsWith('~'))
    .join(' ');
}

/** The spoken clips of a fixture (seconds), when it has a .timing.json. */
export function fixtureTiming(name: string): { start: number; end: number; text: string }[] | null {
  try {
    return JSON.parse(readFileSync(join(AUDIO_DIR, `${name}.timing.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** A 16 kHz mono PCM16 WAV's samples (the fixtures' format; scripts/gen-fixture-audio.sh). */
export function readPcm16Wav(name: string): { sampleRate: number; samples: Int16Array } {
  const buf = readFileSync(join(AUDIO_DIR, `${name}.wav`));
  let off = 12;
  let sampleRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (buf.readUInt16LE(off + 8) !== 1 || buf.readUInt16LE(off + 10) !== 1 || buf.readUInt16LE(off + 22) !== 16)
        throw new Error(`${name}.wav is not mono PCM16`);
      sampleRate = buf.readUInt32LE(off + 12);
    } else if (id === 'data') {
      const data = buf.subarray(off + 8, off + 8 + size);
      return {
        sampleRate,
        samples: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
      };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`${name}.wav has no data chunk`);
}

export const FIXTURE_NAMES = [
  'voice-session',
  'drafts-session',
  'review-two-notes',
  'review-scratch-that',
  'voice-commands',
] as const;
