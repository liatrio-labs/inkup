// A screenshot with the reviewer's Strokes drawn over it, in the screenshot's viewport coordinates (spec 02 R2.2).
// Change Item cards show one per Location (location-shot.tsx), and the review page's timeline shows one per Annotation
// and Text Comment, where an Annotation with an element crop (E4) shows the crop with its Strokes clipped to it. Which
// Strokes are drawn is packages/core/src/evidence-strokes.ts (location-shot.tsx's `strokesOf`).
//
// The images come as props, a URL or a Blob: the extension resolves its Dexie blobs to object URLs (useBlobUrl) and the
// desktop app hands its own. A crop's rect is in the screenshot's pixels and the Strokes in its viewport's CSS px, so
// the overlay scales the rect down by the screenshot's real width over the viewport's (its device pixel ratio,
// ADR 0013), read from the full image once it loads and taken from `dpr` until then.
import { haloFor } from '@inkup/core/contrast';
import { HALO_EXTRA, strokeOutlinePath } from '@inkup/core/stroke-path';
import type { EventOf } from '@inkup/core/timeline';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/utils';
import { TONE } from './tone';

/** An image: a URL, or a Blob the component turns into an object URL. Null or undefined while it loads. */
export type ImageSource = string | Blob | null | undefined;

/** What the overlay needs of a `screenshot` event: its viewport (CSS px), device pixel ratio and scroll. */
export type ShotGeometry = Pick<EventOf<'screenshot'>, 'viewport' | 'dpr' | 'scroll'>;

/** A crop's rect, in the full screenshot's pixels. */
export type CropRect = NonNullable<EventOf<'annotation'>['crop']>['rect'];

export interface EvidenceShotProps {
  /** The screenshot's id, set as `data-screenshot-id`. */
  id: string;
  /** The whole screenshot. Nothing renders until it is there. */
  src: ImageSource;
  /** The screenshot's event; nothing renders without it. */
  shot: ShotGeometry | undefined;
  strokes: readonly EventOf<'stroke'>[];
  /** Show this crop of the screenshot instead of all of it: its image (`id` is set as `data-crop`) and its rect. */
  crop?: { id: string; src: ImageSource; rect: CropRect };
  className?: string;
  alt?: string;
  testId?: string;
}

/** An object URL for a Blob, revoked when it changes or unmounts; a string URL as it is. */
export function useImageUrl(src: ImageSource): string | null {
  const url = useMemo(() => (src instanceof Blob ? URL.createObjectURL(src) : (src ?? null)), [src]);
  useEffect(() => () => void (src instanceof Blob && url && URL.revokeObjectURL(url)), [src, url]);
  return url;
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

/** The overlay's viewBox: the whole viewport, or the crop's rect scaled from image pixels to CSS px. */
export function shotViewBox(shot: ShotGeometry, crop?: { rect: CropRect } | null, fullWidth?: number | null): string {
  const { width, height } = shot.viewport;
  if (!crop) return `0 0 ${width} ${height}`;
  const scale = (fullWidth ?? width * shot.dpr) / width;
  return [crop.rect.x, crop.rect.y, crop.rect.width, crop.rect.height].map((n) => n / scale).join(' ');
}

export function EvidenceShot({
  id,
  src,
  shot,
  strokes,
  crop,
  className,
  alt = 'Screenshot of the page when the Annotation closed',
  testId = 'evidence-shot',
}: EvidenceShotProps) {
  const url = useImageUrl(src);
  const cropUrl = useImageUrl(crop?.src);
  const fullWidth = useImageWidth(crop ? url : null);
  const shown = crop ? cropUrl : url;
  if (!url || !shown || !shot) return null;
  return (
    <figure
      className={cn('relative w-full overflow-hidden rounded-md border bg-muted', TONE.shotFrame, className)}
      data-testid={testId}
      data-screenshot-id={id}
      data-crop={crop ? crop.id : undefined}
    >
      <img src={shown} alt={alt} className="block w-full" />
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox={shotViewBox(shot, crop, fullWidth)}
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
