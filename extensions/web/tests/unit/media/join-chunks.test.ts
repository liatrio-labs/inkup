// Stop's chunk join (src/media/join-chunks.ts): a Blob built out of blobs IndexedDB serves can get the extension
// process killed in Chromium, so the join reads each chunk's bytes and builds the file from those alone.
import { describe, expect, it } from 'vitest';
import { joinChunks } from '@/media/join-chunks';

/** A chunk that can only be read: used as a Blob part, it would come out as the text "[object Object]". */
const readOnly = (text: string) =>
  ({ arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer }) as unknown as Blob;

describe('joinChunks', () => {
  it('joins the bytes in order under the given type', async () => {
    const joined = await joinChunks([new Blob(['one ']), new Blob(['two ']), new Blob(['three'])], 'audio/webm');
    expect(joined.type).toBe('audio/webm');
    expect(await joined.text()).toBe('one two three');
  });

  it('builds the file from the bytes it read, never from the chunks themselves', async () => {
    const joined = await joinChunks([readOnly('a'), readOnly('b')], 'video/webm');
    expect(await joined.text()).toBe('ab');
  });

  it('fails when a chunk cannot be read yet, so the caller can try again', async () => {
    const unreadable = {
      arrayBuffer: async () => {
        throw new DOMException('not readable', 'NotReadableError');
      },
    } as unknown as Blob;
    await expect(joinChunks([new Blob(['a']), unreadable], 'video/webm')).rejects.toThrow('not readable');
  });

  it('is an empty file of the type for no chunks', async () => {
    const joined = await joinChunks([], 'audio/webm');
    expect(joined.size).toBe(0);
    expect(joined.type).toBe('audio/webm');
  });
});
