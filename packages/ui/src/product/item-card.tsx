// One item in a list, drawn from props alone (R1.2, R2.2): the side panel's live Draft Item (PRD P0-10) and a processed
// Change Item. The caller owns the data (the extension reads Dexie; the desktop app its own store) and is told of the
// reviewer's actions through callbacks.
//
// - `variant="draft"`: title, Category, Location names and the pinned or discarded state, with Discard and Pin. A
//   button is busy while its callback's promise runs. Pinned draws the ink border, discarded fades and strikes through.
// - `variant="change"`: the Change Item's face as processed: Category, the pinned marker, its vetting verdict and its
//   latest Resolution in the Resolution tones. Slots take what the caller adds: `badges` after the built-in ones,
//   `evidence` under the item's own evidence and `actions` at the foot.
// - The same face at review time (the review page, PRD P0-12; ADR 0019): each part shows when the caller passes what
//   it needs. A drag handle (`handleRef`; the caller owns the sortable list), the select-for-merge checkbox
//   (`onPick`), "check me" (`lowConfidence`), the merge's Combine state (`combine`), the ambiguity, every Location with
//   its screenshot (`renderShot`), the transcript, Copy agent prompt with the caller's `actions` beside it, Edit
//   (title, intent and Category, in place), Split and Delete, and the agent prompt itself. Clicking the card selects it
//   (`onSelect`); clicks on its controls do not.
//
// DESIGN.md "Change Item": paper, hairline border, medium radius, the Card shadow; status pills in their own colour;
// the selector in pen-ink mono.
import type { DraftState } from '@inkup/core/drafts';
import type { ChangeItem, GroundedLocation } from '@inkup/core/process/change-item';
import { Category, type EventOf, type ItemEditOp } from '@inkup/core/timeline';
import { GripVertical } from 'lucide-react';
import { type ReactNode, type Ref, useId, useState } from 'react';
import { Badge } from '../components/badge';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { Checkbox } from '../components/checkbox';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { Textarea } from '../components/textarea';
import { cn } from '../lib/utils';
import { RESOLUTION_LABEL, RESOLUTION_STYLE, type ResolutionStatus } from './resolution-style';
import { TONE } from './tone';
import { VETTING_LABEL, VETTING_STYLE } from './vetting-style';

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

/** What the Draft face shows of a `draft_item` event. */
export type DraftCardItem = Pick<EventOf<'draft_item'>, 'draft_id' | 'title' | 'category' | 'locations'>;

/**
 * What the Change face shows of a Change Item. The review page passes the whole item: its source, ambiguity,
 * Locations, transcript and agent prompt each show when present.
 */
export type ChangeCardItem = Pick<ChangeItem, 'id' | 'title' | 'category' | 'intent'> &
  Partial<Pick<ChangeItem, 'pinned' | 'vetting' | 'source' | 'ambiguity' | 'transcript' | 'agent_prompt'>> & {
    locations?: readonly GroundedLocation[];
  };

/** What an in-place edit changed: title, intent or Category (an `item_edit` op's `changes`). */
export type ItemCardChanges = Extract<ItemEditOp, { op: 'edit' }>['changes'];

/** A merged item: the merge model is rewriting it, or it kept the two items' words joined (with a retry when it can). */
export type ItemCardCombine = 'running' | { error: string | null; onRetry: (() => unknown) | null } | null;

/** A Change Item's latest Resolution, as the caller words who set it and when. */
export interface ItemCardResolution {
  status: ResolutionStatus;
  /** "An agent · 2 min ago": the caller formats it. */
  by?: ReactNode;
  note?: string | null;
}

export interface DraftItemCardProps {
  variant: 'draft';
  draft: DraftCardItem;
  state: DraftState;
  /** How the state was reached; "by voice" is said on the card. */
  source?: 'click' | 'voice' | null;
  /** The Session is stopping: both buttons wait. */
  disabled?: boolean;
  onPin: (draftId: string) => unknown;
  onDiscard: (draftId: string) => unknown;
  className?: string;
}

