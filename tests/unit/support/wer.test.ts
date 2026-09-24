// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureReference, normalizeWords, readPcm16Wav, wordErrorRate } from '../../support/wer';

describe('wordErrorRate', () => {
  it('ignores case and punctuation', () => {
    expect(normalizeWords("This button, should go in the Header. It's")).toEqual([
      'this',
      'button',
      'should',
      'go',
      'in',
      'the',
      'header',
      'its',
    ]);
    expect(wordErrorRate('this button should go', 'This button, should go.')).toBe(0);
  });
  it('counts substitutions, deletions and insertions over the reference length', () => {
    expect(wordErrorRate('a b c d', 'a x c d')).toBe(0.25);
    expect(wordErrorRate('a b c d', 'a c d')).toBe(0.25);
    expect(wordErrorRate('a b c d', 'a b c d e f')).toBe(0.5);
    expect(wordErrorRate('a b', '')).toBe(1);
    expect(wordErrorRate('', '')).toBe(0);
  });
});

describe('fixture audio for the transcription proofs', () => {
  it.each(FIXTURE_NAMES)('%s: 16 kHz PCM16 with a reference script', (name) => {
    const wav = readPcm16Wav(name);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.samples.length).toBeGreaterThan(16000 * 5);
    expect(fixtureReference(name)).not.toContain('~');
  });
});
