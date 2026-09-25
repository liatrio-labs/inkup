/**
 * `task`, run `delayMs` after the last of a burst of calls, and never two at once: a call while it runs starts one
 * more run once it is done. So the last run always starts after the last call and reads the state as it is then.
 * Overlapping runs could finish out of order, and a slow one that read the state before a change would have the last
 * word (the toolbar's pushes: one that read the Session before Object Select went on arrived after the one that
 * turned it on, and the button stayed off).
 */
export function coalesced(task: () => Promise<unknown>, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const run = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void task()
      .catch(console.warn)
      .finally(() => {
        running = false;
        if (!again) return;
        again = false;
        run();
      });
  };
  return () => {
    clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };
}
