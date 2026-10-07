// The toolbar against the ToolbarStates the service worker pushes (recording, paused, starting, voice-less, discard
// pending, viewport present and absent, idle, elsewhere): the accessible names, roles and aria-pressed states the e2e
// suites locate it by, in document order, and the behaviours of its own (Start's timeout, the Start frame, the pill,
// the grip, the keep-alive, hiding for a capture). Rendered through React Testing Library, as the extension renders it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toolbar, type ToolbarHandle } from '../src/toolbar';
import {
  FRAME_READY,
  FRAME_THEME,
  START_TIMEOUT_MESSAGE,
  START_TIMEOUT_MS,
  type ToolbarActions,
  type ToolbarState,
  type ToolbarViewport,
} from '../src/toolbar-state';

const idle: ToolbarState = {
  session: null,
  start: { ok: true, video: 'tab_capture' },
  host: null,
  hostNetwork: false,
  toast: null,
  notice: null,
  viewport: null,
  discard: null,
};
const recording = (over: Partial<NonNullable<ToolbarState['session']>> = {}): ToolbarState => ({
  ...idle,
  session: {
    t0: Date.now() - 65_000,
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
const viewport: ToolbarViewport = { current: null, tab: { width: 1280, height: 720 }, last: null };

function actions(over: Partial<ToolbarActions> = {}): ToolbarActions {
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
    viewport: { set: vi.fn(() => Promise.resolve({ ok: true as const })), reset: vi.fn(ok) },
    moved: vi.fn(),
    ...over,
  };
}

function mount(state: ToolbarState, a: ToolbarActions = actions()) {
  const ref = createRef<ToolbarHandle>();
  const r = render(<Toolbar ref={ref} state={state} actions={a} />);
  return {
    a,
    handle: () => ref.current!,
    update: (next: ToolbarState) => r.rerender(<Toolbar ref={ref} state={next} actions={a} />),
  };
}

const $ = (id: string) => screen.queryByTestId(id);
const bar = () => screen.getByRole('toolbar', { name: 'InkUp' });
/** The accessible names of the bar's visible buttons, in document order. */
const buttonNames = () =>
  within(bar())
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent);
const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toolbar: the controls each state renders', () => {
  it('recording: the timer with its dot, the page tools, the Session controls, Clear all, Panel, theme and collapse', () => {
    mount(recording());
    expect(bar().dataset.state).toBe('recording');
    expect(screen.getByLabelText('Elapsed time').textContent).toBe('01:05');
    expect($('toolbar-dot')!.title).toBe('Recording');
    expect(buttonNames()).toEqual([
      'Draw',
      'Object Select',
      'Select Text',
      'Snap',
      'Mute the microphone',
      'Pause',
      'Stop',
      'Cancel',
      'Clear all',
      'Panel',
      'Theme: Auto (follows the page)',
      'Collapse the toolbar',
    ]);
    for (const name of ['Draw', 'Object Select', 'Select Text', 'Mute the microphone'])
      expect(pressed(name)).toBe('false');
    // No Hide while recording, no host dot unpaired, no "No video" while the video records.
    expect(screen.queryByRole('button', { name: 'Hide the toolbar' })).toBeNull();
    expect($('toolbar-host')).toBeNull();
    expect($('toolbar-no-video')).toBeNull();
  });

  it('paused: Resume in place of Pause, the timer frozen at the pause, the page tools and Snap off', () => {
    const t0 = Date.now() - 100_000;
    mount(recording({ t0, paused_t: 30_000, paused_ms: 0 }));
    expect(bar().dataset.state).toBe('paused');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.getByLabelText('Elapsed time').textContent).toBe('00:30');
    for (const name of ['Draw', 'Object Select', 'Select Text', 'Snap'])
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(buttonNames()).toEqual([
      'Draw',
      'Object Select',
      'Select Text',
      'Snap',
      'Mute the microphone',
      'Resume',
      'Stop',
      'Cancel',
      'Clear all',
      'Panel',
      'Theme: Auto (follows the page)',
      'Collapse the toolbar',
    ]);
  });

  it('starting: "Starting…" until the page has the Session, every control off (F1)', () => {
    const { update } = mount(recording({ starting: true }));
    expect(bar().dataset.state).toBe('starting');
    expect(within(bar()).getByText('Starting…')).toBe($('toolbar-starting'));
    expect(screen.queryByLabelText('Elapsed time')).toBeNull();
    for (const name of ['Draw', 'Object Select', 'Snap', 'Mute the microphone', 'Pause', 'Stop', 'Cancel'])
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    update(recording());
    expect(bar().dataset.state).toBe('recording');
    expect(screen.getByLabelText('Elapsed time')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Draw' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('voice-less (E11): "No mic" and "Turn on voice" where Mute would be', () => {
    const { a, update } = mount(recording({ voice: false }));
    expect(screen.queryByRole('button', { name: 'Mute the microphone' })).toBeNull();
    expect($('toolbar-no-mic')!.textContent).toBe('No mic');
    expect(buttonNames()).toEqual([
      'Draw',
      'Object Select',
      'Select Text',
      'Snap',
      'Turn on voice',
      'Pause',
      'Stop',
      'Cancel',
      'Clear all',
      'Panel',
      'Theme: Auto (follows the page)',
      'Collapse the toolbar',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on voice' }));
    expect(a.turnOnVoice).toHaveBeenCalled();
    update(recording());
    expect($('toolbar-no-mic')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mute the microphone' })).toBeTruthy();
  });

  it('discard pending (E10): the toast says "Session discarded" with Undo until the deadline', async () => {
    const { a } = mount({ ...idle, discard: { session_id: 's1', deadline: Date.now() + 80 } });
    const toast = screen.getByRole('status');
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe('Session discarded · Undo');
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    expect(a.undoDiscard).toHaveBeenCalledWith('s1');
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect($('toolbar-toast')!.hidden).toBe(true);
  });

  it('the toast strip shows the latest caption, and a Draft Item as a draft', () => {
    const { update } = mount({
      ...recording(),
      toast: { id: 'e1', kind: 'caption', text: 'this button should go in the header' },
    });
    expect(screen.getByRole('status').textContent).toBe('this button should go in the header');
    update({ ...recording(), toast: { id: 'd1', kind: 'draft', text: 'Make the header sticky' } });
    expect(screen.getByRole('status').dataset.kind).toBe('draft');
    expect(screen.getByRole('status').textContent).toBe('Make the header sticky');
  });

  it('a notice shows in the toast strip as an error', () => {
    mount({ ...recording(), notice: 'The microphone stopped.' });
    expect(screen.getByRole('status').dataset.kind).toBe('error');
    expect(screen.getByRole('status').textContent).toBe('The microphone stopped.');
  });

  it('viewport present: the control sits with the page tools, between Snap and the Session controls', () => {
    mount({ ...recording(), viewport });
    const names = buttonNames();
    expect(names.slice(0, 6)).toEqual([
      'Draw',
      'Object Select',
      'Select Text',
      'Snap',
      'Viewport',
      'Mute the microphone',
    ]);
    expect(screen.getByRole('button', { name: 'Viewport' }).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('viewport absent: no viewport button, presets, size fields or current size; the rest as recording', () => {
    mount(recording());
    expect(screen.queryByRole('button', { name: 'Viewport' })).toBeNull();
    expect($('toolbar-viewport')!.hidden).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect($('viewport-width')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-slot="viewport"]')!.hidden).toBe(true);
  });

  it('idle: Start, Clear all, Panel, theme, collapse and Hide; no page tools; the viewport last when there is one', () => {
    mount({ ...idle, viewport });
    expect(bar().dataset.state).toBe('idle');
    expect(buttonNames()).toEqual([
      'Start',
      'Viewport',
      'Clear all',
      'Panel',
      'Theme: Auto (follows the page)',
      'Collapse the toolbar',
      'Hide the toolbar',
    ]);
  });

  it('a Session on another tab offers only Stop', () => {
    mount(recording({ here: false }));
    expect(bar().dataset.state).toBe('elsewhere');
    expect(screen.getByText('Recording another tab')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Draw' })).toBeNull();
  });

  it('says when the Session has no video, or its video ended', () => {
    const { update } = mount(recording({ video: 'off' }));
    expect($('toolbar-no-video')!.textContent).toBe('No video');
    update(recording({ video: 'ended' }));
    expect($('toolbar-no-video')!.textContent).toBe('Video ended');
  });

  it('shows the host dot only while paired, and says when the host is an unencrypted network hub', () => {
    const { update } = mount({ ...idle, host: 'offline' });
    expect(screen.getByRole('img', { name: 'Host offline, will sync' }).dataset.state).toBe('offline');
    update({ ...idle, host: 'connected', hostNetwork: true });
    expect(screen.getByRole('img', { name: 'Host connected · Unencrypted network hub' }).title).toBe(
      'Host connected · Unencrypted network hub',
    );
  });

  it('without the microphone grant it offers setup instead of Start', () => {
    const { a } = mount({ ...idle, start: { ok: false, reason: 'Microphone access is needed first.' } });
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.getByText('Microphone access is needed first.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(a.open).toHaveBeenCalledWith('setup');
  });
});

describe('Toolbar: what the buttons ask', () => {
  it('mode buttons ask and show the pushed state through aria-pressed, one mode at a time', () => {
    const { a, update } = mount(recording());
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(a.setDraw).toHaveBeenCalledWith(true);
    update(recording({ draw_mode: true }));
    expect([pressed('Draw'), pressed('Object Select'), pressed('Select Text')]).toEqual(['true', 'false', 'false']);
    fireEvent.click(screen.getByRole('button', { name: 'Object Select' }));
    expect(a.setSelect).toHaveBeenLastCalledWith('object');
    update(recording({ select_mode: 'object' }));
    expect([pressed('Draw'), pressed('Object Select'), pressed('Select Text')]).toEqual(['false', 'true', 'false']);
    fireEvent.click(screen.getByRole('button', { name: 'Object Select' }));
    expect(a.setSelect).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button', { name: 'Select Text' }));
    expect(a.setSelect).toHaveBeenLastCalledWith('text');
    update(recording({ select_mode: 'text' }));
    expect([pressed('Draw'), pressed('Object Select'), pressed('Select Text')]).toEqual(['false', 'false', 'true']);
  });

  it('the page tools are off where no overlay runs', () => {
    const { update } = mount(recording({ can_draw: false }));
    const disabled = () =>
      ['Draw', 'Object Select', 'Select Text'].map(
        (name) => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled,
      );
    expect(disabled()).toEqual([true, true, true]);
    update(recording());
    expect(disabled()).toEqual([false, false, false]);
  });

  it('Mute shows the pushed state with a struck-through mic; Pause, Snap, Stop and Cancel ask the worker (E10)', () => {
    const { a, update } = mount(recording());
    const mute = screen.getByRole('button', { name: 'Mute the microphone' });
    expect(mute.querySelectorAll('path')).toHaveLength(2);
    fireEvent.click(mute);
    expect(a.setMuted).toHaveBeenCalledWith(true);
    update(recording({ muted: true }));
    const unmute = screen.getByRole('button', { name: 'Unmute the microphone' });
    expect(unmute).toBe(mute);
    expect(unmute.getAttribute('aria-pressed')).toBe('true');
    expect(unmute.querySelectorAll('path')).toHaveLength(3);
    for (const [name, fn] of [
      ['Pause', a.pause],
      ['Snap', a.snap],
      ['Stop', a.stop],
      ['Cancel', a.cancel],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(fn).toHaveBeenCalled();
    }
  });

  it('Clear all, Panel, the theme button and Hide', () => {
    const { a, update } = mount(idle);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(a.clearAll).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Panel' }));
    expect(a.open).toHaveBeenCalledWith('panel');
    fireEvent.click(screen.getByRole('button', { name: 'Theme: Auto (follows the page)' }));
    expect(a.cycleTheme).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the toolbar' }));
    expect(a.hide).toHaveBeenCalled();
    update(recording());
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(a.clearAll).toHaveBeenCalledTimes(2);
  });

  it('a click is not lost to a re-render: every control is updated in place, not replaced (ADR 0011, #16)', () => {
    const { update } = mount(idle);
    const start = $('toolbar-start')!;
    const clear = $('toolbar-clear')!;
    update({ ...idle, host: 'connected' });
    update({ ...idle, notice: 'x' });
    update(idle);
    expect($('toolbar-start')).toBe(start);
    expect($('toolbar-clear')).toBe(clear);
    expect(start.isConnected).toBe(true);
    update(recording());
    const draw = $('toolbar-draw')!;
    const stop = $('toolbar-stop')!;
    update({ ...recording({ draw_mode: true }), host: 'connected', toast: { id: 'c', kind: 'caption', text: 'hi' } });
    expect($('toolbar-draw')).toBe(draw);
    expect($('toolbar-stop')).toBe(stop);
    expect($('toolbar-clear')).toBe(clear);
    expect(draw.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Toolbar: Start', () => {
  it('a Start that never answers gives the button back after the timeout, with an error toast (F1)', async () => {
    vi.useFakeTimers();
    const a = actions({ start: vi.fn(() => new Promise<never>(() => {})) });
    mount(idle, a);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(a.start).toHaveBeenCalledOnce();
    const button = $('toolbar-start') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Starting…');
    fireEvent.click(button);
    expect(a.start).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1));
    expect(button.disabled).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Start');
    const toast = $('toolbar-toast')!;
    expect(toast.hidden).toBe(false);
    expect(toast.dataset.kind).toBe('error');
    expect(toast.textContent).toContain(START_TIMEOUT_MESSAGE);
    fireEvent.click(button);
    expect(a.start).toHaveBeenCalledTimes(2);
  });

  it('a Start answering after its timeout changes nothing; one answering in time clears the timer', async () => {
    vi.useFakeTimers();
    const answers: ((r: { ok: false; error: string }) => void)[] = [];
    const a = actions({ start: vi.fn(() => new Promise((r) => answers.push(r))) as ToolbarActions['start'] });
    mount(idle, a);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(() => vi.advanceTimersByTimeAsync(START_TIMEOUT_MS));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {
      answers[0]!({ ok: false, error: 'late' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(true);
    expect($('toolbar-toast')!.textContent).not.toContain('late');
    await act(async () => {
      answers[1]!({ ok: false, error: 'no mic' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(false);
    expect($('toolbar-toast')!.textContent).toContain('no mic');
    await act(() => vi.advanceTimersByTimeAsync(START_TIMEOUT_MS * 2));
    expect($('toolbar-toast')!.textContent).not.toContain(START_TIMEOUT_MESSAGE);
  });

  it('a failed Start shows in the toast strip until the Session arrives, then its caption', async () => {
    const { update } = mount(idle);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await vi.waitFor(() => expect($('toolbar-toast')!.textContent).toBe('no mic'));
    update({ ...recording(), toast: { id: 'e1', kind: 'caption', text: 'this button should go in the header' } });
    expect($('toolbar-toast')!.textContent).toBe('this button should go in the header');
  });

  it('Firefox: the Start frame takes the place of Start and stays in the document once a Session starts', () => {
    const { update } = mount(
      { ...idle, start: { ok: true, video: 'frame_picker' } },
      actions({ frameUrl: 'about:blank' }),
    );
    const frame = $('toolbar-start-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('about:blank');
    expect(frame.title).toBe('Start a review Session');
    expect($('toolbar-start')).toBeNull();
    update({ ...recording(), start: { ok: true, video: 'frame_picker' } });
    expect($('toolbar-start-frame')).toBe(frame);
    expect(frame.isConnected).toBe(true);
    expect(frame.hasAttribute('data-parked')).toBe(true);
  });

  it("Firefox: the Start frame is told the bar's theme when it is ready and again on each change", () => {
    const origin = 'null'; // about:blank's, so nothing is fetched
    const { handle } = mount(
      { ...idle, start: { ok: true, video: 'frame_picker' } },
      actions({ frameUrl: 'about:blank' }),
    );
    const frame = $('toolbar-start-frame') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const theme = (t: string | undefined) => [{ type: FRAME_THEME, theme: t }, origin];
    // Ready brings the current theme (a frame that reloads says ready again), whenever the theme was set.
    act(() => handle().setTheme('dark', 'style', 'auto'));
    post.mockClear();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: FRAME_READY }, origin }));
    });
    expect(post.mock.calls).toEqual([theme('dark')]);
    post.mockClear();
    act(() => handle().setTheme('light', 'setting', 'light'));
    expect(post.mock.calls).toEqual([theme('light')]);
    // Nothing else reposts: the same theme again, or a state change.
    post.mockClear();
    act(() => handle().setTheme('light', 'setting', 'light'));
    expect(post).not.toHaveBeenCalled();
  });

  it('Firefox: a frame that never says it is ready (the page refused it) falls back to a Start button', async () => {
    vi.useFakeTimers();
    mount({ ...idle, start: { ok: true, video: 'frame_picker' } }, actions({ frameUrl: 'about:blank' }));
    expect($('toolbar-start')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect($('toolbar-start-frame')).toBeNull();
    expect($('toolbar-start')).not.toBeNull();
  });
});

describe('Toolbar: its own behaviours', () => {
  it('collapses to a pill with the elapsed time and saves that; the pill expands it again', () => {
    const { a } = mount(recording());
    fireEvent.click(screen.getByRole('button', { name: 'Collapse the toolbar' }));
    expect($('toolbar')!.hidden).toBe(true);
    const pill = screen.getByRole('button', { name: 'Expand the review toolbar' });
    expect(pill.textContent).toBe('01:05');
    expect(a.savePosition).toHaveBeenCalledWith(expect.objectContaining({ collapsed: true }));
    expect(a.moved).toHaveBeenCalled();
    fireEvent.click(pill);
    expect(bar().hidden).toBe(false);
    expect(a.savePosition).toHaveBeenLastCalledWith(expect.objectContaining({ collapsed: false }));
  });

  it('opens collapsed where the saved position says so', async () => {
    mount(recording(), actions({ loadPosition: vi.fn(() => Promise.resolve({ x: 40, y: 50, collapsed: true })) }));
    await vi.waitFor(() => expect($('toolbar')!.hidden).toBe(true));
    expect($('toolbar-pill')!.hidden).toBe(false);
  });

  it('drags by the grip only, clamped to the viewport, and saves where the drag ended', () => {
    const { a } = mount(recording());
    const tb = bar();
    fireEvent.pointerDown(tb, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(tb, { pointerId: 1 });
    expect(a.savePosition).not.toHaveBeenCalled();
    const grip = $('toolbar-grip')!;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tb, { pointerId: 2, clientX: 5000, clientY: -300 });
    fireEvent.pointerUp(tb, { pointerId: 2 });
    const saved = vi.mocked(a.savePosition).mock.calls.at(-1)![0];
    expect(saved.collapsed).toBe(false);
    expect(saved.y).toBe(8);
    expect(saved.x).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(a.moved).toHaveBeenCalled();
  });

  it('keeps the worker awake with a ping every 20 s while recording here, and stops when it ends', async () => {
    vi.useFakeTimers();
    const { a, update } = mount(recording());
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(a.ping).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(a.ping).toHaveBeenCalledTimes(2);
    update(idle);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(a.ping).toHaveBeenCalledTimes(2);
  });

  it('the timer ticks while recording', async () => {
    vi.useFakeTimers();
    mount(recording());
    expect(screen.getByLabelText('Elapsed time').textContent).toBe('01:05');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByLabelText('Elapsed time').textContent).toBe('01:07');
  });

  it('hides for a capture through its handle (bar, pill and toast) and comes back', async () => {
    const { handle } = mount({ ...recording(), toast: { id: 'c', kind: 'caption', text: 'hi' } });
    await act(() => handle().hideForCapture(true));
    for (const id of ['toolbar', 'toolbar-pill', 'toolbar-toast']) expect($(id)!.style.visibility).toBe('hidden');
    await act(() => handle().hideForCapture(false));
    for (const id of ['toolbar', 'toolbar-pill', 'toolbar-toast']) expect($(id)!.style.visibility).toBe('');
  });

  it('takes the theme it is given on the bar, pill and toast, and shows the setting on the theme button', () => {
    const { handle } = mount(recording());
    expect($('toolbar-theme')!.dataset.setting).toBe('auto');
    act(() => handle().setTheme('light', 'setting', 'light'));
    expect($('toolbar-theme')!.dataset.setting).toBe('light');
    expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeTruthy();
    for (const id of ['toolbar', 'toolbar-pill', 'toolbar-toast']) expect($(id)!.dataset.theme).toBe('light');
    expect($('toolbar')!.dataset.themeFrom).toBe('setting');
    act(() => handle().setTheme('dark', 'style', 'auto'));
    expect($('toolbar')!.dataset.theme).toBe('dark');
    expect($('toolbar')!.dataset.themeFrom).toBe('style');
  });

  it('reports its rect (the pill while collapsed) and whether the Start frame records', () => {
    const { handle } = mount(recording());
    expect(handle().rect()).not.toBeNull();
    expect(handle().holdsRecordingFrame()).toBe(false);
  });
});
