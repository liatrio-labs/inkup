import { defineBackground } from '#imports';
import {
  captureAnnotation,
  closeAnnotation,
  dropPick,
  objectSelect,
  onTabActivated,
  onTabUpdated,
  overlayCleared,
  pressInteractive,
  recordClick,
  recordFallback,
  recordScrollSettle,
  recordSegment,
  recordSpeechActivity,
  recordSpeechStart,
  recordStroke,
  recordTextComment,
  relayBoxInterim,
  snap,
} from '@/background/capture';
import { cancelSession, initDiscards, undoDiscard } from '@/background/discard';
import { initDrafts, recordDraftAction } from '@/background/drafts';
import {
  backfill,
  backfillCandidates,
  drain,
  findHosts,
  forgetHost,
  initHostClient,
  pairHost,
} from '@/background/host-client';
import { injectIntoOpenTabs } from '@/background/inject';
import { pageApiCall } from '@/background/page-api';
import { followSessionForOwner, listenForPanels } from '@/background/panel-port';
import {
  combineItems,
  estimateProcess,
  listModels,
  startProcess,
  sweepInterruptedRuns,
  testProvider,
} from '@/background/process';
import { openReview } from '@/background/review-tab';
import { sampleBackground } from '@/background/screenshots';
import {
  clearModes,
  contentHello,
  getActive,
  onMediaContextGone,
  onMicGranted,
  onOffscreenError,
  onPanelGone,
  onVideoOwnerGone,
  onVideoStatus,
  pauseSession,
  resumeSession,
  setBoxDictation,
  setDrawMode,
  setMuted,
  setSelectMode,
  startSession,
  stopSession,
  turnOnVoice,
} from '@/background/session';
import {
  initToolbar,
  onActionClick,
  openPanel,
  showToolbar,
  startFromToolbar,
  toggleSessionFromShortcut,
  toolbarHello,
  toolbarOpen,
} from '@/background/toolbar';
import {
  initViewport,
  resetViewport,
  setViewport,
  viewportFrameLoaded,
  viewportHostLayout,
} from '@/background/viewport';
import { onVoiceCommand, onVoiceCommandsStatus } from '@/background/voice';
import { onMessage } from '@/messaging';
import { platform } from '@/platform';
import { micGranted } from '@/settings';

