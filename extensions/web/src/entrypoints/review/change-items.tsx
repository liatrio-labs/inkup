// Process and the Change Item list on the review page (PRD P0-11, P0-12).
// - Process: estimate → confirm → run, with the failure kept off the Session. Under the reviewer's auto-run threshold
//   (options) the confirm step is skipped, except when the price is unknown, a call is near a model limit (the
//   amber warning), or the run would replace existing items (Process again). While it runs, read-only cards show
//   each chunk's items as they stream in (the processProgress table); the final merged list replaces them.
// - Each item shows how it fared when checked against the recording (vetting): Checked, Corrected or Unverified with
//   the reason. A run that used the video says so; one whose recording was too large to send says that instead.
// - Items: low-confidence first with a "check me" badge; inline edit of title, intent and category; delete;
//   split (a copy to edit); merge two selected items; drag to reorder (@dnd-kit/react). Every change is an
//   `item_edit` event on the run (src/db/review.ts), so edits are logged and the acceptance rate is computable.
// - Merge (E12): the union shows at once; then the merge model rewrites the two items' words as one request
//   ("Combining…"), logged as an `edit` with origin `combine`. The rewrite is dropped if the reviewer changed the
//   card first. On a failure or with no key the concatenated merge stays, noted "Combined without AI".
// - Undo and Redo (F5): buttons, and Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z outside a text field (there the field's own
//   undo runs). Each is an `undo`/`redo` item_edit; review-edits.ts folds them, and a merge and its combine are one
//   step. A combine answer that arrives after an Undo or Redo is dropped.
// - Resolutions: with a paired Host, what an agent is doing or did with an item shows on its card, the latest only:
//   In work (who, since when; MCP start_item), then Done, Won't fix or Needs info with the agent's note. Without a
//   Host there are none, and nothing shows.
import { DragDropProvider } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { type ChangeItem, isLowConfidence, type Location } from '@inkup/core/process/change-item';
import { type CostEstimate, formatUsd, type LimitWarning, shouldAutoRun } from '@inkup/core/process/cost';
import { mergeSources, nextItemId, undoState } from '@inkup/core/review-edits';
import { Category, type ItemEditOp } from '@inkup/core/timeline';
import { useLiveQuery } from 'dexie-react-hooks';
import { GripVertical } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EvidenceShot, locationShot, type ShotIndex } from '@/components/evidence-shot';
import { RESOLUTION_LABEL, RESOLUTION_STYLE } from '@/components/resolution-style';
import { TONE } from '@/components/tone';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { VETTING_LABEL, VETTING_STYLE } from '@/components/vetting-style';
import { db, type ProcessProgressRow, type ProcessRunRow, type ResolutionRow } from '@/db';
import { latestResolutions } from '@/db/resolutions';
import { appendReviewEvent } from '@/db/review';
import { timeAgo, useNow } from '@/lib/time-ago';
import { useRoleHasKey } from '@/lib/use-role-key';
import { useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { sendMessage } from '@/messaging';
import { normalizeProcessingSettings, processingSettings } from '@/settings';

type Phase =
  | { kind: 'idle' }
  | { kind: 'estimating' }
  | { kind: 'confirm'; estimate: CostEstimate; warnings: LimitWarning[] }
  | { kind: 'running' }
  | { kind: 'error'; message: string };

const tokens = (n: number) => n.toLocaleString('en-US');

/** "Part 2 of 4 is about 190,000 input tokens, 95% of …'s 200,000-token context window." */
function limitText(w: LimitWarning, model: string): string {
  const which = w.chunks > 1 ? `Part ${w.chunk} of ${w.chunks}` : 'This run';
  const share = `${Math.round((w.tokens / w.max) * 100)}%`;
  return w.limit === 'context_window'
    ? `${which} is about ${tokens(w.tokens)} input tokens, ${share} of ${model}'s ${tokens(w.max)}-token context window. It may be refused or cut short.`
    : `${which} may need about ${tokens(w.tokens)} output tokens, ${share} of ${model}'s ${tokens(w.max)}-token output limit. Its answer may be cut short.`;
}

const ROLE_LABEL = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

export function ProcessSection({
  sessionId,
  latest,
  done,
  count,
}: {
  sessionId: string;
  latest: ProcessRunRow | undefined;
  done: ProcessRunRow | undefined;
  count: number | null;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const running = phase.kind === 'running' || latest?.status === 'running';
  const hasKey = !!useRoleHasKey('process');
  const threshold = normalizeProcessingSettings(useStorageItem(processingSettings)).autoRunBelowUsd;
  /** The estimate of the last run that started without asking; cleared by the next estimate. */
  const [autoRan, setAutoRan] = useState<{ usd: number; threshold: number } | null>(null);

  async function estimate() {
    setAutoRan(null);
    setPhase({ kind: 'estimating' });
    const r = await sendMessage('estimateProcess', sessionId).catch((e: unknown) => ({
      ok: false as const,
      code: 'api',
      error: String(e),
    }));
    if (!r.ok) return setPhase({ kind: 'error', message: r.error });
    const { estimate: est, warnings } = r;
    if (shouldAutoRun({ usd: est.usd, threshold, done: !!done, warnings }) && threshold !== undefined) {
      setAutoRan({ usd: est.usd!, threshold });
      return run(est);
    }
    setPhase({ kind: 'confirm', estimate: est, warnings });
  }

  async function run(est: CostEstimate | null) {
    setPhase({ kind: 'running' });
    // The worker answers as soon as the run's row exists; the row (latest) carries its progress and outcome, so
    // closing this page or a long run never turns into a failed message.
    const r = await sendMessage('startProcess', { session_id: sessionId, estimate: est }).catch((e: unknown) => ({
      ok: false as const,
      error: String(e),
    }));
    setPhase(r.ok ? { kind: 'idle' } : { kind: 'error', message: r.error });
  }

  const failed = phase.kind === 'error' ? phase.message : latest?.status === 'failed' ? latest.error : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="change-items" className="text-base font-semibold">
          Change Items{count !== null ? ` (${count})` : ''}
        </h2>
        {hasKey ? (
          <Button
            onClick={estimate}
            disabled={running || phase.kind === 'estimating' || phase.kind === 'confirm'}
            data-testid="process-button"
          >
            {running ? 'Processing…' : phase.kind === 'estimating' ? 'Estimating…' : done ? 'Process again' : 'Process'}
          </Button>
        ) : (
          // Without a key the items are built in code (E11): one per Annotation and Text Comment, no network call.
          <div className="flex items-center gap-3">
            <a
              className="text-primary underline"
              href="/options.html"
              target="_blank"
              data-testid="open-options"
              rel="noopener"
            >
              Add a key for model-written items
            </a>
            <Button
              onClick={() => run(null)}
              disabled={running}
              data-testid="process-button"
              title="Builds one item per Annotation and Text Comment from what you typed or said"
            >
              {running ? 'Processing…' : done ? 'Process again without a model' : 'Process without a model'}
            </Button>
          </div>
        )}
      </div>

      {phase.kind === 'confirm' && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3"
          data-testid="process-estimate"
        >
          <p>
            About <strong>{phase.estimate.input_tokens.toLocaleString('en-US')}</strong> input and ~
            {phase.estimate.output_tokens.toLocaleString('en-US')} output tokens with{' '}
            <code>{phase.estimate.model}</code>
            {(phase.estimate.chunks ?? 1) > 1 && (
              <span data-testid="process-chunks">, in {phase.estimate.chunks} parts run two at a time</span>
            )}
            :{' '}
            {phase.estimate.usd !== null ? (
              <strong>~{formatUsd(phase.estimate.usd)}</strong>
            ) : (
              'price unknown for this model'
            )}
            <span className="text-muted-foreground">
              {' '}
              (prices as of {phase.estimate.prices_as_of}
              {phase.estimate.video ? '; the recording goes with each call' : ''}
              {phase.estimate.vet ? '; includes checking every item against the recording' : ''})
            </span>
          </p>
          {phase.warnings.map((w) => (
            <p key={w.limit} className={cn('w-full', TONE.warnText)} data-testid="process-limit-warning">
              {limitText(w, phase.estimate.model)}
            </p>
          ))}
          {done && (
            <p className="w-full text-muted-foreground">
              Processing again replaces the items below, and your edits to them, with a fresh list. Transcript edits are
              kept.
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => run(phase.estimate)} data-testid="process-confirm">
              Run Process
            </Button>
            <Button variant="ghost" onClick={() => setPhase({ kind: 'idle' })}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {autoRan && (
        <p className="text-muted-foreground" data-testid="process-auto-ran">
          Estimated {formatUsd(autoRan.usd)}, under your ${autoRan.threshold.toFixed(2)} limit:{' '}
          {running ? 'processing…' : 'processed without asking.'}
        </p>
      )}
      {running && (
        <p role="status" data-testid="process-running">
          {hasKey
            ? `Processing with ${latest?.model ?? 'the Process model'}… this can take a minute.`
            : 'Building the items…'}
        </p>
      )}
      {running && latest?.status === 'running' && <ProgressCards runId={latest.id} />}

      {failed && !running && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 p-3 text-destructive"
          data-testid="process-error"
        >
          <p>Process failed: {failed} Your recording, transcript and Annotations are unchanged.</p>
          <Button variant="outline" onClick={hasKey ? estimate : () => run(null)} data-testid="process-retry">
            Retry
          </Button>
        </div>
      )}
      {!done && !running && phase.kind === 'idle' && !failed && (
        <p className="text-muted-foreground">Nothing processed yet.</p>
      )}
      {done && !running && <RunCoverage run={done} />}
      {done && !running && <RunNotes run={done} />}
    </div>
  );
}

/** Long Sessions and Annotations no item uses: said plainly, never silent (PRD P0-11). */
function RunCoverage({ run }: { run: ProcessRunRow }) {
  const dropped = run.dropped_annotations ?? [];
  const unaccounted = run.unaccounted_annotations ?? [];
  if ((run.windows ?? 1) <= 1 && dropped.length === 0 && unaccounted.length === 0) return null;
  return (
    <div className="text-muted-foreground" data-testid="process-coverage">
      {(run.windows ?? 1) > 1 && (
        <p>
          This long Session was processed in {run.windows} parts, cut where the review paused or moved on
          {run.duplicates_merged?.length
            ? `; ${run.duplicates_merged.length} duplicate ${run.duplicates_merged.length === 1 ? 'item' : 'items'} from the overlaps were merged`
            : ''}
          .
        </p>
      )}
      {dropped.length > 0 && (
        <p>No item for {dropped.map((d) => `#${d.annotation} (${d.reason.replace(/\.$/, '')})`).join('; ')}.</p>
      )}
      {unaccounted.length > 0 && (
        <p className={TONE.warnText}>
          No item uses Annotation {unaccounted.map((n) => `#${n}`).join(', ')}, and the model gave no reason.
        </p>
      )}
    </div>
  );
}

/** How the run used the recording, and anything it had to do instead. */
function RunNotes({ run }: { run: ProcessRunRow }) {
  const notes = run.notes ?? [];
  if (!run.video && notes.length === 0) return null;
  return (
    <div className="text-muted-foreground" data-testid="process-notes">
      {run.video && <p data-testid="process-video">Processed with the recording: the model watched the video.</p>}
      {notes.map((n) => (
        <p key={n} className="text-amber-700 dark:text-amber-400" data-testid="process-note">
          {n}
        </p>
      ))}
    </div>
  );
}

/**
 * The running Process, chunk by chunk: the items each chunk has finished so far, read-only, and a placeholder for
 * the item the model is writing. Rows disappear when the run ends and the final list takes over.
 */
function ProgressCards({ runId }: { runId: string }) {
  const rows = useLiveQuery(() => db.processProgress.where('run_id').equals(runId).toArray(), [runId]);
  const chunks = (rows ?? []).filter((r) => r.status !== 'split').sort((a, b) => a.start - b.start);
  if (chunks.length === 0) return null;
  const many = chunks.length > 1;
  return (
    <div className="flex flex-col gap-4" data-testid="process-progress" aria-live="polite">
      {chunks.map((c, k) => (
        <section key={c.chunk} className="flex flex-col gap-2" data-testid="progress-chunk" data-status={c.status}>
          {many && (
            <h3 className="text-sm font-medium text-muted-foreground">
              Part {k + 1} of {chunks.length}
              {c.status === 'queued' ? ' · waiting' : c.status === 'streaming' ? ' · writing' : ' · done'}
            </h3>
          )}
          <ol className="flex flex-col gap-2">
            {c.items.map((item, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a chunk's items are only appended while it streams, so the index is their identity
              <ProgressCard key={i} item={item} />
            ))}
            {(c.status === 'streaming' || c.status === 'queued') && (
              <li
                className="flex flex-col gap-2 rounded-lg border border-dashed p-4"
                data-testid="progress-placeholder"
                aria-label="Item still being written"
              >
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </li>
            )}
          </ol>
        </section>
      ))}
    </div>
  );
}

function ProgressCard({ item }: { item: ProcessProgressRow['items'][number] }) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-4 opacity-90" data-testid="progress-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{item.category}</span>
        <span className="text-xs text-muted-foreground">in progress</span>
      </div>
      <h4 className="font-semibold">{item.title}</h4>
      <p className="text-muted-foreground">{item.intent}</p>
    </li>
  );
}