export interface ChangeItemCardProps {
  variant: 'change';
  item: ChangeCardItem;
  resolution?: ItemCardResolution | null;
  /** More pills after Category, pinned, vetting and the page API pill. */
  badges?: ReactNode;
  /** More evidence: after the item's own (ambiguity, Locations, transcript), before the actions. */
  evidence?: ReactNode;
  /** The card's buttons; at review time, right after Copy agent prompt. */
  actions?: ReactNode;
  className?: string;

  // Review time: each shows when given.
  /** The list item, for the caller's sortable list. */
  ref?: Ref<HTMLLIElement>;
  /** Shows the drag handle, "Drag to reorder: <title>", for the caller's sortable list. */
  handleRef?: Ref<HTMLButtonElement>;
  /** The card is being dragged. */
  dragging?: boolean;
  /** The selected card has the focus ring; clicking a card selects it. */
  selected?: boolean;
  onSelect?: () => void;
  /** Ticked for merge. The checkbox shows with `onPick`. */
  picked?: boolean;
  onPick?: () => void;
  /** Low confidence: the pen border and the "check me" pill first. */
  lowConfidence?: boolean;
  combine?: ItemCardCombine;
  /** A Location's screenshot under its row, given its name ("Subject: button 'Get started'"). */
  renderShot?: (location: GroundedLocation, label: string) => ReactNode;
  /** Edit in place: shows Edit, and saves what changed. */
  onEdit?: (changes: ItemCardChanges) => Promise<unknown>;
  onSplit?: () => unknown;
  onDelete?: () => unknown;
}

export type ItemCardProps = DraftItemCardProps | ChangeItemCardProps;

export function ItemCard(props: ItemCardProps) {
  return props.variant === 'draft' ? <DraftFace {...props} /> : <ChangeFace {...props} />;
}

