// One stored Session in a list (PRD P0-14): @inkup/ui's SessionRow, fed from here. The extension deletes through
// Dexie, names the origin as the reviewer knows it, and opens the review through ReviewLink, which focuses a tab
// already showing it. The Sessions page shows the full row; the side panel's idle state the compact one.

import { originOf } from '@inkup/core/session-list';
import { SessionRow as SessionRowView } from '@inkup/ui';
import { ReviewLink } from '@/components/review-link';
import { db } from '@/db';
import { deleteSession, type SessionSummary } from '@/db/sessions';
import { useOriginLabel } from '@/lib/use-origin-label';

export function SessionRow({
  s,
  recording,
  compact = false,
}: {
  s: SessionSummary;
  recording: boolean;
  compact?: boolean;
}) {
  const label = useOriginLabel();
  return (
    <SessionRowView
      session={s}
      recording={recording}
      compact={compact}
      originLabel={compact ? label(originOf(s.start_url)) : undefined}
      onDelete={(id) => deleteSession(db, id)}
      renderReviewLink={(link) => <ReviewLink {...link} />}
    />
  );
}
