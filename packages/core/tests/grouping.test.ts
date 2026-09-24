import { describe, expect, it } from 'vitest';
import {
  closeDeadline,
  type GroupingInput,
  groupAll,
  initialGroupingState,
  type StrokeRef,
  stepGrouping,
} from '../src/grouping';

const stroke = (id: string, t: number, t_end: number, x = 0): StrokeRef => ({
  stroke_id: id,
  t,
  t_end,
  bbox: { x, y: 0, width: 10, height: 10 },
});
const drawn = (s: StrokeRef): GroupingInput[] => [
  { kind: 'pointer_down', t: s.t },
  { kind: 'stroke', stroke: s },
];

describe('Annotation grouping by time gap', () => {
  it('joins a Stroke that starts within 1.5s of the previous one ending', () => {
    const { closed, state } = groupAll([...drawn(stroke('a', 0, 400)), ...drawn(stroke('b', 1900, 2300, 50))]);
    expect(closed).toEqual([]);
    expect(state.open?.strokes.map((s) => s.stroke_id)).toEqual(['a', 'b']);
    expect(state.open).toMatchObject({ t: 0, t_end: 2300 });
  });

  it('treats exactly 1.5s as within the gap and 1.501s as outside', () => {
    expect(groupAll([...drawn(stroke('a', 0, 100)), ...drawn(stroke('b', 1600, 1700))]).closed).toHaveLength(0);
    const { closed, state } = groupAll([...drawn(stroke('a', 0, 100)), ...drawn(stroke('b', 1601, 1700))]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ close_reason: 'time_gap', closed_at: 1600, t: 0, t_end: 100 });
    expect(state.open?.strokes.map((s) => s.stroke_id)).toEqual(['b']);
  });

  it('closes on a tick after the gap, with the union bbox of its Strokes', () => {
    const { state } = groupAll([...drawn(stroke('a', 0, 300, 0)), ...drawn(stroke('b', 500, 900, 100))]);
    expect(closeDeadline(state)).toBe(2401);
    let r = stepGrouping(state, { kind: 'tick', t: 2400 });
    expect(r.closed).toEqual([]);
    r = stepGrouping(r.state, { kind: 'tick', t: 2401 });
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0]!.bbox).toEqual({ x: 0, y: 0, width: 110, height: 10 });
    expect(r.state.open).toBeNull();
    expect(closeDeadline(r.state)).toBeNull();
  });

  it('never closes on a tick while the pointer is down, however long the Stroke takes', () => {
    let { state } = groupAll(drawn(stroke('a', 0, 100)));
    state = stepGrouping(state, { kind: 'pointer_down', t: 1200 }).state;
    expect(closeDeadline(state)).toBeNull();
    const r = stepGrouping(state, { kind: 'tick', t: 9000 });
    expect(r.closed).toEqual([]);
    // The long Stroke started within the gap, so it joins.
    const r2 = stepGrouping(r.state, { kind: 'stroke', stroke: stroke('b', 1200, 9000) });
    expect(r2.closed).toEqual([]);
    expect(r2.state.open?.strokes).toHaveLength(2);
  });

  it('closes the open group as soon as a late pointer-down arrives (before the tick fires)', () => {
    const { state } = groupAll(drawn(stroke('a', 0, 100)));
    const r = stepGrouping(state, { kind: 'pointer_down', t: 5000 });
    expect(r.closed.map((c) => c.close_reason)).toEqual(['time_gap']);
    expect(r.state).toEqual({ open: null, drawing: true });
  });

  it('accepts later close signals as inputs (e.g. scroll, next, session end)', () => {
    const { closed, state } = groupAll([
      ...drawn(stroke('a', 0, 100)),
      { kind: 'signal', reason: 'voice_command', t: 300 },
      ...drawn(stroke('b', 400, 500)),
      { kind: 'signal', reason: 'session_end', t: 600 },
      { kind: 'signal', reason: 'scroll', t: 700 }, // nothing open: no-op
    ]);
    expect(closed.map((c) => [c.close_reason, c.strokes.map((s) => s.stroke_id), c.closed_at])).toEqual([
      ['voice_command', ['a'], 300],
      ['session_end', ['b'], 600],
    ]);
    expect(state.open).toBeNull();
  });

  it('ticks and signals with nothing open are no-ops', () => {
    const s = initialGroupingState();
    expect(stepGrouping(s, { kind: 'tick', t: 99 })).toEqual({ state: s, closed: [] });
    expect(stepGrouping(s, { kind: 'signal', reason: 'draw_toggle', t: 99 }).closed).toEqual([]);
  });

  it('honours a custom gap', () => {
    const { closed } = groupAll([...drawn(stroke('a', 0, 100)), ...drawn(stroke('b', 700, 800))], { gapMs: 500 });
    expect(closed).toHaveLength(1);
  });

  it('rejects a Stroke that ends before it starts', () => {
    expect(() => stepGrouping(initialGroupingState(), { kind: 'stroke', stroke: stroke('x', 10, 5) })).toThrow(
      RangeError,
    );
  });
});

