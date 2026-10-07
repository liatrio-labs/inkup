// The page side of the toolbar. Its controls and behaviours are @inkup/ui's (packages/ui/tests/toolbar.test.tsx); here:
// where it sits (content/toolbar-position.ts), and how the overlay host carries it as content/client.ts mounts it: one
// React root in the shadow root (mountSurfaces) rendering synchronously, the package styles adopted into the shadow
// root with nothing added to the page, the theme set on the host by ToolbarThemer (content/theme.ts), hiding for a
// capture through the handle, and nothing left behind when the root goes.
import { mountInShadow } from '@inkup/ui/mount-in-shadow';
import { mountSurfaces, type Surfaces, Toolbar, type ToolbarHandle } from '@inkup/ui/toolbar';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolbarThemer } from '@/content/theme';
import { clampPosition, defaultPosition } from '@/content/toolbar-position';
import type { ToolbarActions, ToolbarState } from '@/messaging';

describe('toolbar position', () => {
  const size = { width: 300, height: 36 };
  const viewport = { width: 1280, height: 720 };

  it('keeps the toolbar fully on screen with a margin', () => {
    expect(clampPosition({ x: -50, y: -10 }, size, viewport)).toEqual({ x: 8, y: 8 });
    expect(clampPosition({ x: 5000, y: 5000 }, size, viewport)).toEqual({ x: 1280 - 300 - 8, y: 720 - 36 - 8 });
    expect(clampPosition({ x: 400.4, y: 300.6 }, size, viewport)).toEqual({ x: 400, y: 301 });
  });

  it('pins a toolbar wider than the viewport to the left edge', () => {
    expect(clampPosition({ x: 100, y: 100 }, { width: 500, height: 36 }, { width: 400, height: 720 })).toEqual({
      x: 8,
      y: 100,
    });
  });

  it('starts at the bottom right', () => {
    expect(defaultPosition(size, viewport)).toEqual({ x: 1280 - 300 - 24, y: 720 - 36 - 24 });
  });
});

const recording: ToolbarState = {
  session: {
    t0: Date.now() - 5_000,
    paused_ms: 0,
    paused_t: null,
    starting: false,
    stopping: false,
    draw_mode: false,
    select_mode: null,
    can_draw: true,
    here: true,
    video: 'recording',
    muted: false,
    voice: true,
  },
  start: { ok: true, video: 'tab_capture' },
  host: null,
  hostNetwork: false,
  toast: null,
  notice: null,
  viewport: null,
  discard: null,
};

function toolbarActions(over: Partial<ToolbarActions> = {}): ToolbarActions {
  const ok = () => Promise.resolve();
  return {
    start: vi.fn(() => Promise.resolve({ ok: false as const, error: 'no mic' })),
    pause: vi.fn(ok),
    resume: vi.fn(ok),
    stop: vi.fn(ok),
    cancel: vi.fn(ok),
    undoDiscard: vi.fn(ok),
    setMuted: vi.fn(ok),
    turnOnVoice: vi.fn(ok),
    setDraw: vi.fn(ok),
    setSelect: vi.fn(ok),
    snap: vi.fn(ok),
    open: vi.fn(ok),
    hide: vi.fn(ok),
    loadPosition: vi.fn(() => Promise.resolve(null)),
    savePosition: vi.fn(ok),
    ping: vi.fn(() => Promise.resolve(null)),
    frameUrl: null,
    clearAll: vi.fn(),
    cycleTheme: vi.fn(ok),
    ...over,
  };
}

describe('the toolbar in the overlay host', () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let container: HTMLElement;
  let surfaces: Surfaces;
  const ref: { current: ToolbarHandle | null } = { current: null };
  const $ = (id: string) => shadow.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const render = (state: ToolbarState, actions = toolbarActions()) =>
    surfaces.set('toolbar', createElement(Toolbar, { state, actions, ref }));

  beforeEach(() => {
    host = document.createElement('var-review-overlay');
    shadow = host.attachShadow({ mode: 'open' });
    container = document.createElement('div');
    shadow.append(container);
    document.documentElement.append(host);
    surfaces = mountSurfaces(container);
  });
  afterEach(() => {
    surfaces.unmount();
    host.remove();
  });

  it('renders synchronously into one React root in the shadow root, and adds nothing to the page', () => {
    const head = document.head.innerHTML;
    const bodyChildren = document.body.childElementCount;
    mountInShadow(shadow);
    render(recording);
    // On return: the content script places, themes and hides what it just rendered.
    expect($('toolbar')!.dataset.state).toBe('recording');
    expect(ref.current).not.toBeNull();
    expect(container.querySelectorAll('[data-surfaces]')).toHaveLength(1);
    expect(document.head.innerHTML).toBe(head);
    expect(document.body.childElementCount).toBe(bodyChildren);
    expect(document.querySelector('[data-testid="toolbar"]')).toBeNull();
  });

  it('updates in place on a push, and leaves nothing behind when the toolbar and then the root go', () => {
    render(recording);
    const draw = $('toolbar-draw')!;
    render({ ...recording, session: { ...recording.session!, draw_mode: true } });
    expect($('toolbar-draw')).toBe(draw);
    expect(draw.getAttribute('aria-pressed')).toBe('true');
    surfaces.set('toolbar', null);
    expect($('toolbar')).toBeNull();
    expect(ref.current).toBeNull();
    surfaces.unmount();
    expect(container.childElementCount).toBe(0);
    // A second unmount (the host leaving after the root went) is harmless.
    surfaces.unmount();
  });

  it('hides for a capture and comes back, through the handle the client calls', async () => {
    render(recording);
    await ref.current!.hideForCapture(true);
    expect($('toolbar')!.style.visibility).toBe('hidden');
    await ref.current!.hideForCapture(false);
    expect($('toolbar')!.style.visibility).toBe('');
  });

  it('ToolbarThemer sets data-theme on the host, where the package tokens read it, and on the toolbar', async () => {
    render(recording);
    let watch: (s: 'auto' | 'light' | 'dark') => void = () => {};
    const themer = new ToolbarThemer({
      host,
      target: ref.current!,
      sample: () => Promise.resolve(null),
      loadSetting: () => Promise.resolve('light'),
      watchSetting: (cb) => {
        watch = cb;
        return () => {};
      },
    });
    try {
      // Dark until the page is read, as the DOM toolbar was, whatever the system scheme.
      expect(host.dataset.theme).toBe('dark');
      await vi.waitFor(() => expect(host.dataset.theme).toBe('light'));
      expect($('toolbar')!.dataset.theme).toBe('light');
      expect($('toolbar')!.dataset.themeFrom).toBe('setting');
      expect($('toolbar-theme')!.dataset.setting).toBe('light');
      watch('dark');
      await vi.waitFor(() => expect(host.dataset.theme).toBe('dark'));
      expect($('toolbar-toast')!.dataset.theme).toBe('dark');
    } finally {
      themer.destroy();
    }
  });
});
