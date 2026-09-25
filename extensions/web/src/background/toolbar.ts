// The page's floating toolbar (CONTEXT.md Toolbar; plan E1), from the service worker's side. The toolbar is the
// main control surface on every browser; the panel is optional. This module decides which tabs show it, builds the
// state it renders (ToolbarState) and pushes it on every change, and starts Sessions for it and for the shortcut.
//
// A Session started here belongs to no page (ADR 0004): closing the panel does not stop it, and a page navigating
// away only remounts the toolbar. Video comes from Platform.capabilities().toolbarVideo (docs/spikes/toolbar-start.md):
// Chrome records the tab with tabCapture in the media context, and where Chrome refuses it opens the picker window
// (./picker.ts); Firefox's toolbar Start is an extension frame that opens the picker itself and calls startSession;
// elsewhere the Session has no video.
import type { TimelineEvent } from '@inkup/core/timeline';
import { isLoopbackUrl } from '@/adapters/host';
import { coalesced } from '@/lib/coalesced';
import { type StartResult, sendMessage, type ToolbarState } from '@/messaging';
import { platform } from '@/platform';
import { activeSession, hostStatus, panelNotice, tabViewports, toolbarTabs } from '@/session-state';
import { type ActiveSession, discardPending, hostPairing, viewportSizes } from '@/settings';
import { onEventAppended } from './event-log';
import { openPicker } from './picker';
import { getActive, startSession, stopSession } from './session';
import { modeOf } from './target-tab';
import { toolbarViewport } from './viewport';

/** The toast strip's latest line, per Session. In memory: a restarted worker shows the next one. */
let toast: { session_id: string; toast: NonNullable<ToolbarState['toast']> } | null = null;
/** Tabs sent a state, so a tab that stops showing the toolbar is told to hide it. */
const pushedTo = new Set<number>();

export async function stateFor(tabId: number, s: ActiveSession | null = null): Promise<ToolbarState> {
  const [active, pairing, status, notice, viewport, discards] = await Promise.all([
    s ? s : getActive(),
    hostPairing.getValue(),
    hostStatus.getValue(),
    panelNotice.getValue(),
    toolbarViewport(tabId).catch(() => null),
    discardPending.getValue(),
  ]);
  // A cancelled Session is over for the toolbar at once, while its Stop still finishes behind the Undo toast (E10).
  const now = Date.now();
  const discard = discards.filter((p) => p.deadline > now).at(-1) ?? null;
  const session = active && !discards.some((p) => p.session_id === active.id) ? active : null;
  return {
    session: session
      ? {
          t0: session.t0,
          paused_ms: session.paused_ms ?? 0,
          paused_t: session.paused?.t ?? null,
          starting: !!session.starting,
          stopping: session.stopping,
          draw_mode: session.draw_mode,
          select_mode: session.select_mode ?? null,
          can_draw: session.mode !== 'no_overlay',
          here: session.tab_id === tabId,
          video: session.video.state,
          muted: !!session.muted,
          voice: session.voice !== false,
        }
      : null,
    discard: discard ? { session_id: discard.session_id, deadline: discard.deadline } : null,
    // Without the microphone grant a Session starts without voice (E11).
    start: { ok: true, video: platform.capabilities().toolbarVideo },
    host: pairing ? (status.state === 'connected' ? 'connected' : 'offline') : null,
    hostNetwork: !!pairing && !isLoopbackUrl(pairing.url),
    toast: session && toast?.session_id === session.id ? toast.toast : null,
    notice,
    viewport,
  };
}

async function shownIn(tabId: number | undefined): Promise<boolean> {
  return tabId !== undefined && (await toolbarTabs.getValue()).includes(tabId);
}

/** The toolbar's state for the tab asking, or null where it is not shown. */
export async function toolbarHello(tabId: number | undefined): Promise<ToolbarState | null> {
  return tabId !== undefined && (await shownIn(tabId)) ? stateFor(tabId) : null;
}

async function send(tabId: number, state: ToolbarState | null): Promise<boolean> {
  try {
    await sendMessage('toolbarState', state, tabId);
    return true;
  } catch {
    // No content script there yet (still loading, or a page it cannot run on): it asks with toolbarHello on load.
    return false;
  }
}

async function pushAll(): Promise<void> {
  const tabs = await toolbarTabs.getValue();
  const s = await getActive();
  for (const tabId of [...pushedTo]) {
    if (tabs.includes(tabId)) continue;
    pushedTo.delete(tabId);
    void send(tabId, null);
  }
  await Promise.all(
    tabs.map(async (tabId) => {
      pushedTo.add(tabId);
      await send(tabId, await stateFor(tabId, s));
    }),
  );
}

/**
 * Coalesces the bursts of changes one action causes (a Start writes the Session several times), one push at a time:
 * a push that read the Session before a change never lands after the push that carries it.
 */
