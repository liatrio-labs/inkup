// Read the live Session straight from the extension's storage and IndexedDB, so e2e tests can assert on the
// timeline while recording, without Stop and a download.
import type { Page, Worker } from '@playwright/test';
import type { TimelineEvent } from '../../../packages/core/src/timeline.ts';

export async function activeSessionId(sw: Worker): Promise<string | null> {
  return sw.evaluate(
    async () =>
      ((await chrome.storage.session.get('activeSession')).activeSession as { id: string } | null)?.id ?? null,
  );
}

/** Every stored event of a Session, in log order (t, then append order). Run in any extension page. */
export async function sessionEvents(extPage: Page, sessionId: string): Promise<TimelineEvent[]> {
  const rows = await extPage.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise<unknown[]>((res, rej) => {
      const r = idb.transaction('events').objectStore('events').index('session_id').getAll(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }, sessionId);
  return (rows as (TimelineEvent & { seq: number })[]).sort((a, b) => a.t - b.t || a.seq - b.seq);
}

export const ofType = <T extends TimelineEvent['type']>(events: TimelineEvent[], type: T) =>
  events.filter((e): e is Extract<TimelineEvent, { type: T }> => e.type === type);

/** RGB of one pixel (image coordinates) of a stored screenshot blob. Run in any extension page. */
export async function screenshotPixel(
  extPage: Page,
  screenshotId: string,
  x: number,
  y: number,
): Promise<[number, number, number] | null> {
  return extPage.evaluate(
    async ({ id, x, y }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const row = await new Promise<{ blob: Blob } | undefined>((res, rej) => {
        const r = idb.transaction('blobs').objectStore('blobs').get(id);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (!row) return null;
      const bmp = await createImageBitmap(row.blob);
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!] as [number, number, number];
    },
    { id: screenshotId, x, y },
  );
}

/** A stored screenshot blob as base64 PNG. Run in any extension page. */
export async function screenshotPng(extPage: Page, screenshotId: string): Promise<string | null> {
  return extPage.evaluate(async (id) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const row = await new Promise<{ blob: Blob } | undefined>((res, rej) => {
      const r = idb.transaction('blobs').objectStore('blobs').get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!row) return null;
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, screenshotId);
}