function DraftFace({ draft, state, source = null, disabled = false, onPin, onDiscard, className }: DraftItemCardProps) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: (id: string) => unknown) => {
    setBusy(true);
    try {
      await fn(draft.draft_id);
    } finally {
      setBusy(false);
    }
  };
  const byVoice = source === 'voice' ? ' by voice' : '';
  return (
    <li data-testid="draft-card" data-draft-id={draft.draft_id} data-state={state} className={className}>
      <Card
        className={cn(
          'gap-2 rounded-lg px-3 py-2.5 shadow-xs transition-[border-color,opacity] duration-150',
          state === 'pinned' && 'border-primary',
          state === 'discarded' && 'opacity-50 shadow-none',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p
            className={cn('font-semibold leading-snug', state === 'discarded' && 'line-through')}
            data-testid="draft-title"
          >
            {draft.title}
          </p>
          <Badge variant="secondary" className="font-normal" data-testid="draft-category">
            {draft.category}
          </Badge>
        </div>
        {draft.locations.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {draft.locations.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Locations have no id, and a Draft Item's list is replaced as a whole
              <li key={i} data-testid="draft-location" data-role={l.role}>
                {ROLE[l.role]}: {l.element}
                {l.annotation !== null && ` (#${l.annotation})`}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" data-testid="draft-state">
            {state === 'pinned' ? `Pinned${byVoice}` : state === 'discarded' ? `Discarded${byVoice}` : ''}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy || state === 'discarded'}
              onClick={() => act(onDiscard)}
              data-testid="draft-discard"
            >
              Discard
            </Button>
            <Button
              size="sm"
              variant={state === 'pinned' ? 'default' : 'outline'}
              disabled={disabled || busy || state === 'pinned'}
              onClick={() => act(onPin)}
              data-testid="draft-pin"
              aria-pressed={state === 'pinned'}
            >
              {state === 'pinned' ? 'Pinned' : 'Pin'}
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

function ChangeFace({
  item,
  resolution,
  badges,
  evidence,
  actions,
  className,
  ref,
  handleRef,
  dragging = false,
  selected,
  onSelect,
  picked = false,
  onPick,
  lowConfidence = false,
  combine = null,
  renderShot,
  onEdit,
  onSplit,
  onDelete,
}: ChangeItemCardProps) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const prompt = item.agent_prompt;

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt ?? '');
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  const hasActions = prompt !== undefined || !!actions || !!onEdit || !!onSplit || !!onDelete;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking anywhere on the card is a pointer shortcut for selecting it; the card's buttons are its keyboard controls
    <li
      ref={ref}
      onClick={onSelect}
      data-testid="change-item"
      data-item-id={item.id}
      data-pinned={item.pinned ?? false}
      data-status={resolution?.status ?? 'open'}
      data-selected={selected}
      className={cn(dragging && 'opacity-60', className)}
    >
      <Card
        className={cn(
          'gap-3 rounded-lg p-4 transition-[border-color,box-shadow] duration-150',
          lowConfidence && TONE.unsureCard,
          selected && 'ring-2 ring-primary',
        )}
      >
        <div className="flex items-start gap-2">
          {handleRef && (
            <button
              ref={handleRef}
              type="button"
              className="mt-0.5 -ml-1 cursor-grab rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
              aria-label={`Drag to reorder: ${item.title}`}
              data-testid="drag-handle"
            >
              <GripVertical className="size-4" />
            </button>
          )}
          {onPick && (
            <Checkbox
              className="mt-1"
              checked={picked}
              onCheckedChange={() => onPick()}
              onClick={stop}
              aria-label={`Select for merge: ${item.title}`}
              data-testid="select-item"
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {lowConfidence && (
                <Badge
                  variant="outline"
                  // No colour transition: a scheme flip repaints the pill at once, never through a low-contrast blend.
                  className={cn('font-semibold transition-none', TONE.unsureChip)}
                  data-testid="check-me"
                >
                  check me
                </Badge>
              )}
              <Badge variant="secondary" className="font-normal" data-testid="item-category">
                {item.category}
              </Badge>
              {item.pinned && (
                <Badge
                  variant="outline"
                  className="font-normal"
                  data-testid="item-pinned"
                  title="Pinned as a Draft Item during the Session"
                >
                  pinned
                </Badge>
              )}
              {combine === 'running' && (
                <Badge variant="secondary" role="status" className="font-normal" data-testid="item-combining">
                  Combining…
                </Badge>
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
              {combine && combine !== 'running' && combine.onRetry && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void combine.onRetry!();
                  }}
                  data-testid="item-combine-retry"
                >
                  Combine with AI
                </Button>
              )}
              {item.vetting && (
                <Badge
                  variant="outline"
                  // No colour transition: a scheme flip repaints the verdict at once, never through a low-contrast blend.
                  className={cn(
                    'font-normal whitespace-normal transition-none',
                    item.vetting.verdict !== 'confirmed' && 'rounded-md',
                    VETTING_STYLE[item.vetting.verdict],
                  )}
                  title={item.vetting.reason}
                  data-testid="vetting"
                  data-verdict={item.vetting.verdict}
                >
                  {VETTING_LABEL[item.vetting.verdict]}
                  {item.vetting.verdict === 'confirmed' ? '' : `: ${item.vetting.reason}`}
                </Badge>
              )}
              {item.source === 'page_api' && (
                <Badge
                  variant="secondary"
                  className="font-normal"
                  data-testid="item-source"
                  title="Annotated by a script on the page through window.__inkup"
                >
                  page API
                </Badge>
              )}
              {badges}
            </div>
            {editing && onEdit ? (
              <ItemEditor
                item={item}
                onCancel={() => setEditing(false)}
                onSave={async (changes) => {
                  if (Object.keys(changes).length) await onEdit(changes);
                  setEditing(false);
                }}
              />
            ) : (
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold leading-snug" data-testid="item-title">
                  {item.title}
                </h3>
                <p data-testid="item-intent">{item.intent}</p>
              </div>
            )}
          </div>
        </div>
        {resolution && (
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
            {resolution.by && (
              <span className="text-xs text-muted-foreground" data-testid="item-resolution-by">
                {resolution.by}
              </span>
            )}
            {resolution.note && (
              <span className="basis-full" data-testid="item-resolution-note">
                {resolution.note}
              </span>
            )}
          </p>
        )}
        {/* A combine surfaces contradictions between the merged requests here too, whatever the confidence. */}
        {item.ambiguity && (
          <p className={TONE.warnStrongText} data-testid="ambiguity">
            {item.ambiguity}
          </p>
        )}
        {item.locations && item.locations.length > 0 && (
          <ul className="flex flex-col gap-3">
            {item.locations.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Locations have no id; a merge only appends to the list
              <li key={i} className="flex flex-col gap-1.5" data-testid="item-location" data-role={l.role}>
                <p>
                  <span className="font-medium">{ROLE[l.role]}:</span> {l.element}
                  {l.selector && (
                    <>
                      {' '}
                      <code className="font-mono text-[0.9em] break-all text-pen-ink">{l.selector}</code>
                    </>
                  )}{' '}
                  <span className="text-muted-foreground">
                    on {l.url}
                    {l.annotation !== null ? ` · Annotation #${l.annotation}` : ''}
                  </span>
                </p>
                {renderShot?.(l, `${ROLE[l.role]}: ${l.element}`)}
              </li>
            ))}
          </ul>
        )}
        {item.transcript && (
          <p className="border-l border-pen pl-3 text-muted-foreground italic">“{item.transcript}”</p>
        )}
        {evidence}
        {hasActions && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: only keeps clicks on the controls inside from selecting the card; not an interaction of its own
          // biome-ignore lint/a11y/noStaticElementInteractions: only keeps clicks on the controls inside from selecting the card; not an interaction of its own
          <div className="flex flex-wrap items-center gap-2" onClick={stop}>
            {prompt !== undefined && (
              <Button variant="outline" size="sm" onClick={copy} data-testid="copy-prompt">
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy agent prompt'}
              </Button>
            )}
            {actions}
            {onEdit && !editing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onSelect?.();
                  setEditing(true);
                }}
                data-testid="edit-item"
              >
                Edit
              </Button>
            )}
            {onSplit && (
              <Button variant="ghost" size="sm" onClick={() => void onSplit()} data-testid="split-item">
                Split
              </Button>
            )}
            {onDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => void onDelete()}
                data-testid="delete-item"
              >
                Delete
              </Button>
            )}
          </div>
        )}
        {prompt !== undefined && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: only keeps clicks on the controls inside from selecting the card; not an interaction of its own
          <details onClick={stop}>
            <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground transition-colors hover:text-foreground">
              Agent prompt
            </summary>
            <pre
              className="mt-2 rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
              data-testid="agent-prompt"
            >
              {prompt}
            </pre>
          </details>
        )}
      </Card>
    </li>
  );
}

