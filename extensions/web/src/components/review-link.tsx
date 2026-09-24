// "Open review": a plain click focuses the tab already showing that Session's review, or opens one
// (background/review-tab.ts). The href stays, so a middle, Cmd or Ctrl click still opens a new tab on purpose.

import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { reviewPath } from '@/lib/review-url';
import { sendMessage } from '@/messaging';

export function ReviewLink({
  sessionId,
  onClick,
  ...props
}: { sessionId: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target'>) {
  function click(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void sendMessage('openReview', sessionId).catch((err: unknown) => {
      console.warn('openReview failed; opening a tab', err);
      window.open(reviewPath(sessionId), '_blank', 'noopener');
    });
  }
  return <a {...props} href={reviewPath(sessionId)} target="_blank" rel="noopener" onClick={click} />;
}
