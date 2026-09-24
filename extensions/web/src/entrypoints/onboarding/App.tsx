// First run (PRD P0-1, P0-15): the microphone grant must come from a visible extension tab, because neither
// the side panel's offscreen document nor the service worker can show the permission prompt (ADR 0001).
//
// The microphone is optional (E11): skipped, a Session records ink, picks, typed comments and screenshots. "Turn on
// voice" in a running Session opens this page with `?voice=1`; the grant turns that Session's voice on.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getUserMediaWithRetry } from '@/lib/get-user-media';
import { useSpeechPack } from '@/lib/speech-pack';
import { useStorageItem } from '@/lib/use-storage-item';
import { platform } from '@/platform';
import { allowServerSpeech, micGranted } from '@/settings';

export function App() {
  const granted = useStorageItem(micGranted);
  const allowServer = useStorageItem(allowServerSpeech);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const forSession = new URLSearchParams(location.search).get('voice') === '1';
  const lang = navigator.language || 'en-US';
  const [pack, installPack] = useSpeechPack(lang);

  async function allowMic() {
    setError(null);
    try {
      const stream = await getUserMediaWithRetry({ audio: true });
      stream.getTracks().forEach((t) => {
        t.stop();
      });
      await micGranted.setValue(true);
    } catch (e) {
      await micGranted.setValue(false);
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Chrome blocked the microphone. Allow it for this extension in the address bar, then try again.'
          : String(e),
      );
    }
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-sm leading-relaxed">
      <h1 className="text-2xl font-semibold">Set up InkUp</h1>

      <section aria-labelledby="notice" className="rounded-lg border bg-card p-5">
        <h2 id="notice" className="mb-2 text-base font-semibold">
          What a Session captures
        </h2>
        <ul className="list-disc space-y-1 pl-5" data-testid="privacy-notice">
          <li>
            Your microphone, from Start to Stop, if you allow it. The audio is recorded and transcribed into live
            captions.
          </li>
          <li>
            Screenshots of the tab you are reviewing, taken when you finish drawing on it. Screen content is captured
            as-is.
          </li>
          <li>The Strokes you draw, and the page elements under them.</li>
          <li>Keystrokes are never captured.</li>
          <li>
            Everything stays in this browser&apos;s extension storage until you delete it. With the free transcription
            tier and no API key, the extension makes no network calls.
          </li>
          <li>
            The side panel timer and Chrome&apos;s own indicators show when you are recording. Nothing is drawn into the
            page except your Strokes.
          </li>
        </ul>
      </section>

      <section aria-labelledby="mic" className="flex flex-col gap-2">
        <h2 id="mic" className="text-base font-semibold">
          1. Microphone
        </h2>
        {forSession && !granted && (
          <p data-testid="voice-for-session">
            Allow the microphone to turn on voice for the Session that is recording.
          </p>
        )}
        {granted ? (
          <p data-testid="mic-status" className="text-green-700">
            {forSession
              ? 'Microphone ready: the recording Session has voice now. You can close this tab.'
              : 'Microphone ready. Open the side panel from the toolbar icon and press Start.'}
          </p>
        ) : skipped ? (
          <p data-testid="mic-skipped" className="text-muted-foreground">
            No microphone for now. Sessions record ink, picks, typed comments and screenshots; Process builds items from
            what you type. &ldquo;Turn on voice&rdquo; on the toolbar asks again.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <Button onClick={allowMic} data-testid="allow-mic">
              Allow microphone
            </Button>
            <Button variant="ghost" onClick={() => setSkipped(true)} data-testid="skip-mic">
              Skip: record without voice
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </section>

      <section aria-labelledby="speech" className="flex flex-col gap-2">
        <h2 id="speech" className="text-base font-semibold">
          2. On-device captions ({lang})
        </h2>
        <p data-testid="speech-pack">
          {pack === 'checking' && 'Checking…'}
          {pack === 'available' && 'Installed. Speech is recognized on this device.'}
          {pack === 'downloading' && 'Downloading the language pack…'}
          {pack === 'downloadable' &&
            'Chrome can recognize speech on this device after a one-time language pack download.'}
          {(pack === 'unavailable' || pack === 'unsupported') &&
            'On-device speech is not available for this language in this browser.'}
        </p>
        {!platform.capabilities().speechRecognition && (
          <p data-testid="no-webspeech">
            This browser has no built-in speech recognition. For live captions, download a Whisper model or add a paid
            engine in Settings.
          </p>
        )}
        {pack !== 'available' && pack !== 'checking' && (
          <p className="text-muted-foreground">
            Until it is installed, Sessions record audio, Strokes and screenshots without live captions.
          </p>
        )}
        {pack === 'downloadable' && (
          <div>
            <Button variant="outline" onClick={installPack}>
              Install on-device speech
            </Button>
          </div>
        )}
      </section>

      {platform.capabilities().speechRecognition && (
        <section aria-labelledby="server" className="flex flex-col gap-1">
          <h2 id="server" className="text-base font-semibold">
            3. Server speech (optional)
          </h2>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              data-testid="allow-server-speech"
              checked={allowServer ?? false}
              onChange={(e) => void allowServerSpeech.setValue(e.target.checked)}
            />
            <span>Allow Chrome server speech recognition when on-device is unavailable</span>
          </label>
          <p className="pl-6 text-muted-foreground">
            When this is on and on-device speech is missing, your audio goes to Google for live captions.
          </p>
        </section>
      )}
    </main>
  );
}
