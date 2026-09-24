// Candidate ranking (PRD P0-4). Pure: the content script snapshots page elements into plain objects; this
// module decides the geometric pick and the Candidate list. Speech picks the final winner at Process time.
//
// - Geometric pick: the element the Strokes enclose. Among elements lying (>= 80%) inside the Annotation bbox
//   and filling at least a quarter of it, the one filling most of it (a loose circle around a button picks the
//   button, not the card around it). When the mark encloses nothing that size (an underline, a scribble over
//   text), the deepest element whose box covers >= 70% of the bbox; otherwise the element with the largest
//   overlap.
// - Candidates: the pick, up to 5 of its ancestors (nearest first), then siblings of the pick the Strokes cover,
//   then up to 8 enclosed descendants of the pick (largest coverage first). Descendants keep a loose circle
//   around a card from hiding the button inside it: "this button" can still resolve to it (fixture d).
// - Region fallback: nothing overlaps, or the pick is opaque to the DOM (canvas, iframe, embed, object).
// - An Object Select pick (E7) needs no ranking: the reviewer chose the element, so it is the one definite Candidate.
import { area, intersectionArea, type Rect } from './geometry.ts';
import type { Candidate, Source } from './timeline.ts';

export interface ElementSnapshot {
  /** Unique within one snapshot batch. */
  key: string;
  /** Key of the parent element, or null for the root. Content scripts include every hit element's ancestors. */
  parent: string | null;
  /** Distance from the document element (html = 0). */
  depth: number;
  tag: string;
  role: string | null;
  name: string;
  text: string;
  selector: string;
  testid: string | null;
  id: string | null;
  /** Meaningful class names (generated and utility classes already removed), at most 8. */
  classes: string[];
  /** Page coordinates. */
  bbox: Rect;
  /** A sampled Stroke point lies on this element. */
  stroke_hit: boolean;
  /** Where the page's framework says the element comes from (read for likely Candidates only). */
  source?: Source;
}

export interface RankOptions {
  coverThreshold?: number;
  maxAncestors?: number;
  /** A sibling counts as covered when this fraction of its own box lies inside the Annotation bbox. */
  siblingInside?: number;
  /** A descendant counts as enclosed when this fraction of its own box lies inside the Annotation bbox. */
  descendantInside?: number;
  maxDescendants?: number;
  /** An enclosed element is the pick only when it fills at least this fraction of the Annotation bbox. */
  encloseFloor?: number;
}

export interface Ranking {
  resolution: 'element' | 'region';
  candidates: Candidate[];
  pick: number | null;
}

/** Never Candidates: they enclose everything and say nothing. */
const IGNORED_TAGS = new Set(['html', 'body', 'head']);
/** Elements whose content the DOM cannot see into. */
export const REGION_TAGS = new Set(['canvas', 'iframe', 'frame', 'embed', 'object']);
/** Lines and dots have no area; give the bbox a minimum extent so coverage stays meaningful. */
const MIN_EXTENT = 4;

const REGION: Ranking = { resolution: 'region', candidates: [], pick: null };