export function ChangeItemList({
  sessionId,
  run,
  items,
  edits,
  uncombined,
  shots,
  selectedId,
  onSelect,
}: {
  sessionId: string;
  run: ProcessRunRow;
  /** The run's items with its edits applied, in review order. */
  items: ChangeItem[];
  /** The run's item_edit ops, in log order. */
  edits: readonly ItemEditOp[];
  /** Merged items still showing the concatenation (applyItemEdits). */
  uncombined: ReadonlySet<string>;
  /** Screenshots, Annotations and Strokes of the Session, for each Location's screenshot. */
  shots: ShotIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hasKey = !!useRoleHasKey('merge');
  // Items the merge model is rewriting now, and why the last try for an item failed.
  const [combining, setCombining] = useState<ReadonlySet<string>>(new Set());
  const [combineError, setCombineError] = useState<ReadonlyMap<string, string>>(new Map());
  // Per item, how many ops this page has logged on it: a combine answer is dropped if another op came first.
  const changed = useRef(new Map<string, number>());
  // Undos and redos this page has logged: a combine answer that arrives after one is dropped too.
  const stepped = useRef(0);
  const { canUndo, canRedo } = undoState(edits);
  // Drag order shown at once; the logged reorder replaces it when the live query catches up.
  const [order, setOrder] = useState<string[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new items from the live query are the trigger to drop the optimistic order
  useEffect(() => setOrder(null), [items]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const shown = order ? order.flatMap((id) => byId.get(id) ?? []) : items;
  // The latest Resolution of each item of this run (only with a paired Host).
  const resolutions = useLiveQuery(async () => {
    return latestResolutions(await db.resolutions.where('run_id').equals(run.id).toArray());
  }, [run.id]);

  async function log(edit: ItemEditOp) {
    if (edit.op === 'undo' || edit.op === 'redo') stepped.current++;
    for (const id of edit.op === 'merge'
      ? [edit.into, edit.from]
      : edit.op === 'reorder' || edit.op === 'undo' || edit.op === 'redo'
        ? []
        : [edit.item_id])
      changed.current.set(id, (changed.current.get(id) ?? 0) + 1);
    try {
      await appendReviewEvent(sessionId, { type: 'item_edit', run_id: run.id, edit });
      setError(null);
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Split copies get ids past every id this run has used, including earlier split copies since deleted.
  const allIds = () => [...(run.items ?? []).map((i) => i.id), ...items.map((i) => i.id)];
  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  const pickedInOrder = shown.filter((i) => picked.includes(i.id)).map((i) => i.id);

  async function merge() {
    const [into, from] = pickedInOrder.map((id) => byId.get(id)!);
    if (!into || !from) return;
    setPicked([]);
    await log({ op: 'merge', into: into.id, from: from.id });
    onSelect(into.id);
    if (hasKey) await combine(into, from);
  }

  /** Asks the merge model for one title, intent and prompt; logs them unless the card changed meanwhile. */
  async function combine(into: ChangeItem, from: ChangeItem) {
    const id = into.id;
    const before = changed.current.get(id) ?? 0;
    const steps = stepped.current;
    setCombining((s) => new Set(s).add(id));
    setCombineError((m) => new Map([...m].filter(([k]) => k !== id)));
    try {
      const r = await sendMessage('combineItems', { run_id: run.id, into, from }).catch((e: unknown) => ({
        ok: false as const,
        code: 'api',
        error: String(e),
      }));
      if (!r.ok) {
        setCombineError((m) => new Map(m).set(id, r.error));
        return;
      }
      // The reviewer edited, split, deleted or merged this card again, or undid or redid a step, first: their change stands.
      if ((changed.current.get(id) ?? 0) !== before || stepped.current !== steps) return;
      await log({ op: 'edit', item_id: id, origin: 'combine', changes: r.changes });
    } finally {
      setCombining((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function combineAgain(id: string) {
    const sources = mergeSources(run.items ?? [], edits, id);
    if (sources) await combine(sources.into, sources.from);
  }

  const undo = () => log({ op: 'undo' });
  const redo = () => log({ op: 'redo' });
  const shortcut = useRef({ canUndo, canRedo, undo, redo });
  shortcut.current = { canUndo, canRedo, undo, redo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
      // A text field keeps its own undo.
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      e.preventDefault();
      const s = shortcut.current;
      if (e.shiftKey) {
        if (s.canRedo) void s.redo();
      } else if (s.canUndo) void s.undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>Drag to reorder. Tick two items to merge them.</span>
        <Button
          size="sm"
          variant="outline"
          onClick={merge}
          disabled={pickedInOrder.length !== 2}
          data-testid="merge-items"
        >
          Merge selected
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (⌘Z / Ctrl+Z)"
          data-testid="undo-items"
        >
          Undo
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (⇧⌘Z / Shift+Ctrl+Z)"
          data-testid="redo-items"
        >
          Redo
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <DragDropProvider
        onDragEnd={(event) => {
          if (event.canceled) return;
          const { source } = event.operation;
          if (!isSortable(source) || source.initialIndex === source.index) return;
          const next = shown.map((i) => i.id);
          const [moved] = next.splice(source.initialIndex, 1);
          next.splice(source.index, 0, moved!);
          setOrder(next);
          void log({ op: 'reorder', order: next });
        }}
      >
        <ol className="flex flex-col gap-3" data-testid="change-items">
          {shown.map((item, index) => (
            <ChangeItemCard
              key={item.id}
              item={item}
              index={index}
              resolution={resolutions?.get(item.id) ?? null}
              shots={shots}
              selected={item.id === selectedId}
              picked={picked.includes(item.id)}
              combine={
                combining.has(item.id)
                  ? 'running'
                  : uncombined.has(item.id)
                    ? { error: combineError.get(item.id) ?? null, retry: hasKey ? () => combineAgain(item.id) : null }
                    : null
              }
              onSelect={() => onSelect(item.id)}
              onPick={() => togglePick(item.id)}
              onEdit={(changes) => log({ op: 'edit', item_id: item.id, changes })}
              onDelete={() => log({ op: 'delete', item_id: item.id })}
              onSplit={async () => {
                const new_id = nextItemId(allIds());
                await log({ op: 'split', item_id: item.id, new_id });
                onSelect(new_id);
              }}
            />
          ))}
        </ol>
      </DragDropProvider>
    </div>
  );
}

type Changes = Extract<ItemEditOp, { op: 'edit' }>['changes'];

function ChangeItemCard({
  item,
  index,
  resolution,
  shots,
  selected,
  picked,
  combine,
  onSelect,
  onPick,
  onEdit,
  onDelete,
  onSplit,
}: {
  item: ChangeItem;
  index: number;
  resolution: ResolutionRow | null;
  shots: ShotIndex;
  selected: boolean;
  picked: boolean;
  /** A merged item: the merge model is rewriting it, or it kept the concatenation (with a retry when a key exists). */
  combine: 'running' | { error: string | null; retry: (() => Promise<void>) | null } | null;
  onSelect: () => void;
  onPick: () => void;
  onEdit: (changes: Changes) => Promise<void>;
  onDelete: () => Promise<void>;
  onSplit: () => Promise<void>;
}) {
  const { ref, handleRef, isDragging } = useSortable({ id: item.id, index });
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const [editing, setEditing] = useState(false);
  const low = isLowConfidence(item);

  async function copy() {
    try {
      await navigator.clipboard.writeText(item.agent_prompt);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking anywhere on the card is a pointer shortcut for selecting it; the card's buttons are its keyboard controls
    <li
      ref={ref}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-background p-4',
        low && TONE.unsureCard,
        selected && 'ring-2 ring-primary',
        isDragging && 'opacity-60',
      )}
      onClick={onSelect}
      data-testid="change-item"
      data-item-id={item.id}
      data-pinned={item.pinned}
      data-selected={selected}
    >
      <div className="flex items-start gap-2">
        <button
          ref={handleRef}
          type="button"
          className="mt-1 cursor-grab text-muted-foreground"
          aria-label={`Drag to reorder: ${item.title}`}
          data-testid="drag-handle"
        >
          <GripVertical className="size-4" />
        </button>
        <input
          type="checkbox"
          className="mt-1.5"
          checked={picked}
          onChange={onPick}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select for merge: ${item.title}`}
          data-testid="select-item"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {low && (
              <span
                className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', TONE.unsureChip)}
                data-testid="check-me"
              >
                check me
              </span>
            )}
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="item-category">
              {item.category}
            </span>
            {item.pinned && (
              <span
                className="rounded-full bg-muted px-2 py-0.5 text-xs"
                data-testid="item-pinned"
                title="Pinned as a Draft Item during the Session"
              >
                pinned
              </span>
            )}
            {combine === 'running' && (
              <span role="status" className="rounded-full bg-muted px-2 py-0.5 text-xs" data-testid="item-combining">
                Combining…
              </span>
            )}
            {combine && combine !== 'running' && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="item-combined-plain"
                title={combine.error ?? 'The two items were joined as they were.'}
              >
                Combined without AI
              </span>
            )}
            {combine && combine !== 'running' && combine.retry && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  void combine.retry!();
                }}
                data-testid="item-combine-retry"
              >
                Combine with AI
              </Button>
            )}
            {item.vetting && (
              <span
                className={cn(
                  'px-2 py-0.5 text-xs',
                  item.vetting.verdict === 'confirmed' ? 'rounded-full' : 'rounded-md',
                  VETTING_STYLE[item.vetting.verdict],
                )}
                title={item.vetting.reason}
                data-testid="vetting"
                data-verdict={item.vetting.verdict}
              >
                {VETTING_LABEL[item.vetting.verdict]}
                {item.vetting.verdict === 'confirmed' ? '' : `: ${item.vetting.reason}`}
              </span>
            )}
            {item.source === 'page_api' && (
              <span
                className="rounded-full bg-muted px-2 py-0.5 text-xs"
                data-testid="item-source"
                title="Annotated by a script on the page through window.__inkup"
              >
                page API
              </span>
            )}
          </div>
          {editing ? (
            <ItemEditor
              item={item}
              onCancel={() => setEditing(false)}
              onSave={async (changes) => {
                if (Object.keys(changes).length) await onEdit(changes);
                setEditing(false);
              }}
            />
          ) : (
            <>
              <h3 className="text-base font-semibold" data-testid="item-title">
                {item.title}
              </h3>
              <p data-testid="item-intent">{item.intent}</p>
            </>
          )}
        </div>
      </div>
      {resolution && <ResolutionLine resolution={resolution} />}
      {/* A combine surfaces contradictions between the merged requests here too, whatever the confidence. */}
      {item.ambiguity && (
        <p className={TONE.warnStrongText} data-testid="ambiguity">
          {item.ambiguity}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {item.locations.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Locations have no id; a merge only appends to the list
          <li key={i} className="flex flex-col gap-1.5" data-testid="item-location" data-role={l.role}>
            <p>
              <span className="font-medium">{ROLE_LABEL[l.role]}:</span> {l.element}
              {l.selector && (
                <>
                  {' '}
                  <code className="rounded bg-muted px-1">{l.selector}</code>
                </>
              )}{' '}
              <span className="text-muted-foreground">
                on {l.url}
                {l.annotation !== null ? ` · Annotation #${l.annotation}` : ''}
              </span>
            </p>
            <LocationShot location={l} shots={shots} label={`${ROLE_LABEL[l.role]}: ${l.element}`} />
          </li>
        ))}
      </ul>
      {item.transcript && <p className="text-muted-foreground italic">“{item.transcript}”</p>}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only keeps clicks on the controls inside from selecting the card; not an interaction of its own */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only keeps clicks on the controls inside from selecting the card; not an interaction of its own */}
      <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
        <Button variant="outline" size="sm" onClick={copy} data-testid="copy-prompt">
          {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy agent prompt'}
        </Button>
        {!editing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onSelect();
              setEditing(true);
            }}
            data-testid="edit-item"
          >
            Edit
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onSplit} data-testid="split-item">
          Split
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete} data-testid="delete-item">
          Delete
        </Button>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: only keeps clicks on the controls inside from selecting the card; not an interaction of its own */}
      <details onClick={(e) => e.stopPropagation()}>
        <summary className="cursor-pointer text-muted-foreground">Agent prompt</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded bg-muted p-3 text-xs" data-testid="agent-prompt">
          {item.agent_prompt}
        </pre>
      </details>
    </li>
  );
}

/** The latest word from the agent: In work (who, since when), or Done, Won't fix, Needs info with its note. */
function ResolutionLine({ resolution }: { resolution: ResolutionRow }) {
  const now = useNow();
  const who = resolution.agent ?? (resolution.source === 'mcp' ? 'An agent' : 'The Host');
  return (
    <p
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 rounded-md border px-3 py-2',
        RESOLUTION_STYLE[resolution.status],
      )}
      data-testid="item-resolution"
      data-status={resolution.status}
    >
      <span className="font-semibold" data-testid="item-resolution-label">
        {RESOLUTION_LABEL[resolution.status]}
      </span>
      <span className="text-xs opacity-80" data-testid="item-resolution-by">
        {who} · {timeAgo(resolution.created_at, now)}
      </span>
      {resolution.note && (
        <span className="basis-full" data-testid="item-resolution-note">
          {resolution.note}
        </span>
      )}
    </p>
  );
}