export const pushToolbars: () => void = coalesced(pushAll, 30);

/** Shows or hides the toolbar in a tab. Resolves with whether a page there received it. */
export async function showToolbar(tabId: number, on: boolean): Promise<boolean> {
  const tabs = await toolbarTabs.getValue();
  if (on !== tabs.includes(tabId)) await toolbarTabs.setValue(on ? [...tabs, tabId] : tabs.filter((t) => t !== tabId));
  if (!on) pushedTo.delete(tabId);
  else pushedTo.add(tabId);
  return send(tabId, on ? await stateFor(tabId) : null);
}

/**
 * The toolbar icon. Where no page of ours runs (chrome://, another extension's page) there is no toolbar to show, so
 * it opens the panel instead, synchronously: Chrome's sidePanel.open must run inside the click.
 */
export function onActionClick(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined) return;
  const mode = modeOf(tab.url);
  if ((mode === 'no_overlay' || mode === 'not_a_target') && tab.windowId !== undefined) {
    void openPanel(tab.windowId);
    return;
  }
  const tabId = tab.id;
  // The recording tab keeps its toolbar: it holds the controls, and on Firefox the frame recording the video.
  void Promise.all([shownIn(tabId), getActive()]).then(([shown, s]) =>
    showToolbar(tabId, !shown || s?.tab_id === tabId),
  );
}

/**
 * Start from the page's toolbar or the shortcut, recording `tabId`, whose toolbar shows at once. On Chrome the tab's
 * video comes from tabCapture, which works once the extension was invoked on the tab (its icon showed the toolbar, or
 * the shortcut) and the tab has not navigated since. Otherwise the Session starts without video and the picker window
 * offers the screen picker: the video joins the Session once the reviewer picks a tab there.
 */
export async function startFromToolbar(tabId: number, clickedAt: number): Promise<StartResult> {
  const tabCapture = platform.capabilities().toolbarVideo === 'tab_capture' && !!platform.tabVideo.captureId;
  if (!(await shownIn(tabId))) await showToolbar(tabId, true);
  return startSession({ state: 'off', reason: 'unavailable' }, clickedAt, {
    tabId,
    tabCapture,
    ...(tabCapture ? { onNoTabCapture: openPicker } : {}),
  });
}

/** Alt+Shift+R: Start on the tab it was pressed in (showing the toolbar there), or Stop. */
export async function toggleSessionFromShortcut(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const s = await getActive();
  // A second press while the page is still taking the Session is not a Stop.
  if (s?.starting) return;
  if (s) {
    await stopSession('shortcut');
    return;
  }
  if (tab?.id === undefined) return;
  const r = await startFromToolbar(tab.id, Date.now());
  if (!r.ok) {
    await panelNotice.setValue(r.error);
    await showToolbar(tab.id, true);
  }
}

/**
 * The panel, from the toolbar's button or Alt+Shift+P. A message from a page is not a user action in every browser
 * (Firefox's sidebarAction.open refuses it), so when the control surface will not open the panel page opens in a
 * small window of its own instead.
 */
export async function openPanel(windowId: number): Promise<void> {
  try {
    await platform.controlSurface.open(windowId);
  } catch (e) {
    console.info('control surface did not open, using a window:', e instanceof Error ? e.message : e);
    await chrome.windows.create({
      url: chrome.runtime.getURL('/sidepanel.html'),
      type: 'popup',
      width: 400,
      height: 760,
    });
  }
}

export async function toolbarOpen(what: 'panel' | 'setup', tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (what === 'setup') {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('/onboarding.html'),
      ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
    });
    return;
  }
  const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
  if (windowId !== undefined) await openPanel(windowId);
}

function toastOf(e: TimelineEvent): NonNullable<ToolbarState['toast']> | null {
  // Dictation shows in its comment box (E11), not as a caption.
  if (e.type === 'transcript_segment') return e.target ? null : { id: e.id, kind: 'caption', text: e.text };
  if (e.type === 'draft_item') return { id: e.id, kind: 'draft', text: e.title };
  return null;
}

/** Follows everything the toolbar shows. */
export function initToolbar(): void {
  for (const item of [
    activeSession,
    discardPending,
    toolbarTabs,
    hostPairing,
    hostStatus,
    panelNotice,
    tabViewports,
    viewportSizes,
  ] as const) {
    (item as { watch(cb: () => void): unknown }).watch(pushToolbars);
  }
  onEventAppended((sessionId, e) => {
    const t = toastOf(e);
    if (!t) return;
    toast = { session_id: sessionId, toast: t };
    pushToolbars();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    pushedTo.delete(tabId);
    void toolbarTabs.getValue().then(async (tabs) => {
      if (tabs.includes(tabId)) await toolbarTabs.setValue(tabs.filter((t) => t !== tabId));
    });
  });
}
