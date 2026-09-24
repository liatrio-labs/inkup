// The Session event log. The service worker is the only writer of timeline events; every event is validated
// against the versioned schema before it is stored, so a bad producer fails loudly at capture time. While a Host
// is paired, each event is also queued for it (src/db/outbox.ts). Listeners (the page toolbar's toast strip) hear
// each event once it is stored.
import { type NewEvent, type TimelineEvent, TimelineEventSchema } from '@inkup/core/timeline';
import { storeEvents } from '@/db/outbox';

type Listener = (sessionId: string, event: TimelineEvent) => void;
const listeners: Listener[] = [];

export function onEventAppended(listener: Listener): void {
  listeners.push(listener);
}

export async function appendEvent<E extends NewEvent>(sessionId: string, event: E): Promise<TimelineEvent> {
  const parsed = TimelineEventSchema.parse({ ...event, id: crypto.randomUUID() });
  await storeEvents(sessionId, [parsed]);
  for (const l of listeners) {
    try {
      l(sessionId, parsed);
    } catch (e) {
      console.warn('event listener failed', e);
    }
  }
  return parsed;
}
