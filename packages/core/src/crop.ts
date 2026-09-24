// Element crops (E4): the Annotation's screenshot cut down to its picked element plus a margin, so an agent sees
// the element itself at full resolution. Pure geometry; the service worker does the pixels.
import type { Rect } from './geometry.ts';

export const CROP_PADDING_CSS_PX = 16;

export interface ShotGeometry {
  /** Page scroll when the screenshot was taken, CSS px. */
  scroll: { x: number; y: number };
  /** Viewport size, CSS px. */
  viewport: { width: number; height: number };
  /** The screenshot's size in pixels. */
  image: { width: number; height: number };
}

/**
 * The crop, in the screenshot's pixels, for an element whose box is `bbox` (page CSS px): the box plus `padding`
 * on every side, clipped to what the image shows, scaled by the image's pixels per CSS px (the device pixel ratio,
 * measured from the image width so a zoomed capture still lines up). The scale comes from the width alone: an image
 * shorter than the viewport (a window smaller than an emulated viewport) shows its top part unscaled, not squeezed.
 * Null when nothing of the element is in the image.
 */
export function cropRect(bbox: Rect, shot: ShotGeometry, padding = CROP_PADDING_CSS_PX): Rect | null {
  const { viewport, image, scroll } = shot;
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) return null;
  const scale = image.width / viewport.width;
  const shownHeight = Math.min(viewport.height, image.height / scale);
  const left = Math.max(0, bbox.x - scroll.x - padding);
  const top = Math.max(0, bbox.y - scroll.y - padding);
  const right = Math.min(viewport.width, bbox.x - scroll.x + bbox.width + padding);
  const bottom = Math.min(shownHeight, bbox.y - scroll.y + bbox.height + padding);
  if (right <= left || bottom <= top) return null;
  const x = Math.max(0, Math.floor(left * scale));
  const y = Math.max(0, Math.floor(top * scale));
  const width = Math.min(image.width, Math.ceil(right * scale)) - x;
  const height = Math.min(image.height, Math.ceil(bottom * scale)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Blob id and export path of a screenshot's crop. */
export const cropBlobId = (screenshotId: string) => `${screenshotId}.crop`;
