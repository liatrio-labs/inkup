// Voice Command effects (PRD P0-8). The offscreen document matches phrases and applies the silence gate
// (packages/core/src/voice-commands.ts); the service worker logs a `voice_command` event and acts:
// - scratch that: close the open Annotation, then discard the latest Draft Item or Annotation
//   (resolveScratchTarget). A Draft Item target also gets a `draft_action` discard with source `voice`.
// - next / new note: close the open Annotation.
// - pin that: pin the latest Draft Item that is not pinned or discarded, as a `draft_action` pin with source
//   `voice`. With no such draft (or no key, so no drafts) it is logged with no target.
// - snap: screenshot. pause / resume: pause or resume the Session; the panel offers Undo for a voice pause.
// While paused only `resume` is acted on; while muted (E10) nothing is.

import { sortTimeline } from '@inkup/core/timeline';
import { resolvePinTarget, resolveScratchTarget } from '@inkup/core/voice-command-effects';
import { db } from '@/db';
import type { VoiceCommandInput, VoiceCommandsStatus } from '@/messaging';
import { snap } from './capture';
import { recordDraftAction } from './drafts';
import { appendEvent } from './event-log';
import { getActive, offsetOf, patchActive, pauseSession, resumeSession, signalContent } from './session';

let chain: Promise<unknown> = Promise.resolve();

/** Commands are handled one at a time, in the order they were confirmed. */
export function onVoiceCommand(hit: VoiceCommandInput): Promise<void> {
  const run = chain.then(() => handle(hit));
  chain = run.catch((e) => console.warn('voice command failed', e));
  return run;
}

async function handle(hit: VoiceCommandInput): Promise<void> {
  const s = await getActive();
  if (!s || s.stopping || s.muted) return;
  if (s.paused && hit.command !== 'resume') return;
  const log = (target: { kind: 'annotation' | 'draft_item'; id: string } | null = null) =>
    appendEvent(s.id, {
      type: 'voice_command',
      t: hit.t,
      t_end: Math.max(hit.t, hit.t_end),
      command: hit.command,
      phrase: hit.phrase,
      segment_id: hit.segment_id,
      target,
    });
  const timeline = async () => sortTimeline(await db.events.where('session_id').equals(s.id).toArray());

  switch (hit.command) {
    case 'scratch_that': {
      await signalContent(s, { reason: 'voice_command', t: offsetOf(s) });
      const target = resolveScratchTarget(await timeline());
      await log(target);
      if (target?.kind === 'draft_item') await recordDraftAction(target.id, 'discard', 'voice');
      return;
    }
    case 'next':
      await signalContent(s, { reason: 'voice_command', t: offsetOf(s) });
      await log();
      return;
    case 'pin_that': {
      const target = resolvePinTarget(await timeline());
      await log(target);
      if (target) await recordDraftAction(target.id, 'pin', 'voice');
      return;
    }
    case 'snap':
      await log();
      await snap('voice_command');
      return;
    case 'pause':
      await log();
      await pauseSession('voice');
      return;
    case 'resume':
      await log();
      await resumeSession('voice');
      return;
  }
}

export async function onVoiceCommandsStatus(status: VoiceCommandsStatus): Promise<void> {
  await patchActive((s) => {
    // No live captions: nothing to match, whatever the VAD says.
    if (s.commands === 'unavailable' && s.captions === 'unavailable') return s;
    return { ...s, commands: status.status, commands_note: status.status === 'unavailable' ? status.reason : null };
  });
}
