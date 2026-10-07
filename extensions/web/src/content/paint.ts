// Waiting for the page to be painted before the service worker takes a screenshot. The helper moved to @inkup/ui with
// the toolbar, whose hideForCapture waits on it as well (packages/ui/src/toolbar/paint.ts).
export { nextPaint } from '@inkup/ui/toolbar';
