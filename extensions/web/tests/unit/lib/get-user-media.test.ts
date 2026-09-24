// The microphone retry (src/lib/get-user-media.ts): AbortError is retried with a growing wait, other errors are not.
import { describe, expect, it } from 'vitest';
import { getUserMediaWithRetry, MIC_ABORT_RETRIES } from '@/lib/get-user-media';

const stream = { id: 'mic' } as unknown as MediaStream;
const abort = () => new DOMException('Failed due to shutdown', 'AbortError');

function fake(errors: DOMException[]) {
  const calls: number[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  return {
    calls,
    waits,
    logs,
    opts: {
      gum: async () => {
        calls.push(calls.length);
        const e = errors.shift();
        if (e) throw e;
        return stream;
      },
      wait: async (ms: number) => void waits.push(ms),
      log: (attempt: number, message: string) => void logs.push(`${attempt}:${message}`),
    },
  };
}

describe('getUserMediaWithRetry', () => {
  it('asks again after "Failed due to shutdown" and returns the stream', async () => {
    const f = fake([abort(), abort()]);
    await expect(getUserMediaWithRetry({ audio: true }, f.opts)).resolves.toBe(stream);
    expect(f.calls).toHaveLength(3);
    expect(f.waits).toEqual([250, 500]);
    expect(f.logs).toEqual(['0:Failed due to shutdown', '1:Failed due to shutdown']);
  });

  it('gives up after the last retry with the AbortError', async () => {
    const f = fake(Array.from({ length: MIC_ABORT_RETRIES + 1 }, abort));
    await expect(getUserMediaWithRetry({ audio: true }, f.opts)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(MIC_ABORT_RETRIES + 1);
  });

  it('does not retry a real answer such as NotAllowedError', async () => {
    const f = fake([new DOMException('Permission denied', 'NotAllowedError')]);
    await expect(getUserMediaWithRetry({ audio: true }, f.opts)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(f.calls).toHaveLength(1);
    expect(f.waits).toEqual([]);
  });
});
