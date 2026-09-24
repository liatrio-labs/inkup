// Region → elements (docs/PLAN.md): hit-test an 8×8 grid over the Annotation bbox plus sampled Stroke points
// with elementsFromPoint (our overlay excluded), add every hit element's ancestors, and describe each as a plain
// ElementSnapshot. Ranking happens in packages/core/src/candidates.ts (run by the service worker).

import { type ElementSnapshot, rankCandidates } from '@inkup/core/candidates';
import { evenlySample, gridPoints, type Point, type Rect } from '@inkup/core/geometry';
import { computeAccessibleName, getRole } from 'dom-accessibility-api';
import { CLASS_BLACKLIST, selectorFor, testAttributeOf } from './selector';
import { probeSources } from './source-probe';

// Grid + stroke samples rarely hit more than ~60 distinct elements; the cap only guards pathological DOMs.
const MAX_ELEMENTS = 200;
const MAX_STROKE_SAMPLES = 64;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

function visibleText(el: Element): string {
  const raw = el.textContent ?? '';
  // innerText forces layout and respects visibility; only worth it for small subtrees.
  if (raw.length < 4000 && el instanceof HTMLElement) return collapse(el.innerText ?? raw);
  return collapse(raw);
}

/** Class names a human would recognise (".card", ".btn"), not hashes or Tailwind utilities. */
function meaningfulClasses(el: Element): string[] {
  return [...el.classList].filter((c) => !CLASS_BLACKLIST.some((re) => re.test(`.${c}`))).slice(0, 8);
}

function depthOf(el: Element): number {
  let d = 0;
  for (let p = el.parentElement; p; p = p.parentElement) d++;
  return d;
}

/**
 * @param bbox Annotation bbox in page coordinates.
 * @param strokePoints Stroke points in page coordinates.
 * @param overlayHost Our shadow host; never a Candidate.
 */
export function snapshotElements(
  bbox: Rect,
  strokePoints: readonly Point[],
  overlayHost: Element | null,
): ElementSnapshot[] {
  return snapshotWithElements(bbox, strokePoints, overlayHost).snapshots;
}

/**
 * Snapshots, plus the source of each likely Candidate (E4): the elements the geometric ranking would list are asked
 * of the MAIN-world bridge, and `sourced` resolves once their snapshots carry `source` (set in place). Only those,
 * since reading a fiber's owner stack is not free and a snapshot can hold 200 elements.
 */
export function snapshotWithSources(
  bbox: Rect,
  strokePoints: readonly Point[],
  overlayHost: Element | null,
): { snapshots: ElementSnapshot[]; sourced: Promise<void> } {
  const { snapshots, elements } = snapshotWithElements(bbox, strokePoints, overlayHost);
  return { snapshots, ...sourceLikely(bbox, snapshots, elements) };
}

function snapshotWithElements(
  bbox: Rect,
  strokePoints: readonly Point[],
  overlayHost: Element | null,
): { snapshots: ElementSnapshot[]; elements: Map<string, Element> } {
  const sx = window.scrollX;
  const sy = window.scrollY;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hits = new Set<Element>();
  const strokeHits = new Set<Element>();

  const probe = (p: Point, into: Set<Element>[]) => {
    const x = p.x - sx;
    const y = p.y - sy;
    if (x < 0 || y < 0 || x >= vw || y >= vh) return;
    for (const el of document.elementsFromPoint(x, y)) {
      if (overlayHost && (el === overlayHost || overlayHost.contains(el))) continue;
      into.forEach((s) => {
        s.add(el);
      });
    }
  };
  for (const p of gridPoints(bbox, 8)) probe(p, [hits]);
  for (const p of evenlySample(strokePoints, MAX_STROKE_SAMPLES)) probe(p, [hits, strokeHits]);

  // Every hit element plus its ancestors. Past the cap the deepest are dropped, which keeps parent chains intact.
  const all = new Set<Element>();
  for (const el of hits) for (let e: Element | null = el; e; e = e.parentElement) all.add(e);
  const byDepth = [...all].map((el) => ({ el, depth: depthOf(el) }));
  byDepth.sort((a, b) => a.depth - b.depth);
  const kept = byDepth.length > MAX_ELEMENTS ? byDepth.slice(0, MAX_ELEMENTS) : byDepth;

  return describeAll(kept, (el) => strokeHits.has(el));
}

