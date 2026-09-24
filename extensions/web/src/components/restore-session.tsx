// "Restore from file" (side panel idle state and the Sessions page): pick an export zip or a session.json, and
// the Session comes back into the list. When its id is already stored, a dialog asks Open existing or Replace. While
// a Host is paired, the restored Session goes to it too, whole.

import { readSessionFile, type SessionFile, SessionFileError } from '@inkup/core/session-file';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { db } from '@/db';
import { queueSessionForHost } from '@/db/outbox';
import { restoreSession, SessionClashError } from '@/db/session-import';

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'clash'; file: SessionFile }
  | { kind: 'done'; id: string; title: string; media: boolean }
  | { kind: 'error'; message: string };

const reviewUrl = (id: string) => `/review.html?session=${encodeURIComponent(id)}`;

export function RestoreSession({ size = 'default' }: { size?: 'default' | 'sm' }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function restore(file: SessionFile, replace: boolean) {
    setState({ kind: 'busy' });
    try {
      const r = await restoreSession(db, file, { replace });
      await queueSessionForHost(r.session_id).catch((e: unknown) =>
        console.warn('host: could not queue the restored Session', e),
      );
      setState({
        kind: 'done',
        id: r.session_id,
        title: file.doc.session.start_title || file.doc.session.start_url,
        media: file.source === 'zip',
      });
    } catch (e) {
      if (e instanceof SessionClashError) setState({ kind: 'clash', file });
      else
        setState({
          kind: 'error',
          message: `The Session could not be restored: ${e instanceof Error ? e.message : String(e)}`,
        });
    }
  }

  async function picked(f: File | undefined) {
    if (input.current) input.current.value = '';
    if (!f) return;
    setState({ kind: 'busy' });
    try {
      await restore(await readSessionFile(f), false);
    } catch (e) {
      setState({
        kind: 'error',
        message: e instanceof SessionFileError ? e.message : `The file could not be read: ${String(e)}`,
      });
    }
  }

  const clash = state.kind === 'clash' ? state.file : null;
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        onChange={(e) => void picked(e.target.files?.[0])}
        data-testid="restore-input"
      />
      <Button
        variant="outline"
        size={size}
        onClick={() => input.current?.click()}
        disabled={state.kind === 'busy'}
        data-testid="restore-session"
      >
        {state.kind === 'busy' ? 'Restoring…' : 'Restore from file'}
      </Button>
      {state.kind === 'done' && (
        <p role="status" data-testid="restore-done" data-session={state.id}>
          Restored {state.title}
          {state.media ? '' : ' without screenshots or media: a session.json alone does not carry them'}.{' '}
          <a
            className="text-primary underline"
            href={reviewUrl(state.id)}
            target="_blank"
            data-testid="restore-open-review"
            rel="noopener"
          >
            Open review
          </a>
        </p>
      )}
      {state.kind === 'error' && (
        <p role="alert" className="text-destructive" data-testid="restore-error">
          {state.message}
        </p>
      )}
      <Dialog open={clash !== null} onOpenChange={(open) => !open && setState({ kind: 'idle' })}>
        {clash && (
          <DialogContent data-testid="restore-clash">
            <DialogHeader>
              <DialogTitle>This Session is already stored</DialogTitle>
              <DialogDescription>
                {clash.doc.session.start_title || clash.doc.session.start_url} is in your Sessions. Open the stored
                copy, or replace it with the file. Replace deletes the stored copy, including its review edits and
                Process runs.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" asChild>
                <a
                  href={reviewUrl(clash.doc.session.id)}
                  target="_blank"
                  onClick={() => setState({ kind: 'idle' })}
                  data-testid="clash-open-existing"
                  rel="noopener"
                >
                  Open existing
                </a>
              </Button>
              <Button variant="destructive" onClick={() => void restore(clash, true)} data-testid="clash-replace">
                Replace
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
