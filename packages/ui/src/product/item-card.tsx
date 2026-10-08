// One item in a list, drawn from props alone (R1.2): the side panel's live Draft Item (PRD P0-10) and a processed
// Change Item. The caller owns the data (the extension reads Dexie; the desktop app its own store) and is told of the
// reviewer's Pin and Discard through callbacks.
//
// - `variant="draft"`: title, Category, Location names and the pinned or discarded state, with Discard and Pin. A
//   button is busy while its callback's promise runs. Pinned draws the ink border, discarded fades and strikes through.
// - `variant="change"`: the Change Item's face as processed: Category, the pinned marker, its vetting verdict and its
//   latest Resolution in the Resolution tones. Slots take what the caller adds: `badges` after the built-in ones,
//   `evidence` under the intent and `actions` at the foot. The review page's own face extends this one (spec 02 Unit 2).
//
// DESIGN.md "Change Item": paper, hairline border, medium radius, the Card shadow; status pills in their own colour.
import type { DraftState } from '@inkup/core/drafts';
import type { ChangeItem } from '@inkup/core/process/change-item';
import type { EventOf } from '@inkup/core/timeline';
import { type ReactNode, useState } from 'react';
import { Badge } from '../components/badge';
import { Button } from '../components/button';
import { Card } from '../components/card';
import { cn } from '../lib/utils';
import { RESOLUTION_LABEL, RESOLUTION_STYLE, type ResolutionStatus } from './resolution-style';
import { VETTING_LABEL, VETTING_STYLE } from './vetting-style';

const ROLE = { subject: 'Subject', reference: 'Reference', destination: 'Destination' } as const;

/** What the Draft face shows of a `draft_item` event. */
export type DraftCardItem = Pick<EventOf<'draft_item'>, 'draft_id' | 'title' | 'category' | 'locations'>;

/** What the Change face shows of a Change Item. */
export type ChangeCardItem = Pick<ChangeItem, 'id' | 'title' | 'category' | 'intent'> &
  Partial<Pick<ChangeItem, 'pinned' | 'vetting'>>;

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
  /** More pills after Category, pinned and vetting. */
  badges?: ReactNode;
  /** Locations, shots, the transcript: between the intent and the actions. */
  evidence?: ReactNode;
  /** The card's buttons. */
  actions?: ReactNode;
  className?: string;
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

function ChangeFace({ item, resolution, badges, evidence, actions, className }: ChangeItemCardProps) {
  return (
    <li
      data-testid="change-item"
      data-item-id={item.id}
      data-pinned={item.pinned ?? false}
      data-status={resolution?.status ?? 'open'}
      className={className}
    >
      <Card className="gap-3 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-2">
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
          {item.vetting && (
            <Badge
              variant="outline"
              // No colour transition: a scheme flip repaints the verdict at once, never through a low-contrast blend.
              className={cn('font-normal whitespace-normal transition-none', VETTING_STYLE[item.vetting.verdict])}
              title={item.vetting.reason}
              data-testid="vetting"
              data-verdict={item.vetting.verdict}
            >
              {VETTING_LABEL[item.vetting.verdict]}
              {item.vetting.verdict === 'confirmed' ? '' : `: ${item.vetting.reason}`}
            </Badge>
          )}
          {badges}
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold leading-snug" data-testid="item-title">
            {item.title}
          </h3>
          <p data-testid="item-intent">{item.intent}</p>
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
        {evidence}
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </Card>
    </li>
  );
}
