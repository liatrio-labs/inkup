import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ViewportActions, ViewportControl } from '@/content/viewport-control';
import type { ToolbarViewport } from '@/messaging';

const viewportState = (over: Partial<ToolbarViewport> = {}): ToolbarViewport => ({
  current: null,
  tab: { width: 1280, height: 900 },
  last: null,
  ...over,
});

function actions(): ViewportActions & { [K in keyof ViewportActions]: ReturnType<typeof vi.fn> } {
  return { set: vi.fn(() => Promise.resolve({ ok: true as const })), reset: vi.fn(() => Promise.resolve()) };
}

describe('ViewportControl', () => {
  let container: HTMLElement;
  let ctl: ViewportControl | null = null;
  const $ = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });
  afterEach(() => {
    ctl?.destroy();
    ctl = null;
    container.remove();
  });

  function mount(state: ToolbarViewport | null, a = actions(), fail = vi.fn()) {
    ctl = new ViewportControl(container, a, fail);
    container.append(ctl.button);
    ctl.update(state);
    return { a, fail };
  }

  it('is hidden where no mechanism can resize the page', () => {
    mount(null);
    expect($('toolbar-viewport')!.hidden).toBe(true);
  });

  it('offers the presets, Fit to tab and a typed size, and applies what is picked', async () => {
    const { a } = mount(viewportState());
    expect($('toolbar-viewport')!.textContent).toBe('Viewport');
    $('toolbar-viewport')!.click();
    expect($('viewport-menu')!.hidden).toBe(false);
    for (const id of ['375x812', '390x844', '768x1024', '1280x800', '1440x900'])
      expect($(`viewport-preset-${id}`)).not.toBeNull();
    expect($('viewport-fit')!.textContent).toContain('1280×900');
    expect($('viewport-reset')).toBeNull();
    $('viewport-preset-375x812')!.click();
    expect(a.set).toHaveBeenCalledWith({ width: 375, height: 812 });
    expect($('viewport-menu')!.hidden).toBe(true);

    $('toolbar-viewport')!.click();
    ($('viewport-width') as HTMLInputElement).value = '901.4';
    ($('viewport-height') as HTMLInputElement).value = '50';
    $('viewport-apply')!.click();
    // Clamped: whole px, and no smaller than 200.
    expect(a.set).toHaveBeenLastCalledWith({ width: 901, height: 200 });
  });

  it('shows the size and the scale, the last size used here, and Reset once resized', () => {
    const { a } = mount(
      viewportState({ current: { width: 1600, height: 1000, scale: 0.8 }, last: { width: 1000, height: 700 } }),
    );
    expect($('toolbar-viewport')!.textContent).toBe('1600×1000 at 80%');
    // The drag handles are the frame host page's, not the toolbar's.
    expect(container.querySelector('[data-testid^="viewport-handle"]')).toBeNull();
    $('toolbar-viewport')!.click();
    expect($('viewport-last')!.textContent).toContain('1000×700');
    $('viewport-reset')!.click();
    expect(a.reset).toHaveBeenCalled();
  });

  it('on a page that refuses framing, shows the reason instead of sizes', () => {
    mount(viewportState({ blocked: 'This site does not allow being shown in a frame (X-Frame-Options: DENY)' }));
    expect($('toolbar-viewport')!.hidden).toBe(false);
    expect($('toolbar-viewport')!.title).toContain('X-Frame-Options');
    $('toolbar-viewport')!.click();
    expect($('viewport-blocked')!.textContent).toContain('X-Frame-Options: DENY');
    expect($('viewport-preset-375x812')).toBeNull();
  });

  it('says why a size could not be set', async () => {
    const a = actions();
    a.set.mockResolvedValue({ ok: false, error: 'This site does not allow being shown in a frame' });
    const { fail } = mount(viewportState(), a);
    $('toolbar-viewport')!.click();
    $('viewport-preset-768x1024')!.click();
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('This site does not allow being shown in a frame'));
  });
});
