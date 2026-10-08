// A Change Item Location's screenshot (feedback batch 1, U3; ADR 0019 "Evidence inside the card"): which screenshot a
// Location shows (its own, else its Annotation's), which Strokes are drawn on it (only the cited Annotation's, even when
// Annotations share a screenshot; packages/core/src/evidence-strokes.ts), and the thumbnail under the Location's row
// that opens full size in a dialog. The image comes as a prop (evidence-shot.tsx); the caller resolves it.
import { strokeIdsForShot } from '@inkup/core/evidence-strokes';
import type { Location } from '@inkup/core/process/change-item';
import type { EventOf, TimelineEvent } from '@inkup/core/timeline';
import { useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/dialog';
import { EvidenceShot, type EvidenceShotProps } from './evidence-shot';

/** The Session's screenshots, Annotations and Strokes, looked up by id and by Annotation number. */
export interface ShotIndex {
  shots: ReadonlyMap<string, EventOf<'screenshot'>>;
  /** Annotations by number (#n). */
  annotations: ReadonlyMap<number, EventOf<'annotation'>>;
  strokes: ReadonlyMap<string, EventOf<'stroke'>>;
}

export function useShotIndex(events: readonly TimelineEvent[]): ShotIndex {
  return useMemo(
    () => ({
      shots: new Map(
        events.filter((e): e is EventOf<'screenshot'> => e.type === 'screenshot').map((e) => [e.screenshot_id, e]),
      ),
      annotations: new Map(
        events.filter((e): e is EventOf<'annotation'> => e.type === 'annotation').map((a) => [a.index, a]),
      ),
      strokes: new Map(events.filter((e): e is EventOf<'stroke'> => e.type === 'stroke').map((s) => [s.stroke_id, s])),
    }),
    [events],
  );
}

/** The Strokes to draw on this screenshot for the cited Annotations (every Annotation on it when none is cited). */
export function strokesOf(
  index: ShotIndex,
  screenshotId: string,
  annotationNumbers: readonly number[],
): EventOf<'stroke'>[] {
  return strokeIdsForShot(screenshotId, annotationNumbers, [...index.annotations.values()]).flatMap(
    (id) => index.strokes.get(id) ?? [],
  );
}

/** A Location's screenshot: its own, else the cited Annotation's. Null when neither exists. */
export function locationShot(
  index: ShotIndex,
  location: Pick<Location, 'screenshot' | 'annotation'>,
): { id: string; strokes: EventOf<'stroke'>[] } | null {
  const cited = location.annotation !== null ? index.annotations.get(location.annotation) : undefined;
  const id = location.screenshot ?? cited?.screenshot_id ?? null;
  if (!id) return null;
  return { id, strokes: strokesOf(index, id, location.annotation !== null ? [location.annotation] : []) };
}

export interface LocationShotProps extends Pick<EvidenceShotProps, 'id' | 'src' | 'shot' | 'strokes'> {
  /** Where the shot was taken: its page, and the Annotation it comes from. */
  location: Pick<Location, 'url' | 'annotation'>;
  /** The Location's name, "Subject: button 'Get started'": the dialog's title and the thumbnail's "Enlarge" label. */
  label: string;
}

/** The Location's screenshot under its row; click it to see it full size. */
export function LocationShot({ id, src, shot, strokes, location, label }: LocationShotProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="w-full max-w-sm cursor-zoom-in rounded-md text-left transition-opacity duration-150 hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Enlarge the screenshot of ${label}`}
          data-testid="location-shot-open"
        >
          <EvidenceShot id={id} src={src} shot={shot} strokes={strokes} />
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
        <EvidenceShot id={id} src={src} shot={shot} strokes={strokes} testId="evidence-shot-large" />
      </DialogContent>
    </Dialog>
  );
}
