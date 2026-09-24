import { describe, expect, it } from 'vitest';
import { createAudioOffsetMap, floatToPcm16, pcm16ToBase64, pcm16ToFloat } from '../src/audio-offsets';
import { mediaToSession, pauseGaps } from '../src/media-time';

describe('floatToPcm16', () => {
  it('scales, rounds and clamps to 16-bit', () => {
    expect([...floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -3]))]).toEqual([
      0, 32767, -32768, 16384, -16384, 32767, -32768,
    ]);
  });
  it('round-trips through pcm16ToFloat within one step', () => {
    const f = new Float32Array([0.25, -0.75, 0.001]);
    const back = pcm16ToFloat(floatToPcm16(f));
    f.forEach((v, i) => {
      expect(Math.abs(back[i]! - v)).toBeLessThan(1 / 16384);
    });
  });
});

describe('pcm16ToBase64', () => {
  it('encodes little-endian bytes like Buffer does', () => {
    for (const n of [0, 1, 2, 3, 7]) {
      const pcm = Int16Array.from({ length: n }, (_, i) => (i * 12345 - 20000) | 0);
      const expected = Buffer.from(new Uint8Array(pcm.buffer)).toString('base64');
      expect(pcm16ToBase64(pcm)).toBe(expected);
    }
  });
});

describe('createAudioOffsetMap', () => {
  it('maps engine seconds through the frames sent, at 16 kHz', () => {
    const m = createAudioOffsetMap(16000);
    // Three 100 ms frames captured from Session time 5000.
    m.sent(5000, 1600);
    m.sent(5100, 1600);
    m.sent(5200, 1600);
    expect(m.sentSeconds).toBeCloseTo(0.3);
    expect(m.toSession(0)).toBe(5000);
    expect(m.toSession(0.05)).toBe(5050);
    expect(m.toSession(0.15)).toBe(5150);
    expect(m.toSession(0.3)).toBe(5300);
  });

  it('jumps over a pause gap: no audio was sent while paused', () => {
    const m = createAudioOffsetMap(16000);
    m.sent(1000, 16000); // 1 s of audio: Session 1000–2000
    // Paused from 2000 to 9000; the next frame was captured at the resume.
    m.sent(9000, 16000); // Session 9000–10000
    expect(m.toSession(0.5)).toBe(1500);
    expect(m.toSession(1.0)).toBe(9000);
    expect(m.toSession(1.25)).toBe(9250);
  });

  it('agrees with media-time.ts for the same pause (a word lands where the recorder file puts it)', () => {
    const m = createAudioOffsetMap(16000);
    // The stream and the recorder both start at 1000; the Session pauses 2000–9000.
    m.sent(1000, 16000);
    m.sent(9000, 16000);
    const clock = {
      start_offset_ms: 1000,
      gaps: pauseGaps([
        { type: 'session_pause', t: 2000 },
        { type: 'session_resume', t: 9000 },
      ]),
    };
    for (const s of [0.1, 0.9, 1.1, 1.9]) expect(m.toSession(s)).toBe(Math.round(mediaToSession(s * 1000, clock)));
  });

  it('clamps an end that falls past a frame to the frame end, never into the next gap', () => {
    const m = createAudioOffsetMap(16000);
    m.sent(0, 1600);
    expect(m.toSession(5)).toBe(100);
  });

  it('maps replayed frames (buffered while reconnecting) to their capture time, not the send time', () => {
    const m = createAudioOffsetMap(16000);
    // A new connection: the first frames sent were captured 2 s earlier, while the socket was down.
    m.sent(20_000, 1600);
    m.sent(20_100, 1600);
    m.sent(22_000, 1600);
    expect(m.toSession(0.15)).toBe(20_150);
    expect(m.toSession(0.21)).toBe(22_010);
  });

  it('is empty-safe', () => {
    expect(createAudioOffsetMap().toSession(3)).toBe(0);
  });
});
