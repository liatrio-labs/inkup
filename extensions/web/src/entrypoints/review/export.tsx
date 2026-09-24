// Export (PRD P0-13): the folder as one zip, built here because service workers cannot make object URLs
// (Chromium 40876652). client-zip streams the files without recompressing the WebM; the zip becomes a Blob that
// the platform saves (chrome.downloads, or a download link where there is no downloads API). After a successful
// export the page offers to delete the Session's video and audio.

import { exportFileName, planExport } from '@inkup/core/export/bundle';
import { allPrompts } from '@inkup/core/export/prompts';
import type { ChangeItem } from '@inkup/core/process/change-item';
import { downloadZip } from 'client-zip';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { deleteSessionMedia } from '@/db/review';
import { loadSessionDocument } from '@/db/session-export';
import { platform } from '@/platform';

type State =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'downloading'; name: string }
  | { kind: 'done'; name: string; files: number }
  | { kind: 'error'; message: string }
  | { kind: 'media_deleted' };

export function ExportControls({ sessionId, hasMedia }: { sessionId: string; hasMedia: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function exportZip() {
    setState({ kind: 'building' });
    try {
      const doc = await loadSessionDocument(db, sessionId);
      const plan = planExport(doc);
      if (plan.issues.length) throw new Error(plan.issues.join('; '));
      const now = new Date();
      const files = await Promise.all(
        plan.files.map(async (f) => {
          if ('text' in f) return { name: f.path, input: f.text, lastModified: now };
          const row = await db.blobs.get(f.blob_id);
          if (!row) throw new Error(`${f.path} is missing from storage`);
          return { name: f.path, input: row.blob, lastModified: now };
        }),
      );
      const name = exportFileName(doc);
      const zip = await downloadZip(files).blob();
      setState({ kind: 'downloading', name });
      const result = await platform.saveFile(zip, name);
      if (!result.ok) throw new Error(`the download failed (${result.error})`);
      if (result.downloadId !== null) document.body.dataset.exportDownloadId = String(result.downloadId);
      setState({ kind: 'done', name, files: files.length });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function dropMedia() {
    await deleteSessionMedia(sessionId);
    setState({ kind: 'media_deleted' });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={exportZip}
        disabled={state.kind === 'building' || state.kind === 'downloading'}
        data-testid="export-zip"
      >
        {state.kind === 'building' ? 'Building zip…' : state.kind === 'downloading' ? 'Saving…' : 'Export'}
      </Button>
      {state.kind === 'done' && (
        <div className="flex max-w-md flex-col gap-2 rounded-lg border p-3" role="status" data-testid="export-done">
          <p>
            Saved {state.name} ({state.files} files) to your downloads.
          </p>
          {hasMedia && (
            <>
              <p className="text-muted-foreground">
                Delete this Session&apos;s video and audio to free space? The transcript, screenshots and Change Items
                stay.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={dropMedia} data-testid="delete-media">
                  Delete video and audio
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setState({ kind: 'idle' })} data-testid="keep-media">
                  Keep them
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {state.kind === 'media_deleted' && (
        <p role="status" data-testid="media-deleted">
          Video and audio deleted. The transcript, screenshots and Change Items are kept.
        </p>
      )}
      {state.kind === 'error' && (
        <p role="alert" className="max-w-md text-destructive" data-testid="export-error">
          Export failed: {state.message}
        </p>
      )}
    </div>
  );
}

export function CopyAllPrompts({ items }: { items: ChangeItem[] }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: other items are the trigger to clear the copied note
  useEffect(() => setCopied(null), [items]);
  return (
    <Button
      variant="outline"
      disabled={items.length === 0}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(allPrompts(items));
          setCopied('ok');
        } catch {
          setCopied('failed');
        }
      }}
      data-testid="copy-all-prompts"
    >
      {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy all prompts'}
    </Button>
  );
}