function inflate(r: Rect): Rect {
  const w = Math.max(r.width, MIN_EXTENT);
  const h = Math.max(r.height, MIN_EXTENT);
  return { x: r.x - (w - r.width) / 2, y: r.y - (h - r.height) / 2, width: w, height: h };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function candidateOf(s: ElementSnapshot, relation: Candidate['relation'], coverage: number): Candidate {
  return {
    selector: s.selector,
    tag: s.tag,
    role: s.role,
    name: s.name.slice(0, 200),
    text: s.text.slice(0, 200),
    testid: s.testid,
    id: s.id,
    classes: s.classes.slice(0, 8),
    bbox: s.bbox,
    relation,
    coverage,
    ...(s.source ? { source: s.source } : {}),
  };
}

/** An element picked with Object Select: the Annotation's only Candidate, its pick, covering its whole bbox. */
export function objectSelectRanking(picked: ElementSnapshot): Ranking & { resolution: 'element'; pick: 0 } {
  return { resolution: 'element', candidates: [candidateOf(picked, 'pick', 1)], pick: 0 };
}

export function rankCandidates(
  annotationBox: Rect,
  snapshots: readonly ElementSnapshot[],
  opts: RankOptions = {},
): Ranking {
  const {
    coverThreshold = 0.7,
    maxAncestors = 5,
    siblingInside = 0.5,
    descendantInside = 0.8,
    maxDescendants = 8,
    encloseFloor = 0.25,
  } = opts;
  const box = inflate(annotationBox);
  const boxArea = area(box);
  const byKey = new Map(snapshots.map((s) => [s.key, s]));
  const usable = snapshots.filter((s) => !IGNORED_TAGS.has(s.tag) && area(s.bbox) > 0);
  const overlap = new Map(usable.map((s) => [s.key, intersectionArea(s.bbox, box)]));
  const coverage = (s: ElementSnapshot) => (boxArea > 0 ? Math.min(1, intersectionArea(s.bbox, box) / boxArea) : 0);

  const inside = (s: ElementSnapshot) => intersectionArea(s.bbox, box) / area(s.bbox);
  const enclosed = usable.filter((s) => inside(s) >= descendantInside && coverage(s) >= encloseFloor);
  const covering = usable.filter((s) => (overlap.get(s.key) ?? 0) / boxArea >= coverThreshold);
  let pick: ElementSnapshot | undefined;
  if (enclosed.length > 0) {
    pick = enclosed.reduce((best, s) => {
      const c = coverage(s);
      const bc = coverage(best);
      return c > bc || (c === bc && s.depth > best.depth) ? s : best;
    });
  } else if (covering.length > 0) {
    pick = covering.reduce((best, s) =>
      s.depth > best.depth || (s.depth === best.depth && area(s.bbox) < area(best.bbox)) ? s : best,
    );
  } else {
    pick = usable.reduce<ElementSnapshot | undefined>((best, s) => {
      const o = overlap.get(s.key) ?? 0;
      if (o <= 0) return best;
      if (!best) return s;
      const bo = overlap.get(best.key) ?? 0;
      return o > bo || (o === bo && s.depth > best.depth) ? s : best;
    }, undefined);
  }
  if (!pick || REGION_TAGS.has(pick.tag)) return REGION;

  const toCandidate = (s: ElementSnapshot, relation: Candidate['relation']): Candidate =>
    candidateOf(s, relation, round3(coverage(s)));

  const candidates: Candidate[] = [toCandidate(pick, 'pick')];
  let parent = pick.parent ? byKey.get(pick.parent) : undefined;
  while (parent && candidates.length <= maxAncestors && !IGNORED_TAGS.has(parent.tag)) {
    candidates.push(toCandidate(parent, 'ancestor'));
    parent = parent.parent ? byKey.get(parent.parent) : undefined;
  }

  const siblings = usable
    .filter((s) => s.key !== pick.key && s.parent !== null && s.parent === pick.parent)
    .filter((s) => s.stroke_hit || inside(s) >= siblingInside)
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  for (const s of siblings) candidates.push(toCandidate(s, 'sibling'));

  // Every snapshot is a sampled hit or an ancestor of one, so the pick's descendants here are exactly the
  // elements under the grid or Stroke samples inside it.
  const isDescendant = (s: ElementSnapshot) => {
    for (let p = s.parent ? byKey.get(s.parent) : undefined; p; p = p.parent ? byKey.get(p.parent) : undefined)
      if (p.key === pick.key) return true;
    return false;
  };
  const descendants = usable
    .filter((s) => s.key !== pick.key && isDescendant(s))
    .filter((s) => inside(s) >= descendantInside)
    .map((s) => ({ s, c: coverage(s) }))
    .sort((a, b) => b.c - a.c || a.s.depth - b.s.depth || a.s.bbox.y - b.s.bbox.y || a.s.bbox.x - b.s.bbox.x)
    .slice(0, maxDescendants);
  for (const { s } of descendants) candidates.push(toCandidate(s, 'descendant'));

  return { resolution: 'element', candidates, pick: 0 };
}