describe('Annotation grouping signals (Slice 3)', () => {
  const vp = (y: number, x = 0) => ({ scroll: { x, y }, viewport: { width: 1000, height: 800 } });
  const at = (s: StrokeRef, y: number, x = 0): StrokeRef => ({ ...s, at: vp(y, x) });

  it('closes when the page scrolls more than 25% of the viewport since the first Stroke', () => {
    const { closed, state } = groupAll([
      ...drawn(at(stroke('a', 0, 100), 0)),
      { kind: 'scroll', t: 200, at: vp(200) }, // exactly 25%: stays open
      { kind: 'scroll', t: 300, at: vp(201) },
    ]);
    expect(closed.map((c) => [c.close_reason, c.closed_at])).toEqual([['scroll', 300]]);
    expect(state.open).toBeNull();
  });

  it('measures the horizontal axis against the viewport width', () => {
    expect(
      groupAll([...drawn(at(stroke('a', 0, 100), 0)), { kind: 'scroll', t: 200, at: vp(0, 251) }]).closed[0]
        ?.close_reason,
    ).toBe('scroll');
    expect(groupAll([...drawn(at(stroke('a', 0, 100), 0)), { kind: 'scroll', t: 200, at: vp(0, 249) }]).closed).toEqual(
      [],
    );
  });

  it('a Stroke drawn after a big scroll starts a new Annotation even inside the time gap', () => {
    const { closed, state } = groupAll([
      ...drawn(at(stroke('a', 0, 100), 0)),
      ...drawn(at(stroke('b', 500, 600), 400)),
    ]);
    expect(closed.map((c) => [c.close_reason, c.strokes.map((s) => s.stroke_id)])).toEqual([['scroll', ['a']]]);
    expect(state.open?.strokes.map((s) => s.stroke_id)).toEqual(['b']);
    expect(state.open?.anchor).toEqual(vp(400));
  });

  it('small scrolls keep the group open and the anchor stays at the first Stroke', () => {
    const { closed, state } = groupAll([
      ...drawn(at(stroke('a', 0, 100), 0)),
      { kind: 'scroll', t: 150, at: vp(150) },
      ...drawn(at(stroke('b', 300, 400), 150)),
      { kind: 'scroll', t: 450, at: vp(210) },
    ]);
    expect(closed.map((c) => c.close_reason)).toEqual(['scroll']);
    expect(closed[0]!.strokes.map((s) => s.stroke_id)).toEqual(['a', 'b']);
    expect(state.open).toBeNull();
  });

  it('a Speech Boundary closes only a group that began before it', () => {
    const early = groupAll([
      ...drawn(stroke('a', 1000, 1400)),
      { kind: 'signal', reason: 'speech_boundary', t: 1800, ifOpenedBefore: 1200 },
    ]);
    expect(early.closed.map((c) => [c.close_reason, c.closed_at])).toEqual([['speech_boundary', 1800]]);
    // The demonstrative was spoken before the drawing started: it belongs to this group, which stays open.
    const late = groupAll([
      ...drawn(stroke('a', 1000, 1400)),
      { kind: 'signal', reason: 'speech_boundary', t: 1800, ifOpenedBefore: 900 },
    ]);
    expect(late.closed).toEqual([]);
    expect(late.state.open?.strokes).toHaveLength(1);
  });

  it('draw toggle, navigation, next and pause close whatever is open', () => {
    for (const reason of ['draw_toggle', 'navigation', 'voice_command', 'pause'] as const) {
      expect(
        groupAll([...drawn(stroke('a', 0, 100)), { kind: 'signal', reason, t: 200 }]).closed.map((c) => c.close_reason),
      ).toEqual([reason]);
    }
  });
});
