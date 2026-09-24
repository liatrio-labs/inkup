// Saves through the downloads API: the Blob becomes an object URL that chrome.downloads saves, revoked when the
// download ends. Firefox has the same API, so its adapter can reuse this.
import type { SavedFile } from '../types';

export function saveWithDownloadsApi(blob: Blob, filename: string): Promise<SavedFile> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    let id: number | null = null;
    let settled = false;
    const finish = (result: SavedFile) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish({ ok: true, downloadId: id });
      else if (delta.state.current === 'interrupted')
        finish({ ok: false, error: delta.error?.current ?? 'interrupted' });
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads
      .download({ url, filename, saveAs: false })
      .then((downloadId) => {
        id = downloadId;
        // A small file can finish before its id is known here; its onChanged was then ignored.
        return chrome.downloads.search({ id: downloadId }).then(([item]) => {
          if (item?.state === 'complete') finish({ ok: true, downloadId });
          else if (item?.state === 'interrupted') finish({ ok: false, error: item.error ?? 'interrupted' });
        });
      })
      .catch((e: unknown) => {
        chrome.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(url);
        reject(e);
      });
  });
}
