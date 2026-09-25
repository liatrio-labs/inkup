// A screenshot with the reviewer's Strokes drawn over it, in the screenshot's viewport coordinates. Used inside
// Change Item cards (one per Location) and in the review page's timeline, where an Annotation with an element crop
// (E4) shows the crop, its Strokes clipped to it. Which Strokes are drawn is
// packages/core/src/evidence-strokes.ts: several Annotations can share one screenshot, and a Location shows only the Strokes
// of the Annotation it cites (all of the screenshot's when it cites none).

import { haloFor } from '@inkup/core/contrast';
import { strokeIdsForShot } from '@inkup/core/evidence-strokes';
import type { Location } from '@inkup/core/process/change-item';
import { HALO_EXTRA, strokeOutlinePath } from '@inkup/core/stroke-path';
import type { EventOf, TimelineEvent } from '@inkup/core/timeline';
import { useEffect, useMemo, useState } from 'react';
import { TONE } from '@/components/tone';
import { useBlobUrl } from '@/lib/use-blob-url';
import { cn } from '@/lib/utils';

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

/** An image's natural width, once it has loaded. */
function useImageWidth(url: string | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    setWidth(null);
    if (!url) return;
    const img = new Image();
    img.onload = () => setWidth(img.naturalWidth);
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return width;
}

export function EvidenceShot({
  id,
  shot,
  strokes,
  crop,
  className,
  alt = 'Screenshot of the page when the Annotation closed',
  testId = 'evidence-shot',
}: {
  id: string;
  shot: EventOf<'screenshot'> | undefined;
  strokes: readonly EventOf<'stroke'>[];
  /** Show this crop of the screenshot instead of all of it. */
  crop?: NonNullable<EventOf<'annotation'>['crop']>;
  className?: string;
  alt?: string;
  testId?: string;
}) {
  const url = useBlobUrl(id);
  const cropUrl = useBlobUrl(crop?.blob_id);
  // The crop's rect is in the screenshot's pixels; the Strokes are in its viewport's CSS px.
  const fullWidth = useImageWidth(crop ? url : null);
  const src = crop ? cropUrl : url;
  if (!url || !src || !shot) return null;
  const { width, height } = shot.viewport;
  const scale = crop ? (fullWidth ?? width * shot.dpr) / width : 1;
  const viewBox = crop
    ? [crop.rect.x, crop.rect.y, crop.rect.width, crop.rect.height].map((n) => n / scale).join(' ')
    : `0 0 ${width} ${height}`;
  return (
    <figure
      className={cn('relative w-full overflow-hidden rounded border', TONE.shotFrame, className)}
      data-testid={testId}
      data-screenshot-id={id}
      data-crop={crop ? crop.blob_id : undefined}
    >
      <img src={src} alt={alt} className="block w-full" />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={viewBox}
        preserveAspectRatio="none"
        aria-hidden="true"
        data-testid="stroke-overlay"
      >
        {strokes.map((s) =>
          // A Stroke with its ink colour (E8) has its halo under it; one from before v14 keeps the old orange.
          s.color ? (
            <g key={s.stroke_id} data-stroke-id={s.stroke_id} data-color={s.color}>
              <path d={strokeOutlinePath(s.points, shot.scroll, HALO_EXTRA)} fill={haloFor(s.color, null)} />
              <path d={strokeOutlinePath(s.points, shot.scroll)} fill={s.color} />
            </g>
          ) : (
            <path
              key={s.stroke_id}
              d={strokeOutlinePath(s.points, shot.scroll)}
              fill="rgb(234 88 12 / 0.75)"
              data-stroke-id={s.stroke_id}
            />
          ),
        )}
      </svg>
    </figure>
  );
}