/** Title, intent and Category, edited in place. The agent prompt is not rewritten, and the form says so. */
function ItemEditor({
  item,
  onSave,
  onCancel,
}: {
  item: ChangeCardItem;
  onSave: (changes: ItemCardChanges) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [intent, setIntent] = useState(item.intent);
  const [category, setCategory] = useState(item.category);
  const categoryId = useId();
  const changes: ItemCardChanges = {
    ...(title.trim() && title.trim() !== item.title ? { title: title.trim() } : {}),
    ...(intent.trim() && intent.trim() !== item.intent ? { intent: intent.trim() } : {}),
    ...(category !== item.category ? { category } : {}),
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: only keeps clicks on the controls inside from selecting the card; not an interaction of its own
    <form
      className="flex flex-col gap-3"
      onClick={stop}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(changes);
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="edit-title" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Intent</span>
        <Textarea value={intent} onChange={(e) => setIntent(e.target.value)} data-testid="edit-intent" />
      </label>
      <label className="flex flex-col gap-1.5" htmlFor={categoryId}>
        <span className="text-xs font-medium text-muted-foreground">Category</span>
        <NativeSelect
          id={categoryId}
          value={category}
          onChange={(e) => setCategory(e.target.value as ChangeItem['category'])}
          data-testid="edit-category"
        >
          {Category.options.map((c) => (
            <NativeSelectOption key={c} value={c}>
              {c}
            </NativeSelectOption>
          ))}
        </NativeSelect>
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
