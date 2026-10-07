// The Object Select highlight (ADR 0011): the outline drawn around the element under the pointer (or the one picked)
// and the chip above it that names it and its size, `tag.class · W×H`. The logic layer (the extension's Object Select:
// hit-testing, ↑/↓ parent navigation, the capture-phase handlers) decides which element and where; this draws it at
// the rectangle it is given, and never takes a pointer event, so the page under it stays the page's to hit-test.
//
// It renders into the overlay host's one React root (mountSurfaces, ../toolbar) through `mountHighlight`. DESIGN.md
// on the colours: the inspector's content tint inside an ink edge, the tag chip for the label, and the red pen on the
// edge once the element is picked (a reviewer's mark; never a fill). `data-theme` names the palette it wears, light
// over a dark element and dark over a light one (E8); its edge and chip take the palette's paper so both stand out
// from the element under them.
import { cn } from '../lib/utils';
import type { Surfaces } from '../toolbar/surfaces';

export type HighlightTheme = 'light' | 'dark';

/** The rectangle of what is highlighted, in viewport px (a DOMRect or the like). */
export type HighlightRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height' | 'bottom'>;

export interface HighlightProps {
  /** The element outlined: the label names its tag and first two classes. */
  el: Element;
  /** Where to draw, in viewport px. */
  rect: HighlightRect;
  /** The pick is made (red pen edge) rather than a hover. */
  picked?: boolean;
  /** The palette to wear. Default dark, for a light page. */
  theme?: HighlightTheme;
  /** The label is off screen (for a screenshot: the outline is in it, the label is not). */
  labelHidden?: boolean;
}

/** The chip sits this far above the box (its height and a gap), or below it when the box is at the viewport's top. */
const CHIP_HEIGHT = 22;
const CHIP_GAP = 4;

/** `tag.class.class · W×H`: the element's tag, its first two classes and its size in px. */
export function highlightLabel(el: Element, rect: Pick<DOMRect, 'width' | 'height'>): string {
  const classes = [...el.classList]
    .slice(0, 2)
    .map((c) => `.${c}`)
    .join('');
  return `${el.tagName.toLowerCase()}${classes} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

// `data-island` is what shadow.css hangs the per-element palette on; the colours are the palette's, so an element on a
// dark page wears the light one. Pointer events are off on both: a hover must never be the highlight's own.
// The edge is 2px in the palette's paper over the inspector's content tint; a pick is the red pen at 3px, so the
// state reads by weight as well as hue. Flat, as the inspector draws it: no shadow, and no motion between elements
// (the box snaps to the next one; a tween would trail the pointer).
const OUTLINE = cn(
  'pointer-events-none fixed z-0 box-border rounded-[2px] border-2 border-paper bg-box-content',
  'data-[picked]:border-3 data-[picked]:border-pen',
);
// DESIGN.md's tag chip: a paper-step fill in the palette (navy with pale text over a light element, the inverted chip
// over a dark one), the mono Tag face at 12px and 1.2, radius `tag`.
const CHIP = cn(
  'pointer-events-none fixed z-0 max-w-[60vw] overflow-hidden rounded-tag bg-paper px-1.5 py-[3px] font-mono',
  'text-[12px] leading-[1.2] font-normal text-ellipsis whitespace-nowrap text-ink',
);

export function Highlight({ el, rect, picked = false, theme = 'dark', labelHidden = false }: HighlightProps) {
  return (
    <>
      <div
        data-island=""
        data-testid="object-select-highlight"
        data-theme={theme}
        data-picked={picked ? '' : undefined}
        className={OUTLINE}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      />
      <div
        data-island=""
        data-testid="object-select-label"
        data-theme={theme}
        className={CHIP}
        style={{
          left: Math.max(0, rect.left),
          top: rect.top >= CHIP_HEIGHT ? rect.top - CHIP_HEIGHT : rect.bottom + CHIP_GAP,
          visibility: labelHidden ? 'hidden' : undefined,
        }}
      >
        {highlightLabel(el, rect)}
      </div>
    </>
  );
}

/** What the logic layer drives: draw at a rectangle, hide, keep the label out of a screenshot. */
export interface MountedHighlight {
  /** Draws (or moves) the highlight around `el` at `rect`. Synchronous: the DOM is current on return. */
  show(view: Omit<HighlightProps, 'labelHidden'>): void;
  /** Takes it off the page. */
  hide(): void;
  /** The label off screen for a screenshot, or back; the outline stays, like the ink of a Stroke. */
  hideLabelForCapture(hidden: boolean): void;
  /** Removes it from the overlay's React root. */
  destroy(): void;
}

/** Renders the highlight into the overlay host's React root as the surface `key`, hidden until `show`. */
export function mountHighlight(surfaces: Surfaces, key = 'object-select-highlight'): MountedHighlight {
  let view: Omit<HighlightProps, 'labelHidden'> | null = null;
  let labelHidden = false;
  const render = () => surfaces.set(key, view ? <Highlight {...view} labelHidden={labelHidden} /> : null);
  return {
    show(next) {
      view = next;
      render();
    },
    hide() {
      if (!view) return;
      view = null;
      render();
    },
    hideLabelForCapture(hidden) {
      labelHidden = hidden;
      if (view) render();
    },
    destroy() {
      view = null;
      surfaces.set(key, null);
    },
  };
}
