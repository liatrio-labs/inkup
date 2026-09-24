// Puts a whole Session (a session.json document, e.g. the synthetic long one from scripts/gen-long-session.ts)
// straight into the extension's IndexedDB, so tests can Process a 40-minute Session without recording it.
// Screenshots get a 1×1 PNG each. Run from any extension page that has opened the database.
import type { Page } from '@playwright/test';
import type { SessionDocument } from '../../../packages/core/src/session-document.ts';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function seedSession(page: Page, doc: SessionDocument): Promise<void> {
  await page.evaluate(
    async ({ doc, png }) => {
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('inkup');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const tx = idb.transaction(['sessions', 'events', 'blobs'], 'readwrite');
      tx.objectStore('sessions').put({ ...doc.session, audio: null, video: null });
      for (const e of doc.events) tx.objectStore('events').add({ ...e, session_id: doc.session.id });
      for (const b of doc.blobs.filter((x) => x.kind === 'screenshot')) {
        tx.objectStore('blobs').put({
          id: b.id,
          session_id: doc.session.id,
          kind: 'screenshot',
          mime: 'image/png',
          size: bytes.length,
          t: 0,
          seq: 0,
          blob: new Blob([bytes], { type: 'image/png' }),
        });
      }
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      idb.close();
    },
    { doc: JSON.parse(JSON.stringify(doc)) as SessionDocument, png: PNG_1X1 },
  );
}

/** Rows of one IndexedDB store, read from an extension page. */
export async function storeRows<T = unknown>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (name) => {
    const idb = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('inkup');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const rows = await new Promise<unknown[]>((res, rej) => {
      const r = idb.transaction(name).objectStore(name).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    idb.close();
    return rows;
  }, store) as Promise<T[]>;
}
