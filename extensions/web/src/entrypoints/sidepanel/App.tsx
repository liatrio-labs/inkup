import { formatElapsed } from '@inkup/core/clock';
import { activeElapsed } from '@inkup/core/media-time';
import { SOFT_CAP_MINUTES, softCapMessage, softCapsReached } from '@inkup/core/session-list';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { DiscardUndo } from '@/components/discard-undo';
import { Button } from '@/components/ui/button';
import { db } from '@/db';
import { PANEL_PORT, type PanelToWorker, type WorkerToPanel } from '@/lib/panel-port';
import { useSpeechPack } from '@/lib/speech-pack';
import { useStorageEstimate } from '@/lib/use-storage-estimate';
import { useNow, useStorageItem } from '@/lib/use-storage-item';
import { cn } from '@/lib/utils';
import { pickTabVideo, TabVideoRecorder } from '@/media/tab-video';
import { sendMessage } from '@/messaging';
import { platform, type SurfacePort } from '@/platform';
import { activeSession, panelNotice } from '@/session-state';
import { discardPending, micGranted } from '@/settings';
import { AnnotationCards, DraftCards } from './cards';
import { HostIndicator } from './host-indicator';
import { PreviousSessions } from './previous-sessions';

/**
 * The Port that makes closing this panel a Stop (ADR 0001). It reconnects if the service worker restarts, and
 * re-registers the Session this panel started. Pings keep the worker awake while the panel is open.
 */
function usePanelPort(recorder: React.RefObject<TabVideoRecorder | null>, owned: React.RefObject<string | null>) {
  const portRef = useRef<SurfacePort<PanelToWorker, WorkerToPanel> | null>(null);
  useEffect(() => {
    let closed = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    const post = (m: PanelToWorker) => {
      try {
        portRef.current?.postMessage(m);
      } catch {
        /* reconnecting */
      }
    };
    const connect = () => {
      const port = platform.surfacePort.connect<PanelToWorker, WorkerToPanel>(PANEL_PORT);
      portRef.current = port;
      if (owned.current) post({ type: 'owner', session_id: owned.current });
      port.onMessage((msg) => {
        if (msg.type !== 'flush_video') return;
        const r = recorder.current;
        void (async () => {
          const chunks = r && r.session === msg.session_id ? await r.flush() : 0;
          if (r === recorder.current) recorder.current = null;
          post({ type: 'video_flushed', session_id: msg.session_id, chunks, stopped_at: r?.stoppedAt ?? Date.now() });
        })();
      });
      port.onDisconnect(() => {
        portRef.current = null;
        if (!closed) setTimeout(connect, 100);
      });
    };
    connect();
    ping = setInterval(() => post({ type: 'ping' }), 20_000);
    // The document is going away: ask the recorder for what it has, the Port's disconnect then stops the Session.
    const onHide = () => recorder.current?.requestData();
    addEventListener('pagehide', onHide);
    return () => {
      closed = true;
      clearInterval(ping);
      removeEventListener('pagehide', onHide);
      portRef.current?.disconnect();
    };
  }, [recorder, owned]);
  // Stable: it reads the current Port from a ref.
  return useCallback((m: PanelToWorker) => {
    try {
      portRef.current?.postMessage(m);
    } catch {
      /* the reconnect re-registers */
    }
  }, []);
}

/** Mic grant state as far as this context can tell. The onboarding flag is the source of truth in automation,
 *  where Chrome grants each request without persisting a permission (docs/spikes/README.md a1). */
function useMicReady(): 'unknown' | 'ready' | 'needs-setup' | 'blocked' {
  const granted = useStorageItem(micGranted);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((p) => {
        setDenied(p.state === 'denied');
        p.onchange = () => setDenied(p.state === 'denied');
      })
      .catch(() => {});
  }, []);
  if (granted === undefined) return 'unknown';
  if (denied) return 'blocked';
  return granted ? 'ready' : 'needs-setup';
}