/** Plain snapshots of `kept` (parents before children), keyed e0, e1, … */
function describeAll(
  kept: readonly { el: Element; depth: number }[],
  strokeHit: (el: Element) => boolean,
): { snapshots: ElementSnapshot[]; elements: Map<string, Element> } {
  const keys = new Map<Element, string>();
  kept.forEach(({ el }, i) => {
    keys.set(el, `e${i}`);
  });
  const elements = new Map([...keys].map(([el, key]) => [key, el]));
  const snapshots = kept.map(({ el, depth }) =>
    describe(el, {
      key: keys.get(el)!,
      parent: el.parentElement ? (keys.get(el.parentElement) ?? null) : null,
      depth,
      stroke_hit: strokeHit(el),
    }),
  );
  return { snapshots, elements };
}

/**
 * One element named by the page (E5, the page API), wherever it is on the page: it and its ancestors, with the
 * sources of the ones the ranking lists. Its own box is the Annotation box, so it is the pick.
 */
export function snapshotElementWithSources(el: Element): {
  bbox: Rect;
  snapshots: ElementSnapshot[];
  sourced: Promise<void>;
} {
  const chain: { el: Element; depth: number }[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) chain.unshift({ el: e, depth: 0 });
  chain.forEach((c, i) => {
    c.depth = i;
  });
  const { snapshots, elements } = describeAll(chain, (e) => e === el);
  const r = el.getBoundingClientRect();
  const bbox = { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  return { bbox, snapshots, ...sourceLikely(bbox, snapshots, elements) };
}

function sourceLikely(
  bbox: Rect,
  snapshots: ElementSnapshot[],
  elements: Map<string, Element>,
): { sourced: Promise<void> } {
  const ranked = rankCandidates(bbox, snapshots);
  const wanted = new Set(ranked.candidates.map((c) => c.selector));
  const targets = snapshots.filter((s) => wanted.has(s.selector));
  const sourced = probeSources(targets.map((s) => elements.get(s.key)!)).then((sources) => {
    sources.forEach((source, i) => {
      if (source) targets[i]!.source = source;
    });
  });
  return { sourced };
}

/** The element's parent, stepping out of a shadow root to its host. */
export const composedParent = (el: Element): Element | null =>
  el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);

/** One element picked with Object Select (E7), which may sit inside a shadow root: its depth counts through shadow hosts. */
export function snapshotElement(el: Element): ElementSnapshot {
  let depth = 0;
  for (let p = composedParent(el); p; p = composedParent(p)) depth++;
  return describe(el, { key: 'e0', parent: null, depth, stroke_hit: false });
}

/** An Object Select pick with its source, when the page's framework reports one (E4). */
export async function snapshotElementSourced(el: Element): Promise<ElementSnapshot> {
  const snapshot = snapshotElement(el);
  const [source] = await probeSources([el]);
  if (source) snapshot.source = source;
  return snapshot;
}

function describe(el: Element, at: Pick<ElementSnapshot, 'key' | 'parent' | 'depth' | 'stroke_hit'>): ElementSnapshot {
  const r = el.getBoundingClientRect();
  let role: string | null = null;
  let name = '';
  try {
    role = getRole(el);
    name = collapse(computeAccessibleName(el));
  } catch {
    /* exotic elements (SVG internals) */
  }
  return {
    ...at,
    tag: el.tagName.toLowerCase(),
    role,
    name,
    text: visibleText(el),
    selector: selectorFor(el),
    testid: testAttributeOf(el)?.value ?? null,
    id: el.id || null,
    classes: meaningfulClasses(el),
    bbox: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
  };
}
