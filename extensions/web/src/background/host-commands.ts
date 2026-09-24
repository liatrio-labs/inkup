// Commands from the Host's user (its TUI's s, p, x and d keys), run as the panel's buttons would run them. A Session
// started from the Host records audio, Strokes and screenshots but no video: screen sharing needs a click here.
import type { CommandMessage } from '@inkup/protocol';
import type { CommandOutcome } from '@/adapters/host';
import type { ActiveSession } from '@/settings';
import { getActive, pauseSession, resumeSession, setDrawMode, startSession, stopSession } from './session';

const done = (session_id: string | null): CommandOutcome => ({ ok: true, session_id, message: null });
const refused = (message: string, session_id: string | null = null): CommandOutcome => ({
  ok: false,
  session_id,
  message,
});

export async function runHostCommand(command: CommandMessage): Promise<CommandOutcome> {
  if (command.command === 'start_session') {
    const started = await startSession({ state: 'off', reason: 'unavailable' }, null);
    return started.ok ? done(started.session.id) : refused(started.error);
  }
  const active = await getActive();
  if (!active || active.stopping) return refused('No Session is recording.');
  switch (command.command) {
    case 'stop': {
      const stopped = await stopSession('stop');
      return stopped.ok ? done(stopped.session_id) : refused('The Session could not be stopped.', active.id);
    }
    case 'pause':
      return outcome(await pauseSession('button'), (s) => s.paused !== null, 'The Session could not be paused.');
    case 'resume':
      return outcome(await resumeSession('button'), (s) => s.paused === null, 'The Session could not be resumed.');
    case 'set_draw_mode': {
      const on = command.draw_mode ?? true;
      if (on && active.paused) return refused('The Session is paused.', active.id);
      if (on && active.mode === 'no_overlay') return refused('This page cannot be drawn on.', active.id);
      return outcome(await setDrawMode(on), (s) => s.draw_mode === on, 'Draw mode could not be changed.');
    }
  }
}

function outcome(s: ActiveSession | null, worked: (s: ActiveSession) => boolean, otherwise: string): CommandOutcome {
  return s && worked(s) ? done(s.id) : refused(otherwise, s?.id ?? null);
}
