// The microphone picker against the ToolbarMic the service worker pushes, inside the Toolbar as the extension renders
// it: split from Mute during a Session and beside Start before one, "System default" and each input with the one in
// use checked, the inputs listed when the menu opens before a Session, a state that says the microphone is not
// allowed yet, keyboard operation, and the theme. It only asks (MicActions) and shows.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicPicker, Toolbar } from '../src/toolbar';
import type { MicActions, ToolbarActions, ToolbarMic, ToolbarState } from '../src/toolbar-state';

const DEVICES = [
  { id: 'usb', label: 'USB Microphone' },
  { id: 'headset', label: 'Headset' },
];

const idle = (mic: ToolbarMic | null): ToolbarState => ({
  session: null,
  start: { ok: true, video: 'tab_capture' },
  host: null,
  hostNetwork: false,
  toast: null,
  notice: null,
  viewport: null,
  discard: null,
  mic,
});
const recording = (mic: ToolbarMic | null, over: Partial<NonNullable<ToolbarState['session']>> = {}): ToolbarState => ({
  ...idle(mic),
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
    ...over,
  },
});

function micActions(list: MicActions['list'] = () => Promise.resolve(DEVICES)) {
  return {
    set: vi.fn<MicActions['set']>((id) => Promise.resolve({ ok: true as const, selected: id })),
    list: vi.fn<MicActions['list']>(list),
  };
}

function toolbarActions(mic?: MicActions): ToolbarActions {
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
    ...(mic ? { mic } : {}),
  };
}

const $ = (id: string) => screen.queryByTestId(id);
const picker = () => screen.getByRole('button', { name: /^Choose the microphone/ });
const menu = () => screen.getByRole('menu', { name: 'Microphone' });
const order = () =>
  [...document.querySelectorAll('[data-testid^="toolbar-"]')].map((e) => e.getAttribute('data-testid'));

afterEach(cleanup);

