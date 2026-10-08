// Options (PRD P0-14 transcription and processing settings, P0-15 vendor and processing notices). Keys live in
// storage.local only and are never shown back in full, logged or exported.
import { Button } from '@inkup/ui';
import { DictationSection } from './dictation';
import { HostSection } from './host';
import { ProcessingSection } from './processing';
import { TrackersSection } from './trackers';
import { TranscriptionSection } from './transcription';

export function App() {
  return (
    // Every section after the first gets a hairline and room above it, set here so the Trackers section (its own
    // file) takes it too.
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8 text-sm [&>section+section]:border-t [&>section+section]:border-border [&>section+section]:pt-8">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <Button variant="link" asChild className="h-auto p-0 text-sm">
          <a href="/sessions.html" data-testid="open-sessions">
            Stored Sessions
          </a>
        </Button>
      </header>

      <TranscriptionSection />
      <DictationSection />

      <ProcessingSection />

      <HostSection />

      <TrackersSection />
    </main>
  );
}