export default defineBackground(() => {
  // The toolbar icon toggles the page's floating toolbar, the main control surface (plan E1). The panel stays one
  // click away on the toolbar, and on Alt+Shift+P.
  platform.controlSurface.onActionClick(onActionClick).catch(console.error);
  initToolbar();
  initViewport();

  // First run: onboarding obtains the mic grant in a visible tab and shows the capture privacy notice.
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === chrome.runtime.OnInstalledReason.INSTALL)
      void chrome.tabs.create({ url: chrome.runtime.getURL('/onboarding.html') });
    // Manifest content scripts only reach pages loaded after install or update; inject into the ones already open.
    if (reason === chrome.runtime.OnInstalledReason.INSTALL || reason === chrome.runtime.OnInstalledReason.UPDATE)
      void injectIntoOpenTabs();
  });

  // Closing the side panel is Stop for a Session the panel started (PRD P0-1, ADR 0001): the panel holds a Port, and
  // its disconnect ends the Session. The toolbar frame's Port only ends its video. A Session started from the page's
  // toolbar or the shortcut has no owning page and runs until Stop (ADR 0004).
  listenForPanels(
    (sessionId) => void onPanelGone(sessionId),
    (sessionId) => void onVideoOwnerGone(sessionId),
  );
  followSessionForOwner();
  // Safari's recorder window holds the microphone: the reviewer closing it is Stop too (#9).
  platform.mediaContext.onClosed?.(() => void onMediaContextGone());

  // A Process run left "running" by a previous worker was interrupted: say so instead of spinning forever.
  void sweepInterruptedRuns().catch(console.warn);

  // A cancelled Session is deleted at its Undo deadline, also by a worker that restarted meanwhile (E10).
  initDiscards();

  // Live Draft Items follow the active Session (only with a key for the Draft model's provider).
  initDrafts();

  // A paired Host gets every event and blob through the outbox; unpaired, this does nothing (ADR 0004).
  initHostClient();

  onMessage('startSession', async ({ data, sender }) => {
    const tabId = data?.from_toolbar ? sender.tab?.id : undefined;
    const r = await startSession(data?.video, data?.clicked_at ?? null, tabId === undefined ? {} : { tabId });
    if (r.ok && tabId !== undefined) await showToolbar(tabId, true);
    return r;
  });
  onMessage('videoStatus', ({ data }) => onVideoStatus(data));
  onMessage('stopSession', () => stopSession('stop'));
  onMessage('openReview', ({ data, sender }) => openReview(data, sender.tab?.windowId));
  onMessage('cancelSession', () => cancelSession());
  onMessage('undoDiscard', ({ data }) => undoDiscard(data));
  onMessage('setMuted', ({ data }) => setMuted(data.on, data.via));
  onMessage('turnOnVoice', () => turnOnVoice());
  // Setup granted the microphone while a Session waited for it ("Turn on voice", E11).
  micGranted.watch((granted) => {
    if (granted) void onMicGranted();
  });
  onMessage('setDrawMode', ({ data }) => setDrawMode(data));
  onMessage('setSelectMode', ({ data }) => setSelectMode(data));
  onMessage('clearModes', () => clearModes());
  onMessage('pauseSession', () => pauseSession('button'));
  onMessage('resumeSession', () => resumeSession('button'));
  onMessage('snapScreenshot', () => snap('panel'));
  onMessage('contentHello', async ({ sender }) => {
    const [session, toolbar] = await Promise.all([contentHello(sender.tab?.id), toolbarHello(sender.tab?.id)]);
    return { session, toolbar };
  });
  onMessage('recordStroke', ({ data, sender }) => recordStroke(sender.tab?.id, data));
  onMessage('closeAnnotation', ({ data, sender }) => closeAnnotation(sender.tab?.id, data));
  onMessage('captureAnnotation', ({ data, sender }) => captureAnnotation(sender.tab?.id, data));
  onMessage('recordClick', ({ data, sender }) => recordClick(sender.tab?.id, data));
  onMessage('pressInteractive', ({ data, sender }) => pressInteractive(sender.tab?.id, data));
  onMessage('recordScrollSettle', ({ data, sender }) => recordScrollSettle(sender.tab?.id, data));
  onMessage('overlayCleared', ({ data, sender }) => overlayCleared(sender.tab?.id, data));
  onMessage('objectSelect', ({ data, sender }) => objectSelect(sender.tab?.id, data));
  onMessage('dropPick', ({ data, sender }) => dropPick(sender.tab?.id, data));
  onMessage('sampleBackground', ({ data, sender }) =>
    sender.tab?.id !== undefined ? sampleBackground(sender.tab.id, sender.tab.windowId, data) : null,
  );
  onMessage('recordTextComment', ({ data, sender }) => recordTextComment(sender.tab?.id, data));
  onMessage('pageApi', ({ data, sender }) => pageApiCall(sender.tab?.id, data));
  onMessage('boxDictation', ({ data, sender }) => setBoxDictation(sender.tab?.id, data));
  onMessage('boxInterim', ({ data }) => relayBoxInterim(data));
  onMessage('transcriptSegment', ({ data }) => recordSegment(data));
  onMessage('speechActivity', ({ data }) => recordSpeechActivity(data));
  onMessage('speechStart', ({ data }) => recordSpeechStart(data));
  onMessage('draftAction', ({ data }) => recordDraftAction(data.draft_id, data.action, 'click'));
  onMessage('voiceCommand', ({ data }) => onVoiceCommand(data));
  onMessage('voiceCommandsStatus', ({ data }) => onVoiceCommandsStatus(data));
  onMessage('offscreenError', ({ data }) => onOffscreenError(data));
  onMessage('transcriptionFallback', ({ data }) => recordFallback(data));
  onMessage('estimateProcess', ({ data }) => estimateProcess(data));
  onMessage('startProcess', ({ data }) => startProcess(data.session_id, data.estimate));
  onMessage('testProvider', ({ data }) => testProvider(data));
  onMessage('listModels', ({ data }) => listModels(data));
  onMessage('combineItems', ({ data }) => combineItems(data));
  onMessage('hostPair', ({ data }) => pairHost(data));
  onMessage('hostFind', () => findHosts());
  onMessage('hostForget', () => forgetHost());
  onMessage('hostDrain', () => void drain());
  onMessage('hostBackfillOffer', async () => ({ sessions: (await backfillCandidates())?.length ?? 0 }));
  onMessage('hostBackfill', async () => ({ queued: await backfill() }));
  onMessage('toolbarHello', ({ sender }) => toolbarHello(sender.tab?.id));
  onMessage('toolbarStart', ({ data, sender }) =>
    sender.tab?.id === undefined
      ? { ok: false as const, code: 'no_tab' as const, error: 'The toolbar is not in a tab.' }
      : startFromToolbar(sender.tab.id, data.clicked_at),
  );
  onMessage('toolbarOpen', ({ data, sender }) => toolbarOpen(data, sender.tab));
  onMessage(
    'toolbarHide',
    async ({ sender }) => void (sender.tab?.id !== undefined && (await showToolbar(sender.tab.id, false))),
  );
  // The toolbar's viewport control (plan E6), and the frame host's page and frame.
  onMessage('viewportSet', ({ data, sender }) =>
    sender.tab?.id !== undefined ? setViewport(sender.tab.id, data) : { ok: false as const, error: 'No tab.' },
  );
  onMessage(
    'viewportReset',
    async ({ sender }) => void (sender.tab?.id !== undefined && (await resetViewport(sender.tab.id))),
  );
  onMessage('viewportFrameLoaded', ({ data, sender }) => viewportFrameLoaded(sender, data));
  onMessage('viewportHostLayout', ({ data, sender }) => viewportHostLayout(sender.tab?.id, data));

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-draw') {
      void getActive().then((s) => s && setDrawMode(!s.draw_mode));
    } else if (command === 'snap') {
      // The shortcut grants activeTab, so this also works where <all_urls> does not reach.
      void snap('shortcut');
    } else if (command === 'toggle-session') {
      // Alt+Shift+R starts a Session on this tab, with the toolbar, or stops the one recording. The shortcut invokes
      // the extension on the tab, so Chrome can record its video with tabCapture (docs/spikes/toolbar-start.md).
      void toggleSessionFromShortcut(tab).catch(console.error);
    } else if (command === 'open-panel' && tab?.windowId !== undefined) {
      // Inside the shortcut's handler, where the browser lets the control surface open.
      void openPanel(tab.windowId);
    }
  });

  // The Session follows its tab through navigations, and notices when the reviewer looks at another tab.
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => void onTabUpdated(tabId, change, tab).catch(console.warn));
  chrome.tabs.onActivated.addListener((info) => void onTabActivated(info).catch(console.warn));

  // The Session is bound to one tab: closing it ends the Session.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void getActive().then((s) => {
      if (s?.tab_id === tabId) void stopSession('tab_closed');
    });
  });
});