/** A Location's screenshot with its Annotation's Strokes, under the Location; click to see it full size. */
function LocationShot({ location, shots, label }: { location: Location; shots: ShotIndex; label: string }) {
  const found = locationShot(shots, location);
  if (!found || !shots.shots.has(found.id)) return null;
  const shot = shots.shots.get(found.id);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="w-full max-w-sm cursor-zoom-in rounded text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Enlarge the screenshot of ${label}`}
          data-testid="location-shot-open"
        >
          <EvidenceShot id={found.id} shot={shot} strokes={found.strokes} />
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[95vh] overflow-auto sm:max-w-[min(95vw,1400px)]"
        onClick={(e) => e.stopPropagation()}
        data-testid="location-shot-dialog"
      >
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>
          {location.url}
          {location.annotation !== null ? ` · Annotation #${location.annotation}` : ''}
        </DialogDescription>
        <EvidenceShot id={found.id} shot={shot} strokes={found.strokes} testId="evidence-shot-large" />
      </DialogContent>
    </Dialog>
  );
}

function ItemEditor({
  item,
  onSave,
  onCancel,
}: {
  item: ChangeItem;
  onSave: (changes: Changes) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [intent, setIntent] = useState(item.intent);
  const [category, setCategory] = useState(item.category);
  const changes: Changes = {
    ...(title.trim() && title.trim() !== item.title ? { title: title.trim() } : {}),
    ...(intent.trim() && intent.trim() !== item.intent ? { intent: intent.trim() } : {}),
    ...(category !== item.category ? { category } : {}),
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: only keeps clicks on the controls inside from selecting the card; not an interaction of its own
    <form
      className="flex flex-col gap-2"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(changes);
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="edit-title" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Intent</span>
        <Textarea value={intent} onChange={(e) => setIntent(e.target.value)} data-testid="edit-intent" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Category</span>
        <select
          className="h-9 rounded-md border bg-transparent px-2"
          value={category}
          onChange={(e) => setCategory(e.target.value as ChangeItem['category'])}
          data-testid="edit-category"
        >
          {Category.options.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        The agent prompt is not rewritten; check it still matches after an edit.
      </p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!title.trim() || !intent.trim()} data-testid="save-item">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
