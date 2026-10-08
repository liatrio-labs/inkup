// The review page's screenshots from Dexie: thin containers over `@inkup/ui`'s EvidenceShot and LocationShot
// (packages/ui/src/product), which draw a screenshot and the reviewer's Strokes from an image URL, a rect and the
// Strokes alone. Here each screenshot and crop blob id becomes an object URL (useBlobUrl). Which screenshot a Location
// shows and which Strokes are drawn on it (`locationShot`, `strokesOf`) live with the package component.

import type { Location } from '@inkup/core/process/change-item';
import type { EventOf } from '@inkup/core/timeline';
import {
  type EvidenceShotProps,
  EvidenceShot as EvidenceShotView,
  LocationShot as LocationShotView,
  locationShot,
  type ShotIndex,
} from '@inkup/ui';
import { useBlobUrl } from '@/lib/use-blob-url';

export { locationShot, type ShotIndex, strokesOf, useShotIndex } from '@inkup/ui';

/** A stored screenshot, or its stored crop, with the Strokes drawn over it. */
export function EvidenceShot({
  id,
  crop,
  ...props
}: Omit<EvidenceShotProps, 'src' | 'crop'> & {
  /** Show this crop of the screenshot instead of all of it. */
  crop?: NonNullable<EventOf<'annotation'>['crop']>;
}) {
  const url = useBlobUrl(id);
  const cropUrl = useBlobUrl(crop?.blob_id);
  return (
    <EvidenceShotView
      id={id}
      src={url}
      crop={crop ? { id: crop.blob_id, src: cropUrl, rect: crop.rect } : undefined}
      {...props}
    />
  );
}

/** A Location's screenshot with its Annotation's Strokes, under the Location; click to see it full size. */
export function LocationShot({ location, shots, label }: { location: Location; shots: ShotIndex; label: string }) {
  const found = locationShot(shots, location);
  const shot = found ? shots.shots.get(found.id) : undefined;
  const url = useBlobUrl(shot ? found?.id : null);
  if (!found || !shot) return null;
  return (
    <LocationShotView id={found.id} src={url} shot={shot} strokes={found.strokes} location={location} label={label} />
  );
}
