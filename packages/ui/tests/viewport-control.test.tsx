// The viewport control (plan E6) against the ToolbarViewport the service worker pushes: the presets, Fit to tab, the
// typed W×H, the last size used here, Reset, the current size on the button, and a page that refuses framing. It only
// asks (ViewportActions) and shows; the drag edges are the frame host's own.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewportControl } from '../src/toolbar';
import type { ToolbarViewport, ViewportActions } from '../src/toolbar-state';

const viewportState = (over: Partial<ToolbarViewport> = {}): ToolbarViewport => ({
  current: null,
  tab: { width: 1280, height: 900 },
  last: null,
  ...over,
});

function actions() {
  return {
    set: vi.fn<ViewportActions['set']>(() => Promise.resolve({ ok: true as const })),
    reset: vi.fn<ViewportActions['reset']>(() => Promise.resolve()),
  };
}

function mount(state: ToolbarViewport | null, a = actions(), onError = vi.fn()) {
  const r = render(<ViewportControl viewport={state} actions={a} onError={onError} />);
  return {
    a,
    onError,
    update: (next: ToolbarViewport | null) =>
      r.rerender(<ViewportControl viewport={next} actions={a} onError={onError} />),
  };
}

const $ = (id: string) => screen.queryByTestId(id);
const open = () => fireEvent.click(screen.getByTestId('toolbar-viewport'));

afterEach(cleanup);

describe('ViewportControl', () => {
  it('is hidden where no mechanism can resize the page', () => {
    mount(null);
    expect($('toolbar-viewport')!.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Viewport' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers the presets, Fit to tab and a typed size, and applies what is picked', () => {
    const { a } = mount(viewportState());
    const button = screen.getByRole('button', { name: 'Viewport' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Viewport size' });
    expect(menu.hidden).toBe(false);
    for (const id of ['375x812', '390x844', '768x1024', '1280x800', '1440x900'])
      expect($(`viewport-preset-${id}`)!.getAttribute('role')).toBe('menuitemradio');
    expect(screen.getByRole('menuitemradio', { name: /Phone 375×812/ })).toBe($('viewport-preset-375x812'));
    expect($('viewport-fit')!.textContent).toContain('1280×900');
    expect($('viewport-reset')).toBeNull();
    // On open the keyboard is on the first item.
    expect(document.activeElement).toBe($('viewport-preset-375x812'));
    fireEvent.click($('viewport-preset-375x812')!);
    expect(a.set).toHaveBeenCalledWith({ width: 375, height: 812 });
    expect($('viewport-menu')!.hidden).toBe(true);

    open();
    fireEvent.change(screen.getByLabelText('Width in CSS px'), { target: { value: '901.4' } });
    fireEvent.change(screen.getByLabelText('Height in CSS px'), { target: { value: '50' } });
    fireEvent.click($('viewport-apply')!);
    // Clamped: whole px, and no smaller than 200.
    expect(a.set).toHaveBeenLastCalledWith({ width: 901, height: 200 });
  });

  it('applies a typed size on Enter, and Fit to tab asks for the tab size', () => {
    const { a } = mount(viewportState());
    open();
    fireEvent.change($('viewport-width')!, { target: { value: '900' } });
    fireEvent.change($('viewport-height')!, { target: { value: '700' } });
    fireEvent.keyDown($('viewport-height')!, { key: 'Enter' });
    expect(a.set).toHaveBeenLastCalledWith({ width: 900, height: 700 });
    open();
    fireEvent.click($('viewport-fit')!);
    expect(a.set).toHaveBeenLastCalledWith({ width: 1280, height: 900 });
  });

  it('Escape closes the menu and gives the keyboard back to the button; a click outside closes it', () => {
    mount(viewportState());
    open();
    fireEvent.keyDown($('viewport-preset-390x844')!, { key: 'Escape' });
    expect($('viewport-menu')!.hidden).toBe(true);
    expect(document.activeElement).toBe($('toolbar-viewport'));
    open();
    fireEvent.pointerDown(document.body);
    expect($('viewport-menu')!.hidden).toBe(true);
  });

  it('shows the size and the scale, checks the current size, the last size used here, and Reset once resized', () => {
    const { a, update } = mount(
      viewportState({ current: { width: 1600, height: 1000, scale: 0.8 }, last: { width: 1000, height: 700 } }),
    );
    expect($('toolbar-viewport')!.textContent).toBe('1600×1000 at 80%');
    // The drag handles are the frame host page's, not the toolbar's.
    expect(document.querySelector('[data-testid^="viewport-handle"]')).toBeNull();
    open();
    expect($('viewport-last')!.textContent).toContain('1000×700');
    expect($('viewport-last')!.getAttribute('aria-checked')).toBe('false');
    expect(($('viewport-width') as HTMLInputElement).value).toBe('1600');
    fireEvent.click($('viewport-reset')!);
    expect(a.reset).toHaveBeenCalled();
    update(viewportState({ current: { width: 375, height: 812, scale: 1 } }));
    expect($('toolbar-viewport')!.textContent).toBe('375×812');
    open();
    expect($('viewport-preset-375x812')!.getAttribute('aria-checked')).toBe('true');
  });

  it('on a page that refuses framing, shows the reason instead of sizes', () => {
    mount(viewportState({ blocked: 'This site does not allow being shown in a frame (X-Frame-Options: DENY)' }));
    expect($('toolbar-viewport')!.hidden).toBe(false);
    expect($('toolbar-viewport')!.title).toContain('X-Frame-Options');
    expect($('toolbar-viewport')!.dataset.blocked).toBe('true');
    open();
    expect($('viewport-blocked')!.textContent).toContain('X-Frame-Options: DENY');
    expect($('viewport-preset-375x812')).toBeNull();
  });

  it('says why a size could not be set', async () => {
    const a = actions();
    a.set.mockResolvedValue({ ok: false, error: 'This site does not allow being shown in a frame' });
    const { onError } = mount(viewportState(), a);
    open();
    fireEvent.click($('viewport-preset-768x1024')!);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('This site does not allow being shown in a frame'));
  });

  it('closes when the viewport goes away', () => {
    const { update } = mount(viewportState());
    open();
    update(null);
    expect($('viewport-menu')!.hidden).toBe(true);
    expect($('toolbar-viewport')!.hidden).toBe(true);
  });
});
