// Options (PRD P0-14 transcription and processing settings, P0-15 vendor and processing notices). Keys live in
// storage.local only and are never shown back in full, logged or exported.
import { DictationSection } from './dictation';
import { HostSection } from './host';
import { ProcessingSection } from './processing';
import { TranscriptionSection } from './transcription';

export function App() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8 text-sm">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <a className="text-primary underline" href="/sessions.html" data-testid="open-sessions">
          Stored Sessions
        </a>
      </header>

      <TranscriptionSection />
      <DictationSection />

      <ProcessingSection />

      <HostSection />
    </main>
  );
}