describe('MicPicker in the toolbar', () => {
  it('sits right after Mute during a Session, lists the inputs pushed, and switches to the one picked', async () => {
    const a = micActions();
    render(
      <Toolbar state={recording({ granted: true, devices: DEVICES, selected: 'usb' })} actions={toolbarActions(a)} />,
    );
    const ids = order();
    expect(ids.indexOf('toolbar-mic-picker')).toBe(ids.indexOf('toolbar-mute') + 1);
    expect(picker().getAttribute('aria-haspopup')).toBe('menu');
    expect(picker().getAttribute('aria-expanded')).toBe('false');
    expect(picker().title).toBe('Microphone: USB Microphone');
    // Styled as a toolbar button, but narrow: the button's own padding would squeeze the chevron to nothing.
    expect(picker().className).toMatch(/\bpx-0\b/);
    expect(picker().className).not.toMatch(/\bpx-2\b/);

    fireEvent.click(picker());
    expect(picker().getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['System default', 'USB Microphone', 'Headset']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    // Pushed: nothing to list.
    expect(a.list).not.toHaveBeenCalled();
    // The keyboard is on the input in use.
    expect(document.activeElement).toBe(items[1]);

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Headset' }));
    expect(a.set).toHaveBeenCalledWith('headset');
    expect($('mic-menu')!.hidden).toBe(true);
    expect(document.activeElement).toBe(picker());
  });

  it('sits beside Start before a Session, and lists the inputs when the menu opens', async () => {
    let answer!: (d: typeof DEVICES) => void;
    const a = micActions(() => new Promise((r) => (answer = r)));
    render(<Toolbar state={idle({ granted: true, devices: null, selected: null })} actions={toolbarActions(a)} />);
    const ids = order();
    expect(ids.indexOf('toolbar-mic-picker')).toBe(ids.indexOf('toolbar-start') + 1);

    fireEvent.click(picker());
    expect(a.list).toHaveBeenCalledOnce();
    expect($('mic-listing')!.textContent).toBe('Looking for microphones…');
    await act(async () => answer(DEVICES));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['System default', 'USB Microphone', 'Headset']);
    expect(screen.getByRole('menuitemradio', { name: 'System default' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    // Before a Session a pick is only remembered: the same request, the worker decides.
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'USB Microphone' }));
    expect(a.set).toHaveBeenCalledWith('usb');
  });

  it('says the microphone is not allowed yet, and offers setup instead of a list', () => {
    const a = micActions();
    const t = toolbarActions(a);
    render(<Toolbar state={idle({ granted: false, devices: null, selected: null })} actions={t} />);
    expect(picker().getAttribute('aria-label')).toBe('Choose the microphone (not allowed yet)');
    expect(picker().dataset.granted).toBe('false');
    fireEvent.click(picker());
    expect($('mic-not-granted')!.textContent).toContain('not allowed yet');
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(a.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finish setup' }));
    expect(t.open).toHaveBeenCalledWith('setup');
  });

  it('is hidden with nothing pushed, without the actions, and in a Session without voice', () => {
    const { rerender } = render(<Toolbar state={recording(null)} actions={toolbarActions(micActions())} />);
    expect($('toolbar-mic-picker')!.hidden).toBe(true);
    rerender(
      <Toolbar state={recording({ granted: true, devices: DEVICES, selected: null })} actions={toolbarActions()} />,
    );
    expect($('toolbar-mic-picker')).toBeNull();
    rerender(
      <Toolbar
        state={recording({ granted: true, devices: DEVICES, selected: null }, { voice: false })}
        actions={toolbarActions(micActions())}
      />,
    );
    expect($('toolbar-mic-picker')).toBeNull();
    expect($('toolbar-no-mic')).not.toBeNull();
  });

  it('is disabled while the Session stops', () => {
    render(
      <Toolbar
        state={recording({ granted: true, devices: DEVICES, selected: null }, { stopping: true })}
        actions={toolbarActions(micActions())}
      />,
    );
    expect((picker() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('MicPicker', () => {
  const mount = (mic: ToolbarMic | null, a = micActions(), onError = vi.fn()) => {
    render(<MicPicker mic={mic} actions={a} onError={onError} onSetup={vi.fn()} theme="dark" />);
    return { a, onError };
  };

  it('moves through the inputs with the arrow keys, Home and End, and closes on Escape', () => {
    mount({ granted: true, devices: DEVICES, selected: null });
    fireEvent.click(picker());
    const items = screen.getAllByRole('menuitemradio');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'Escape' });
    expect($('mic-menu')!.hidden).toBe(true);
    expect(document.activeElement).toBe(picker());
  });

  it('wears the toolbar theme', () => {
    mount({ granted: true, devices: DEVICES, selected: null });
    fireEvent.click(picker());
    expect(menu().dataset.theme).toBe('dark');
  });

  it('shows the default checked, and says so, when the input chosen is not connected', () => {
    mount({ granted: true, devices: DEVICES, selected: 'unplugged' });
    fireEvent.click(picker());
    expect(screen.getByRole('menuitemradio', { name: 'System default' }).getAttribute('aria-checked')).toBe('true');
    expect($('mic-missing')!.textContent).toContain('not connected');
  });

  it('clears a remembered input that is not connected when System default is picked, and asks nothing for a no-op', () => {
    const { a } = mount({ granted: true, devices: DEVICES, selected: 'unplugged' });
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'System default' }));
    expect(a.set).toHaveBeenCalledWith(null);
    cleanup();
    const again = mount({ granted: true, devices: DEVICES, selected: 'usb' });
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'USB Microphone' }));
    expect(again.a.set).not.toHaveBeenCalled();
  });

  it('says why a switch failed', async () => {
    const a = micActions();
    a.set.mockResolvedValue({ ok: false, error: 'The microphone did not switch: NotReadableError' });
    const { onError } = mount({ granted: true, devices: DEVICES, selected: null }, a);
    fireEvent.click(picker());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Headset' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The microphone did not switch: NotReadableError'));
  });

  it('says when the inputs could not be listed', async () => {
    mount(
      { granted: true, devices: null, selected: null },
      micActions(() => Promise.resolve(null)),
    );
    fireEvent.click(picker());
    await waitFor(() => expect($('mic-unlisted')).not.toBeNull());
    expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['System default']);
  });
});
