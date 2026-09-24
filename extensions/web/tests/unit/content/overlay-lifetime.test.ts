// E9: no ink stays on the page for good. A fake clock drives the overlay cap, the activity refresh and the hung close.

import { CLOSE_TIMEOUT_MS, SHOT_TIMEOUT_MS } from '@inkup/core/overlay-lifetime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverlayCallbacks } from '@/content/overlay';
import type { ContentSessionState } from '@/messaging';

let cap = 30_000;
vi.mock('@/content/lifetime', () => ({ maxOverlayMs: () => cap }));
// The DOM snapshot is not what these tests are about.
vi.mock('@/content/snapshot', () => ({ snapshotWithSources: () => ({ snapshots: [], sourced: Promise.resolve() }) }));

const { DrawingOverlay } = await import('@/content/overlay');

const never = (): Promise<unknown> => new Promise(() => {});

function mount(extra: Partial<OverlayCallbacks> = {}) {
  const host = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(host, container);
  const state: ContentSessionState = {
    session_id: 's',
    t0: Date.now(),
    draw_mode: true,
    select_mode: null,
    fade_ms: 1000,
    paused: false,
    muted: false,
    voice: true,
    box_dictation: 'push',
  };
  const cb = {
    recordStroke: vi.fn(() => Promise.resolve()),
    closeAnnotation: vi.fn(never),
    captureAnnotation: vi.fn((): Promise<{ screenshot_id: string | null }> => new Promise(() => {})),
    recordClick: vi.fn(() => Promise.resolve()),
    pressInteractive: vi.fn(() => Promise.resolve()),
    recordScrollSettle: vi.fn(() => Promise.resolve()),
    sampleBackground: vi.fn(() => Promise.resolve(null)),
  };
  const overlay = new DrawingOverlay(container, host, state, { ...cb, ...extra });
  const canvas = container.querySelector<HTMLCanvasElement>('[data-testid=overlay-canvas]')!;
  const at = (type: string, x: number, y: number) =>
    canvas.dispatchEvent(new PointerEvent(type, { button: 0, clientX: x, clientY: y, pointerId: 1, bubbles: true }));
  const kept = () => Number(canvas.dataset.strokes);
  const visible = () => Number(canvas.dataset.visible);
  return { overlay, cb, at, kept, visible };
}

beforeEach(() => {
  vi.useFakeTimers();
  cap = 30_000;
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {} })) as never;
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('overlay lifetime', () => {
  it('fades ink at the cap while its screenshot and close never answer, and the Annotation is still recorded without a screenshot', async () => {
    cap = 3_000;
    const { overlay, cb, at, kept, visible } = mount();
    at('pointerdown', 10, 10);
    at('pointermove', 60, 60);
    at('pointerup', 60, 60);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(visible()).toBe(1);
    // The sweeper looks once a second, and the fade takes 350 ms.
    await vi.advanceTimersByTimeAsync(3_000);
    // Past the cap: gone from the page (its Stroke was already sent), while the close still waits for the screenshot.
    expect(visible()).toBe(0);
    expect(kept()).toBe(0);
    expect(cb.recordStroke).toHaveBeenCalledTimes(1);
    expect(cb.closeAnnotation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
    expect(cb.closeAnnotation).toHaveBeenCalledWith(expect.objectContaining({ screenshot_id: null }));
    overlay.destroy();
  });

  it('counts the cap from the last move, not from the pointer-down', async () => {
    cap = 3_000;
    const { overlay, at, visible } = mount();
    at('pointerdown', 10, 10);
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
      at('pointermove', 10 + i * 10, 10);
    }
    // 8 s after the pointer-down, 0 s after the last move: still drawn.
    expect(visible()).toBe(1);
    // The pointer-up never comes; the cap from the last move ends the Stroke and fades it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(visible()).toBe(0);
    overlay.destroy();
  });

  it('finishes a close whose screenshot and close hang: screenshot_id null, and the ink fades well before the cap', async () => {
    const { overlay, cb, at, kept } = mount();
    at('pointerdown', 10, 10);
    at('pointermove', 60, 60);
    at('pointerup', 60, 60);
    // The Annotation closes on the 1.5 s gap, waits SHOT_TIMEOUT_MS for the screenshot, then closes without it.
    await vi.advanceTimersByTimeAsync(1_500 + SHOT_TIMEOUT_MS + 100);
    expect(cb.captureAnnotation).toHaveBeenCalledTimes(1);
    expect(cb.closeAnnotation).toHaveBeenCalledWith(expect.objectContaining({ screenshot_id: null }));
    expect(kept()).toBe(1);
    // The close never answers: given up on after CLOSE_TIMEOUT_MS, then the fade.
    await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
    expect(kept()).toBe(0);
    overlay.destroy();
  });

  it('waits for a note being typed without the close timeout, and keeps its ink on screen meanwhile', async () => {
    let answer: (note: string | null) => void = () => {};
    const noteFor = vi.fn(() => new Promise<string | null>((r) => (answer = r)));
    const { overlay, cb, at, visible } = mount({ noteFor });
    cb.closeAnnotation.mockImplementation(() => Promise.resolve());
    cb.captureAnnotation.mockImplementation(() => Promise.resolve({ screenshot_id: 'shot' }));
    at('pointerdown', 10, 10);
    at('pointermove', 60, 60);
    at('pointerup', 60, 60);
    await vi.advanceTimersByTimeAsync(1_500 + CLOSE_TIMEOUT_MS + 2_000);
    expect(noteFor).toHaveBeenCalledTimes(1);
    expect(cb.closeAnnotation).not.toHaveBeenCalled();
    expect(visible()).toBe(1);
    answer('make it bigger');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cb.closeAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'make it bigger', screenshot_id: 'shot' }),
    );
    expect(visible()).toBe(0);
    overlay.destroy();
  });

  it('Clear all removes the ink at once and closes the Annotation as cleared, with no screenshot', async () => {
    const { overlay, cb, at, visible } = mount();
    cb.closeAnnotation.mockImplementation(() => Promise.resolve());
    at('pointerdown', 10, 10);
    at('pointermove', 60, 60);
    at('pointerup', 60, 60);
    expect(overlay.clearAll()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(visible()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(cb.captureAnnotation).not.toHaveBeenCalled();
    expect(cb.closeAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ close_reason: 'cleared', screenshot_id: null }),
    );
    overlay.destroy();
  });
});
