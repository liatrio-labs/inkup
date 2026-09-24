import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingToolbar, START_TIMEOUT_MESSAGE, START_TIMEOUT_MS, type ToolbarActions } from '@/content/toolbar';
import { clampPosition, defaultPosition } from '@/content/toolbar-position';
import type { ToolbarState } from '@/messaging';

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

function actions(over: Partial<ToolbarActions> = {}): ToolbarActions {
  const ok = () => Promise.resolve();
  return {
    start: vi.fn(() => Promise.resolve({ ok: false as const, code: 'mic_failed' as const, error: 'no mic' })),
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

describe('FloatingToolbar', () => {
  let container: HTMLElement;
  let toolbar: FloatingToolbar | null = null;
  const $ = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });
  afterEach(() => {
    toolbar?.destroy();
    toolbar = null;
    container.remove();
  });

  it('idle: Start, Panel and Hide; no page tools, the viewport slot hidden; no host dot unpaired', () => {
    toolbar = new FloatingToolbar(container, idle, actions());
    expect($('toolbar')!.dataset.state).toBe('idle');
    expect($('toolbar-start')).not.toBeNull();
    expect($('toolbar-panel')).not.toBeNull();
    expect($('toolbar-close')).not.toBeNull();
    for (const id of ['toolbar-draw', 'toolbar-object-select', 'toolbar-select-text']) expect($(id)).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-slot="viewport"]')!.hidden).toBe(true);
    expect($('toolbar-host')).toBeNull();
  });

  it('Clear all is there idle and recording, and asks to clear the page', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, idle, a);
    expect($('toolbar-clear')!.getAttribute('aria-label')).toBe('Clear all');
    toolbar.update(recording());
    $('toolbar-clear')!.click();
    expect(a.clearAll).toHaveBeenCalledOnce();
  });

  it('the theme button asks for the next setting and shows the current one; setTheme themes the bar, pill and toast', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, recording(), a);
    expect($('toolbar-theme')!.dataset.setting).toBe('auto');
    $('toolbar-theme')!.click();
    expect(a.cycleTheme).toHaveBeenCalled();
    toolbar.setTheme('light', 'setting', 'light');
    expect($('toolbar-theme')!.dataset.setting).toBe('light');
    for (const id of ['toolbar', 'toolbar-pill', 'toolbar-toast']) expect($(id)!.dataset.theme).toBe('light');
    expect($('toolbar')!.dataset.themeFrom).toBe('setting');
  });

  it('a Start that never answers (a worker stuck under load) gives the button back after the timeout, with an error toast (F1)', async () => {
    vi.useFakeTimers();
    try {
      const a = actions({ start: vi.fn(() => new Promise<never>(() => {})) });
      toolbar = new FloatingToolbar(container, idle, a);
      $('toolbar-start')!.click();
      expect(a.start).toHaveBeenCalledOnce();
      expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(true);
      expect($('toolbar-start')!.textContent).toBe('Starting…');
      // A click meanwhile does not start twice.
      $('toolbar-start')!.click();
      expect(a.start).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1);
      expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(false);
      expect($('toolbar-start')!.textContent).toBe('Start');
      expect($('toolbar-toast')!.hidden).toBe(false);
      expect($('toolbar-toast')!.dataset.kind).toBe('error');
      expect($('toolbar-toast')!.textContent).toContain(START_TIMEOUT_MESSAGE);
      // And it can be pressed again.
      $('toolbar-start')!.click();
      expect(a.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Start answering after its timeout changes nothing; one answering in time clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const answers: ((r: { ok: false; code: 'mic_failed'; error: string }) => void)[] = [];
      const a = actions({ start: vi.fn(() => new Promise((r) => answers.push(r))) as ToolbarActions['start'] });
      toolbar = new FloatingToolbar(container, idle, a);
      $('toolbar-start')!.click();
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
      $('toolbar-start')!.click();
      // The first Start's late answer does not end the second one.
      answers[0]!({ ok: false, code: 'mic_failed', error: 'late' });
      await vi.advanceTimersByTimeAsync(0);
      expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(true);
      expect($('toolbar-toast')!.textContent).not.toContain('late');
      answers[1]!({ ok: false, code: 'mic_failed', error: 'no mic' });
      await vi.advanceTimersByTimeAsync(0);
      expect(($('toolbar-start') as HTMLButtonElement).disabled).toBe(false);
      expect($('toolbar-toast')!.textContent).toContain('no mic');
      // No timeout fires later over the answer.
      await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS * 2);
      expect($('toolbar-toast')!.textContent).not.toContain(START_TIMEOUT_MESSAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the host dot only while paired', () => {
    toolbar = new FloatingToolbar(container, { ...idle, host: 'offline' }, actions());
    expect($('toolbar-host')!.dataset.state).toBe('offline');
    expect($('toolbar-host')!.title).toBe('Host offline, will sync');
  });

  it('says when the host is an unencrypted network hub', () => {
    toolbar = new FloatingToolbar(container, { ...idle, host: 'connected', hostNetwork: true }, actions());
    expect($('toolbar-host')!.title).toBe('Host connected · Unencrypted network hub');
    expect($('toolbar-host')!.getAttribute('aria-label')).toBe('Host connected · Unencrypted network hub');
  });

  it('without the microphone grant it offers setup instead of Start', () => {
    const a = actions();
    toolbar = new FloatingToolbar(
      container,
      { ...idle, start: { ok: false, reason: 'Microphone access is needed first.' } },
      a,
    );
    expect($('toolbar-start')).toBeNull();
    $('toolbar-setup')!.click();
    expect(a.open).toHaveBeenCalledWith('setup');
  });

  it('recording: timer, Pause, Draw, Snap, Stop, and no Hide', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, recording(), a);
    expect($('toolbar')!.dataset.state).toBe('recording');
    expect($('toolbar-timer')!.textContent).toBe('01:05');
    expect($('toolbar-close')).toBeNull();
    expect($('toolbar-no-video')).toBeNull();
    $('toolbar-draw')!.click();
    expect(a.setDraw).toHaveBeenCalledWith(true);
    $('toolbar-pause')!.click();
    $('toolbar-snap')!.click();
    $('toolbar-stop')!.click();
    expect(a.pause).toHaveBeenCalled();
    expect(a.snap).toHaveBeenCalled();
    expect(a.stop).toHaveBeenCalled();
  });

  it('orders the page tools before the Session controls: Draw, Object Select, Select Text, Snap, viewport, then Pause, Stop', () => {
    toolbar = new FloatingToolbar(
      container,
      { ...recording(), viewport: { current: null, tab: { width: 1280, height: 720 }, last: null } },
      actions({
        viewport: { set: vi.fn(() => Promise.resolve({ ok: true as const })), reset: vi.fn(() => Promise.resolve()) },
      }),
    );
    const order = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="toolbar"] [data-action], [data-slot="viewport"]'),
    ].map((el) => el.dataset.action ?? 'viewport');
    expect(
      order.filter((a) =>
        ['draw', 'object-select', 'select-text', 'snap', 'viewport', 'pause', 'stop', 'panel'].includes(a),
      ),
    ).toEqual(['draw', 'object-select', 'select-text', 'snap', 'viewport', 'pause', 'stop', 'panel']);
    expect($('toolbar-select-text')!.getAttribute('aria-label')).toBe('Select Text');
    expect($('toolbar-select-text')!.querySelector('svg')).not.toBeNull();
  });

  it('Mute and Cancel sit with the Session controls; Mute shows the pushed state with a struck-through mic (E10)', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, recording(), a);
    const order = [...container.querySelectorAll<HTMLElement>('[data-testid="toolbar"] [data-action]')].map(
      (el) => el.dataset.action,
    );
    expect(order.filter((x) => ['mute', 'pause', 'stop', 'cancel'].includes(x!))).toEqual([
      'mute',
      'pause',
      'stop',
      'cancel',
    ]);
    const mute = $('toolbar-mute')!;
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(mute.querySelectorAll('path')).toHaveLength(2);
    mute.click();
    expect(a.setMuted).toHaveBeenCalledWith(true);
    toolbar.update(recording({ muted: true }));
    expect($('toolbar-mute')!.getAttribute('aria-pressed')).toBe('true');
    expect($('toolbar-mute')!.querySelectorAll('path')).toHaveLength(3);
    expect($('toolbar-mute')!.getAttribute('aria-label')).toBe('Unmute the microphone');
    $('toolbar-cancel')!.click();
    expect(a.cancel).toHaveBeenCalled();
  });

  it('a Session without voice shows "No mic" and "Turn on voice" instead of Mute (E11)', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, recording({ voice: false }), a);
    expect($('toolbar-mute')).toBeNull();
    expect($('toolbar-no-mic')!.textContent).toBe('No mic');
    $('toolbar-voice-on')!.click();
    expect(a.turnOnVoice).toHaveBeenCalled();
    toolbar.update(recording());
    expect($('toolbar-no-mic')).toBeNull();
    expect($('toolbar-mute')).not.toBeNull();
  });

  it('after a Cancel the toast says so with Undo until the deadline (E10)', async () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, { ...idle, discard: { session_id: 's1', deadline: Date.now() + 80 } }, a);
    expect($('toolbar-toast')!.hidden).toBe(false);
    expect($('toolbar-toast')!.textContent).toBe('Session discarded · Undo');
    $('toolbar-undo-discard')!.click();
    expect(a.undoDiscard).toHaveBeenCalledWith('s1');
    await new Promise((r) => setTimeout(r, 150));
    expect($('toolbar-toast')!.hidden).toBe(true);
  });

  it('Object Select and Select Text ask the service worker and show its state; one mode pressed at a time', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, recording(), a);
    const pressed = () =>
      ['draw', 'object-select', 'select-text'].filter(
        (id) => $(`toolbar-${id}`)!.getAttribute('aria-pressed') === 'true',
      );
    expect(pressed()).toEqual([]);
    $('toolbar-object-select')!.click();
    expect(a.setSelect).toHaveBeenLastCalledWith('object');
    toolbar.update(recording({ select_mode: 'object' }));
    expect(pressed()).toEqual(['object-select']);
    $('toolbar-object-select')!.click();
    expect(a.setSelect).toHaveBeenLastCalledWith(null);
    $('toolbar-select-text')!.click();
    expect(a.setSelect).toHaveBeenLastCalledWith('text');
    toolbar.update(recording({ select_mode: 'text' }));
    expect(pressed()).toEqual(['select-text']);
    toolbar.update(recording({ draw_mode: true }));
    expect(pressed()).toEqual(['draw']);
  });

  it('the page tools are off while paused or where no overlay runs', () => {
    toolbar = new FloatingToolbar(container, recording({ paused_t: 1000 }), actions());
    const disabled = () =>
      ['draw', 'object-select', 'select-text'].map((id) => ($(`toolbar-${id}`) as HTMLButtonElement).disabled);
    expect(disabled()).toEqual([true, true, true]);
    toolbar.update(recording({ can_draw: false }));
    expect(disabled()).toEqual([true, true, true]);
    toolbar.update(recording());
    expect(disabled()).toEqual([false, false, false]);
  });

  it('paused: Resume, the timer frozen at the pause, Draw and Snap off', () => {
    const t0 = Date.now() - 100_000;
    toolbar = new FloatingToolbar(container, recording({ t0, paused_t: 30_000, paused_ms: 0 }), actions());
    expect($('toolbar')!.dataset.state).toBe('paused');
    expect($('toolbar-resume')).not.toBeNull();
    expect($('toolbar-timer')!.textContent).toBe('00:30');
    expect(($('toolbar-draw') as HTMLButtonElement).disabled).toBe(true);
    expect(($('toolbar-snap') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the Session has no video', () => {
    toolbar = new FloatingToolbar(container, recording({ video: 'off' }), actions());
    expect($('toolbar-no-video')!.textContent).toBe('No video');
  });

  it('starting: "Starting…" until the page has the Session, every control off (F1)', () => {
    toolbar = new FloatingToolbar(container, recording({ starting: true }), actions());
    expect($('toolbar')!.dataset.state).toBe('starting');
    expect($('toolbar-starting')!.textContent).toBe('Starting…');
    expect($('toolbar-timer')).toBeNull();
    for (const id of [
      'toolbar-draw',
      'toolbar-object-select',
      'toolbar-snap',
      'toolbar-pause',
      'toolbar-stop',
      'toolbar-cancel',
    ])
      expect($(id)!.hasAttribute('disabled')).toBe(true);
    toolbar.update(recording());
    expect($('toolbar')!.dataset.state).toBe('recording');
    expect($('toolbar-timer')).not.toBeNull();
    expect($('toolbar-draw')!.hasAttribute('disabled')).toBe(false);
  });

  it('a click is not lost to a re-render between press and release: the buttons are patched in place (#16)', () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, idle, a);
    const start = $('toolbar-start')!;
    const clear = $('toolbar-clear')!;
    // A state push while the button is held down (the host dot appears, a notice comes and goes).
    toolbar.update({ ...idle, host: 'connected' });
    toolbar.update({ ...idle, notice: 'x' });
    toolbar.update(idle);
    expect($('toolbar-start')).toBe(start);
    expect($('toolbar-clear')).toBe(clear);
    expect(start.isConnected).toBe(true);
    toolbar.update(recording());
    const draw = $('toolbar-draw')!;
    toolbar.update(recording({ draw_mode: true }));
    expect($('toolbar-draw')).toBe(draw);
    expect(draw.getAttribute('aria-pressed')).toBe('true');
    // Order and contents still follow the state.
    const order = [...container.querySelectorAll('[data-testid="toolbar"] button')].map((b) =>
      b.getAttribute('data-action'),
    );
    expect(order.indexOf('draw')).toBeLessThan(order.indexOf('stop'));
    expect(order).not.toContain('start');
  });

  it('a Session on another tab offers only Stop', () => {
    toolbar = new FloatingToolbar(container, recording({ here: false }), actions());
    expect($('toolbar')!.dataset.state).toBe('elsewhere');
    expect($('toolbar-stop')).not.toBeNull();
    expect($('toolbar-draw')).toBeNull();
  });

  it('shows a failed Start in the toast strip, and the latest caption otherwise', async () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, idle, a);
    $('toolbar-start')!.click();
    await vi.waitFor(() => expect($('toolbar-toast')!.textContent).toBe('no mic'));
    toolbar.update({
      ...recording(),
      toast: { id: 'e1', kind: 'caption', text: 'this button should go in the header' },
    });
    expect($('toolbar-toast')!.hidden).toBe(false);
    expect($('toolbar-toast')!.textContent).toBe('this button should go in the header');
  });

  it('collapses to a pill and saves that', async () => {
    const a = actions();
    toolbar = new FloatingToolbar(container, recording(), a);
    $('toolbar-collapse')!.click();
    expect($('toolbar')!.hidden).toBe(true);
    expect($('toolbar-pill')!.hidden).toBe(false);
    expect(a.savePosition).toHaveBeenCalledWith(expect.objectContaining({ collapsed: true }));
    $('toolbar-pill')!.click();
    expect($('toolbar')!.hidden).toBe(false);
  });

  it('hides for a capture and comes back', async () => {
    toolbar = new FloatingToolbar(container, recording(), actions());
    await toolbar.hideForCapture(true);
    expect($('toolbar')!.style.visibility).toBe('hidden');
    expect(container.hasAttribute('data-capturing')).toBe(true);
    await toolbar.hideForCapture(false);
    expect($('toolbar')!.style.visibility).toBe('');
  });

  it('keeps the Start frame in the document once a Session starts (it records the video)', () => {
    toolbar = new FloatingToolbar(
      container,
      { ...idle, start: { ok: true, video: 'frame_picker' } },
      actions({ frameUrl: 'about:blank' }),
    );
    const frame = $('toolbar-start-frame') as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect($('toolbar-start')).toBeNull();
    toolbar.update({ ...recording(), start: { ok: true, video: 'frame_picker' } });
    expect(frame.isConnected).toBe(true);
    expect(frame.classList.contains('var-parked')).toBe(true);
  });
});