/** Chrome labels a captured tab `web-contents-media-stream://…`; the extension cannot map it back to a tab (ADR 0002). */
const videoLabel = (label: string) =>
  !label || label.startsWith('web-contents-media-stream://') ? 'the tab you picked' : label;

export function App() {
  const stored = useStorageItem(activeSession);
  const discards = useStorageItem(discardPending);
  // A cancelled Session is over here at once, while its Stop finishes behind the Undo (E10).
  const session = stored && discards?.some((p) => p.session_id === stored.id) ? null : stored;
  const notice = useStorageItem(panelNotice);
  const mic = useMicReady();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recording = !!session;
  const [pack, installPack] = useSpeechPack(navigator.language || 'en-US');
  const now = useNow(recording);
  // Recording time without the pauses: frozen while paused, continuing from there on resume.
  const elapsed = session
    ? activeElapsed(now - session.t0, { paused_ms: session.paused_ms ?? 0, since: session.paused?.t ?? null })
    : 0;
  const recorder = useRef<TabVideoRecorder | null>(null);
  const owned = useRef<string | null>(null);
  const postToWorker = usePanelPort(recorder, owned);

  // The video recorder pauses with the Session (button or voice), so the file skips the paused time.
  const paused = !!session?.paused;
  useEffect(() => recorder.current?.setPaused(paused), [paused]);
  // A Session that ended without asking this panel (e.g. its tab closed while the worker restarted) still frees the capture.
  useEffect(() => {
    if (session !== null) return;
    owned.current = null;
    postToWorker({ type: 'owner', session_id: null });
    if (!recorder.current) return;
    void recorder.current.flush();
    recorder.current = null;
  }, [session, postToWorker]);

  // Annotations taken back by "scratch that" no longer count.
  const annotationCount =
    useLiveQuery(async () => {
      if (!session) return 0;
      const all = await db.eventsOfType(session.id, 'annotation').count();
      const scratched = await db
        .eventsOfType(session.id, 'voice_command')
        .filter((e) => e.target?.kind === 'annotation')
        .count();
      return all - scratched;
    }, [session?.id]) ?? 0;

  // PRD P0-8: a voice pause can be a false trigger ("…should pause here"), so it offers Undo for 2 s.
  const voicePauseAt = session?.paused?.via === 'voice' ? session.paused.at : null;
  useEffect(() => {
    if (voicePauseAt === null) return;
    toast('Paused by voice', {
      id: `voice-pause-${voicePauseAt}`,
      duration: 2000,
      action: { label: 'Undo', onClick: () => void sendMessage('resumeSession') },
    });
  }, [voicePauseAt]);
  // Soft cap (PRD P0-1): warn at 45 and 60 minutes; recording continues.
  const capsReached = session && !session.stopping ? softCapsReached(elapsed).length : 0;
  const softCap = capsReached > 0 ? SOFT_CAP_MINUTES[capsReached - 1]! : null;
  const sessionId = session?.id;
  // Once per threshold per Session.
  useEffect(() => {
    if (!sessionId || softCap === null) return;
    toast.warning(softCapMessage(softCap), { id: `soft-cap-${sessionId}-${softCap}`, duration: 10_000 });
  }, [softCap, sessionId]);
  const storage = useStorageEstimate(60_000, [recording]);

  const captions = useLiveQuery(
    async () =>
      session
        ? (
            await db
              .eventsOfType(session.id, 'transcript_segment')
              .filter((e) => !e.target)
              .sortBy('t')
          )
            .slice(-2)
            .map((e) => e.text)
        : [],
    [session?.id],
  );

  async function start() {
    const clickedAt = Date.now();
    setBusy(true);
    setError(null);
    // First, while the click's transient activation is fresh (docs/spikes/README.md c): the screen picker.
    const picked = await pickTabVideo();
    try {
      const r = await sendMessage('startSession', { video: picked.info, clicked_at: clickedAt });
      if (!r.ok) {
        setError(r.error);
        picked.stream?.getTracks().forEach((t) => {
          t.stop();
        });
        return;
      }
      owned.current = r.session.id;
      postToWorker({ type: 'owner', session_id: r.session.id });
      if (picked.stream) {
        recorder.current = new TabVideoRecorder(picked.stream, r.session.id, r.session.t0);
        recorder.current.start();
      }
    } catch (e) {
      picked.stream?.getTracks().forEach((t) => {
        t.stop();
      });
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await sendMessage('stopSession');
    } finally {
      setBusy(false);
    }
  }

  const openSetup = () => chrome.tabs.create({ url: chrome.runtime.getURL('/onboarding.html') });
  const goBack = async () => {
    if (!session) return;
    await chrome.tabs.update(session.tab_id, { active: true });
    await chrome.windows.update(session.window_id, { focused: true }).catch(() => {});
  };

  return (
    <main className="flex min-h-screen flex-col gap-4 p-4 text-sm">
      <Toaster position="bottom-center" />
      <header className="flex items-center justify-between">
        <h1 className="text-base font-semibold">InkUp</h1>
        <span
          data-testid="status"
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            session?.paused
              ? 'bg-amber-100 text-amber-900'
              : recording
                ? 'bg-red-100 text-red-800'
                : 'bg-muted text-muted-foreground',
          )}
        >
          {session?.stopping
            ? 'Finishing…'
            : session?.starting
              ? 'Starting…'
              : session?.paused
                ? 'Paused'
                : recording
                  ? 'Recording'
                  : 'Ready'}
        </span>
      </header>

      {recording ? (
        <section className="flex flex-col gap-3" aria-label="Session">
          <div className="flex items-baseline justify-between">
            <span
              data-testid="timer"
              className="font-mono text-3xl tabular-nums"
              role="timer"
              aria-label="Elapsed time"
            >
              {formatElapsed(elapsed)}
            </span>
            <span className="text-muted-foreground">
              <span data-testid="annotation-count">{annotationCount}</span>{' '}
              {annotationCount === 1 ? 'Annotation' : 'Annotations'}
            </span>
          </div>
          {softCap !== null && (
            <p
              className="rounded-md bg-amber-50 p-2 text-amber-900"
              role="note"
              data-testid="soft-cap"
              data-minutes={softCap}
            >
              {softCapMessage(softCap)}
            </p>
          )}
          <p className="truncate" data-testid="recording-tab" title={session.tab_url}>
            Recording: {session.tab_title || session.tab_url}
          </p>
          <p
            className="truncate text-xs text-muted-foreground"
            data-testid="video-status"
            data-state={session.video.state}
          >
            {session.video.state === 'off'
              ? `Video off${session.video.reason === 'picker_cancelled' ? ': the screen picker was cancelled' : session.video.reason === 'failed' ? ': screen capture failed' : session.video.reason === 'unavailable' ? ': this browser cannot record the screen here' : ''}. Audio, Strokes and screenshots are still recorded.`
              : session.video.state === 'ended'
                ? 'Video stopped: sharing ended. Audio, Strokes and screenshots are still recorded.'
                : `Video: ${videoLabel(session.video.label)}`}
          </p>
          {session.mode === 'no_overlay' && (
            <p className="rounded-md bg-amber-50 p-2 text-amber-900" role="note" data-testid="no-overlay">
              Drawing is off on this page: it belongs to Chrome or to another extension, where this extension cannot
              draw or read the page. The Session still records your voice, the transcript, video and the address. Press
              Alt+Shift+S for a screenshot; the Snap button cannot capture this page.
            </p>
          )}
          {session.away && (
            <p className="rounded-md bg-muted p-2" role="note" data-testid="away">
              You are looking at another tab. The Session keeps recording {session.tab_title || 'its tab'}; screenshots
              resume when you return.{' '}
              <button type="button" className="font-medium underline" onClick={goBack} data-testid="go-back">
                Go back
              </button>
            </p>
          )}
          {session.captions === 'unavailable' && (
            <div
              className="flex flex-col gap-2 rounded-md bg-amber-50 p-2 text-amber-900"
              role="note"
              data-testid="captions-off"
            >
              <p>
                {platform.capabilities().speechRecognition
                  ? 'Live captions are off: on-device speech is not installed for this language, and server speech is not allowed.'
                  : 'Live captions are off: this browser has no built-in speech recognition. Download a Whisper model or add a paid engine in Settings.'}{' '}
                Audio, Strokes and screenshots are still recorded.
              </p>
              {pack === 'downloadable' && (
                <Button size="sm" variant="outline" onClick={installPack}>
                  Install on-device speech (takes effect next Session)
                </Button>
              )}
              {pack === 'downloading' && <p>Downloading the language pack…</p>}
            </div>
          )}
          {session.transcription && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="active-engine"
              data-engine={session.transcription.engine}
            >
              {engineLabel(session.transcription.engine, session.transcription.local, session.captions)}
            </p>
          )}
          {session.transcription && session.transcription.engine === 'webspeech' && !session.transcription.local && (
            <p className="rounded-md bg-amber-50 p-2 text-amber-900" role="note" data-testid="server-speech">
              Captions use Chrome&apos;s server speech service, as allowed in setup: your audio goes to Google.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={session.draw_mode ? 'default' : 'outline'}
              aria-pressed={session.draw_mode}
              onClick={() => sendMessage('setDrawMode', !session.draw_mode)}
              disabled={session.stopping || !!session.paused || session.mode === 'no_overlay'}
              data-testid="draw-toggle"
            >
              Draw {session.draw_mode ? 'on' : 'off'}
            </Button>
            {session.paused ? (
              <Button
                variant="outline"
                onClick={() => sendMessage('resumeSession')}
                disabled={session.stopping}
                data-testid="resume"
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => sendMessage('pauseSession')}
                disabled={session.stopping}
                data-testid="pause"
              >
                Pause
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => sendMessage('snapScreenshot')}
              disabled={session.stopping || !!session.paused}
              data-testid="snap"
            >
              Snap
            </Button>
            {session.voice === false ? (
              <Button
                variant="outline"
                onClick={() => sendMessage('turnOnVoice')}
                disabled={session.stopping}
                data-testid="voice-on"
              >
                Turn on voice
              </Button>
            ) : (
              <Button
                variant="outline"
                aria-pressed={!!session.muted}
                onClick={() => sendMessage('setMuted', { on: !session.muted, via: 'button' })}
                disabled={session.stopping}
                data-testid="mute"
                title="Alt+Shift+M on the page"
              >
                {session.muted ? 'Unmute' : 'Mute'}
              </Button>
            )}
            <Button variant="outline" onClick={stop} disabled={busy || session.stopping} data-testid="stop">
              Stop
            </Button>
            <Button
              variant="destructive"
              onClick={() => sendMessage('cancelSession')}
              disabled={busy || session.stopping}
              data-testid="cancel"
              title="Stop and discard this Session (Undo for a few seconds)"
            >
              Cancel
            </Button>
          </div>
          {session.voice === false && (
            <p className="rounded-md bg-muted p-2" role="note" data-testid="no-mic-note">
              No mic: this Session records ink, picks, typed comments and screenshots. A drawn Annotation asks for a
              typed note.
            </p>
          )}
          {session.muted && (
            <p className="rounded-md bg-amber-50 p-2 text-amber-900" role="note" data-testid="muted-note">
              Microphone off: nothing you say is recorded or transcribed. Drawing, picks and screenshots go on.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Alt+Shift+D toggles drawing. Hold Shift to draw once. Alt+Shift+S takes a screenshot.
          </p>
          <p className="text-xs text-muted-foreground" data-testid="voice-commands">
            {session.commands === 'ready'
              ? 'Voice Commands: pause, then say "scratch that", "next", "pin that", "snap", "pause" or "resume", then pause again.'
              : session.commands === 'loading'
                ? 'Voice Commands are starting…'
                : `Voice Commands are unavailable. ${session.commands_note ?? ''}`}
          </p>
          <div
            data-testid="captions"
            aria-live="polite"
            className="min-h-[3.5rem] rounded-md border bg-card p-2 leading-snug"
          >
            {captions && captions.length > 0 ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the last two caption lines, replaced as a whole; their text need not be unique
              captions.map((c, i) => <p key={i}>{c}</p>)
            ) : (
              <p className="text-muted-foreground">Captions appear here as you speak.</p>
            )}
          </div>
          {session.drafts?.enabled ? (
            <DraftCards
              sessionId={session.id}
              running={session.drafts.running}
              note={session.drafts.note}
              disabled={session.stopping}
            />
          ) : (
            <AnnotationCards
              sessionId={session.id}
              quality={session.transcription?.timestamp_quality ?? 'approximate'}
            />
          )}
        </section>
      ) : (
        <section className="flex flex-col gap-3" aria-label="Start">
          <DiscardUndo />
          <Button onClick={start} disabled={busy || mic === 'unknown'} data-testid="start">
            Start
          </Button>
          {mic === 'ready' && (pack === 'downloadable' || pack === 'downloading') && (
            <div className="flex flex-col gap-2 text-muted-foreground" data-testid="speech-pack-offer">
              <p>On-device captions are not installed. Sessions still record audio, Strokes and screenshots.</p>
              {pack === 'downloadable' ? (
                <Button size="sm" variant="outline" onClick={installPack}>
                  Install on-device speech
                </Button>
              ) : (
                <p>Downloading the language pack…</p>
              )}
            </div>
          )}
          {mic === 'needs-setup' && (
            <p data-testid="mic-gate" className="text-muted-foreground">
              No microphone yet: a Session records ink, picks, typed comments and screenshots.{' '}
              <button type="button" className="underline" onClick={openSetup}>
                Allow the microphone
              </button>{' '}
              for voice.
            </p>
          )}
          {mic === 'blocked' && (
            <p data-testid="mic-gate" className="text-destructive">
              The microphone is blocked for this extension, so a Session has no voice. Allow it in Chrome&apos;s site
              settings, then{' '}
              <button type="button" className="underline" onClick={openSetup}>
                run setup again
              </button>
              .
            </p>
          )}
          <PreviousSessions />
        </section>
      )}
      {storage?.warn && (
        <p className="rounded-md bg-amber-50 p-2 text-amber-900" role="note" data-testid="storage-warning">
          Storage is {Math.round(storage.ratio * 100)}% full.{' '}
          <a className="underline" href="/sessions.html" target="_blank" rel="noopener">
            Delete old Sessions
          </a>{' '}
          to make room.
        </p>
      )}
      {(error || notice) && (
        <p role="alert" className="text-destructive">
          {error ?? notice}
        </p>
      )}
      <footer className="mt-auto flex gap-4 text-xs text-muted-foreground">
        <a className="underline" href="/sessions.html" target="_blank" data-testid="open-sessions" rel="noopener">
          Sessions
        </a>
        <a className="underline" href="/options.html" target="_blank" rel="noopener">
          Settings
        </a>
        <span className="ml-auto">
          <HostIndicator />
        </span>
      </footer>
    </main>
  );
}

/** The panel's line naming the engine that transcribes this Session (PRD P0-7, P0-15: say where audio goes). */
export function engineLabel(engine: string, local: boolean | null, captions: 'live' | 'unavailable'): string {
  if (captions === 'unavailable') return 'Transcription: off (no live captions)';
  switch (engine) {
    case 'deepgram':
      return 'Transcription: Deepgram Nova-3 (Better). Audio streams to Deepgram while recording.';
    case 'elevenlabs':
      return 'Transcription: ElevenLabs Scribe v2 (Best). Audio streams to ElevenLabs while recording.';
    case 'whisper':
      return 'Transcription: local Whisper on this device (Free). Captions follow each pause.';
    case 'webspeech':
      return local ? 'Transcription: on-device Web Speech (Free)' : 'Transcription: Chrome server speech (Free)';
    default:
      return `Transcription: ${engine}`;
  }
}
