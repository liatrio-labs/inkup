// The picker window (background/picker.ts): a Session started from the page's toolbar without tabCapture offers the
// screen picker here, since a click on the page's own toolbar cannot open it. A click in this window can, like one in
// the side panel. The stream belongs to this document, so the window records the video itself and stays open until
// the Session ends; the reviewer goes back to the page meanwhile. Closing it ends the video, not the Session.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStorageItem } from '@/lib/use-storage-item';
import { pickTabVideo, TabVideoRecorder } from '@/media/tab-video';
import { holdVideo } from '@/media/video-owner';
import { sendMessage } from '@/messaging';
import { activeSession } from '@/session-state';

type Step = 'choose' | 'picking' | 'recording';

export function App() {
  const session = useStorageItem(activeSession);
  const [step, setStep] = useState<Step>('choose');
  const [error, setError] = useState<string | null>(null);
  // The Session this window serves: the one live when it opened.
  const serves = useRef<string | null>(null);
  if (session && serves.current === null) serves.current = session.id;

  // A Session that ends (or never was) takes the window with it, picked or not. While recording, Stop has already
  // taken the last chunk by the time the Session is cleared.
  const gone = session === null || (!!session && serves.current !== session.id);
  useEffect(() => {
    if (gone && step !== 'picking') window.close();
  }, [gone, step]);

  if (!session) return null;

  async function choose() {
    if (!session) return;
    const { id, t0, window_id: windowId, tab_id: tabId } = session;
    setStep('picking');
    setError(null);
    // First, while the click's transient activation is fresh: the screen picker.
    const picked = await pickTabVideo();
    const r = await sendMessage('attachVideo', { session_id: id, video: picked.info }).catch((e: unknown) => {
      setError(String(e));
      return { ok: false };
    });
    if (!picked.stream || !r.ok) {
      picked.stream?.getTracks().forEach((t) => {
        t.stop();
      });
      // Cancelled, or the Session ended meanwhile: it goes on without video, as it started.
      window.close();
      return;
    }
    const recorder = new TabVideoRecorder(picked.stream, id, t0);
    recorder.start();
    holdVideo(recorder, () => window.close());
    setStep('recording');
    // Back to the page under review; this window stays behind it.
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  }

  async function withoutVideo() {
    if (!session) return;
    await sendMessage('attachVideo', {
      session_id: session.id,
      video: { state: 'off', reason: 'picker_cancelled' },
    }).catch(() => {});
    window.close();
  }

  const video = session.video;
  return (
    <main className="flex min-h-screen flex-col gap-3 p-4 text-sm" data-testid="picker" data-step={step}>
      {step === 'recording' ? (
        <>
          <h1 className="text-base font-semibold" data-testid="picker-recording">
            {video.state === 'ended' ? 'Video ended' : 'Recording video — keep this window open'}
          </h1>
          <p className="text-muted-foreground">
            {video.state === 'ended'
              ? 'Sharing stopped. The Session goes on with audio, Strokes and screenshots.'
              : `The video of ${video.state === 'recording' ? video.label || 'your tab' : 'your tab'} is recorded here. Closing this window ends the video; the Session goes on.`}
          </p>
          <Button variant="destructive" className="mt-auto" onClick={() => void sendMessage('stopSession')}>
            Stop Session
          </Button>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <h1 className="text-base font-semibold">Record video of this Session?</h1>
            <p className="truncate font-medium" data-testid="picker-title" title={session.tab_title}>
              {session.tab_title || 'Untitled page'}
            </p>
            <p className="truncate text-xs text-muted-foreground" data-testid="picker-url" title={session.tab_url}>
              {session.tab_url}
            </p>
          </div>
          <p className="text-muted-foreground">
            The Session is recording your voice, Strokes and screenshots. Choose the tab to add its video.
          </p>
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="mt-auto flex flex-col gap-2">
            <Button onClick={() => void choose()} disabled={step === 'picking'} data-testid="picker-choose">
              Choose what to record
            </Button>
            <Button
              variant="outline"
              onClick={() => void withoutVideo()}
              disabled={step === 'picking'}
              data-testid="picker-without-video"
            >
              Record without video
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
