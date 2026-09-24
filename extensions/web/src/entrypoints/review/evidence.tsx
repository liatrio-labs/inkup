// The review page's right pane (PRD P0-12): the Session's recording, which seeks to the selected Change Item's
// time. Screenshots live in the Change Item cards (src/components/evidence-shot.tsx). Seeking maps Session time to media time around the pauses
// (packages/core/src/media-time.ts). With no video the audio plays instead.

import { type MediaClock, pauseGaps, sessionToMedia } from '@inkup/core/media-time';
import type { TimelineEvent } from '@inkup/core/timeline';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import type { SessionRow } from '@/db';
import { useBlobUrl } from '@/lib/use-blob-url';

export { useBlobUrl };

export interface PlayerHandle {
  /** Seek to a Session time (ms) and show that frame. */
  seek(sessionMs: number): void;
}

/** The recording to play: video when there is one, else the audio. */
export function useRecording(
  session: Pick<SessionRow, 'audio' | 'video'> | null | undefined,
  events: readonly TimelineEvent[],
) {
  const gaps = useMemo(() => pauseGaps(events), [events]);
  const media = session?.video ?? session?.audio ?? null;
  const kind: 'video' | 'audio' | null = session?.video ? 'video' : session?.audio ? 'audio' : null;
  const clock: MediaClock | null = media ? { start_offset_ms: media.start_offset_ms, gaps } : null;
  return { kind, blobId: media?.blob_id ?? null, clock };
}

export const Player = forwardRef<
  PlayerHandle,
  { kind: 'video' | 'audio' | null; blobId: string | null; clock: MediaClock | null; note: string }
>(function Player({ kind, blobId, clock, note }, ref) {
  const url = useBlobUrl(blobId);
  const el = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const pending = useRef<number | null>(null);
  const apply = () => {
    const media = el.current;
    if (!media || pending.current === null || !clock) return;
    media.currentTime = sessionToMedia(pending.current, clock) / 1000;
    pending.current = null;
  };
  useImperativeHandle(ref, () => ({
    seek(ms: number) {
      pending.current = ms;
      if ((el.current?.readyState ?? 0) >= 1) apply();
    },
  }));
  if (!kind)
    return (
      <p className="text-muted-foreground" data-testid="no-recording">
        {note}
      </p>
    );
  if (!url) return <p className="text-muted-foreground">Loading the recording…</p>;
  return kind === 'video' ? (
    // biome-ignore lint/a11y/useMediaCaption: a Session recording has no caption track; its transcript is shown beside it
    <video
      ref={el}
      src={url}
      controls
      preload="metadata"
      onLoadedMetadata={apply}
      className="w-full rounded border bg-black"
      data-testid="evidence-video"
    />
  ) : (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">{note}</p>
      {/* biome-ignore lint/a11y/useMediaCaption: a Session recording has no caption track; its transcript is shown beside it */}
      <audio
        ref={el}
        src={url}
        controls
        preload="metadata"
        onLoadedMetadata={apply}
        className="w-full"
        data-testid="evidence-audio"
      />
    </div>
  );
});
