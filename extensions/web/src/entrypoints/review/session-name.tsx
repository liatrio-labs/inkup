// The review page's title: the Session's name (sessionName), renamed in place. Click it to edit; Enter or leaving
// the field saves a `session_rename`, Esc cancels. The Sessions list, the Host and the exports use the new name.

import { PencilIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { appendReviewEvent } from '@/db/review';

export function SessionName({ sessionId, name, editable }: { sessionId: string; name: string; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and Esc end editing before the field unmounts; its blur must not save a second time.
  const settled = useRef(false);
  // The new name until the stored event comes back as `name`, so the old one does not flash.
  const [pending, setPending] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new stored name is the trigger to drop the pending one
  useEffect(() => setPending(null), [name]);
  const shown = pending ?? name;

  async function save(value: string) {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = value.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!next || next === shown) return;
    setPending(next);
    try {
      await appendReviewEvent(sessionId, { type: 'session_rename', name: next });
      setError(null);
    } catch (e) {
      setPending(null);
      setError(`Could not rename the Session: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight" data-testid="session-name">
        {editing ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the reviewer just clicked the name to edit it
            autoFocus
            className="w-full rounded-md border border-ring bg-background px-2 py-0.5 -mx-2 outline-none ring-[3px] ring-ring/50"
            defaultValue={shown}
            maxLength={200}
            aria-label="Session name"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => void save(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save(e.currentTarget.value);
              else if (e.key === 'Escape') {
                settled.current = true;
                setEditing(false);
              }
            }}
            data-testid="session-name-input"
          />
        ) : (
          <button
            type="button"
            className="group -mx-2 inline-flex max-w-full items-center gap-2 rounded-md px-2 py-0.5 text-left hover:bg-muted disabled:hover:bg-transparent"
            onClick={() => {
              settled.current = false;
              setEditing(true);
            }}
            disabled={!editable}
            title={editable ? 'Rename this Session' : 'A Session can be renamed once it has ended'}
            data-testid="rename-session"
          >
            <span className="min-w-0 break-words">{shown}</span>
            {editable && (
              <PencilIcon
                className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden="true"
              />
            )}
          </button>
        )}
      </h1>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
