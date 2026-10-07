// The viewport control as the page carries it: in the toolbar's viewport slot, inside the overlay's shadow root. Its
// menu's own rules are @inkup/ui's (packages/ui/tests/viewport-control.test.tsx); here, that the toolbar fills the slot
// from the pushed ToolbarViewport, that its requests reach the extension's ViewportActions, that a failure lands in the
// toolbar's notice, and that a pointer-down elsewhere on the page closes a menu that lives in a shadow root.
import { mountSurfaces, type Surfaces, Toolbar } from '@inkup/ui/toolbar';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolbarActions, ToolbarState, ToolbarViewport, ViewportActions } from '@/messaging';

const viewportState = (over: Partial<ToolbarViewport> = {}): ToolbarViewport => ({
  current: null,
  tab: { width: 1280, height: 900 },
  last: null,
  ...over,
});
const idle = (viewport: ToolbarViewport | null): ToolbarState => ({
  session: null,
  start: { ok: true, video: 'tab_capture' },
  host: null,
  hostNetwork: false,
  toast: null,
  notice: null,
  viewport,
  discard: null,
});

function actions(viewport: ViewportActions): ToolbarActions {
  const ok = () => Promise.resolve();
  return {
    start: vi.fn(() => Promise.resolve({ ok: true as const })),
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
    viewport,
  };
}

describe('the viewport control in the toolbar', () => {
  let host: HTMLElement;
  let shadow: ShadowRoot;
  let surfaces: Surfaces;
  let vp: {
    set: ReturnType<typeof vi.fn<ViewportActions['set']>>;
    reset: ReturnType<typeof vi.fn<ViewportActions['reset']>>;
  };
  const $ = (id: string) => shadow.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const render = (viewport: ToolbarViewport | null) =>
    surfaces.set('toolbar', createElement(Toolbar, { state: idle(viewport), actions: actions(vp) }));

  beforeEach(() => {
    host = document.createElement('var-review-overlay');
    shadow = host.attachShadow({ mode: 'open' });
    const container = document.createElement('div');
    shadow.append(container);
    document.documentElement.append(host);
    surfaces = mountSurfaces(container);
    vp = { set: vi.fn(() => Promise.resolve({ ok: true as const })), reset: vi.fn(() => Promise.resolve()) };
  });
  afterEach(() => {
    surfaces.unmount();
    host.remove();
  });

  it('is hidden where no mechanism can resize the page', () => {
    render(null);
    expect($('toolbar-viewport')!.hidden).toBe(true);
    expect(shadow.querySelector<HTMLElement>('[data-slot="viewport"]')!.hidden).toBe(true);
  });

  it('asks the extension for a preset and for the tab size, and shows the size pushed back', async () => {
    render(viewportState());
    expect($('toolbar-viewport')!.textContent).toBe('Viewport');
    $('toolbar-viewport')!.click();
    await vi.waitFor(() => expect($('viewport-menu')!.hidden).toBe(false));
    $('viewport-preset-375x812')!.click();
    await vi.waitFor(() => expect(vp.set).toHaveBeenCalledWith({ width: 375, height: 812 }));
    render(viewportState({ current: { width: 375, height: 812, scale: 1 } }));
    expect($('toolbar-viewport')!.textContent).toBe('375×812');
    $('toolbar-viewport')!.click();
    await vi.waitFor(() => expect($('viewport-reset')).not.toBeNull());
    $('viewport-reset')!.click();
    await vi.waitFor(() => expect(vp.reset).toHaveBeenCalled());
  });

  it('a size that could not be set shows in the toolbar toast', async () => {
    vp.set.mockResolvedValue({ ok: false, error: 'This site does not allow being shown in a frame' });
    render(viewportState());
    $('toolbar-viewport')!.click();
    await vi.waitFor(() => expect($('viewport-menu')!.hidden).toBe(false));
    $('viewport-preset-768x1024')!.click();
    await vi.waitFor(() =>
      expect($('toolbar-toast')!.textContent).toBe('This site does not allow being shown in a frame'),
    );
  });

  it('a pointer-down on the page outside the shadow root closes the menu', async () => {
    render(viewportState());
    $('toolbar-viewport')!.click();
    await vi.waitFor(() => expect($('viewport-menu')!.hidden).toBe(false));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await vi.waitFor(() => expect($('viewport-menu')!.hidden).toBe(true));
  });
});
