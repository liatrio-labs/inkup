// Waiting for the page to be painted before the service worker takes a screenshot: captureVisibleTab grabs the last
// composited frame, so a style change (the toolbar hidden, a selection put back) is only in the shot once a frame with
// it has been painted.

/** Resolves once a frame has been painted since the call: two animation frames, or 150 ms in a tab that is not painting. */
export function nextPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = setTimeout(resolve, 150);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(done);
        resolve();
      }),
    );
  });
}
