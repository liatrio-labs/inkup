// The channel between our two content scripts (E4): the isolated-world overlay and the MAIN-world bridge
// (entrypoints/bridge.content.ts), which alone can see the page's own JavaScript objects (React fibers, Vue
// instances). They share only the DOM, so they talk in DOM CustomEvents on `document` with JSON-string details
// (an object detail does not survive the crossing between worlds in Firefox). Events run their listeners
// synchronously, so an answer normally arrives before dispatchEvent returns.
//
// The page can see and send these events too. Nothing here is trusted: a source is a hint for the agent, never
// used to act on the page.

/** Isolated → MAIN: `{id}`. The elements to read carry ATTR = `<id>:<index>`. */
export const SOURCE_PROBE = 'inkup:source-probe';
/** MAIN → isolated: `{id, results}`, one entry per index (null: nothing known). */
export const SOURCE_RESULT = 'inkup:source-result';
/** MAIN → isolated, when the bridge starts: probes stop short-circuiting. */
export const BRIDGE_READY = 'inkup:bridge-ready';
export const PROBE_ATTR = 'data-inkup-probe';

export interface SourceInfo {
  file?: string;
  line?: number;
  components: string[];
}

export interface SourceResult {
  id: string;
  results: (SourceInfo | null)[];
}

// ---- The page API (E5): `window.__inkup` on the recording tab while a Session is live ----------------------

/** Isolated → MAIN: `{enabled}`. The bridge defines `window.__inkup` while enabled and deletes it otherwise. */
export const PAGE_API_STATE = 'inkup:page-api-state';
/** MAIN → isolated: `{id, method, args}`, a call the page made. */
export const PAGE_API_CALL = 'inkup:page-api-call';
/** Isolated → MAIN: `{id, ok, result}` or `{id, ok: false, error}`. */
export const PAGE_API_REPLY = 'inkup:page-api-reply';
export const PAGE_API_GLOBAL = '__inkup';

export type PageApiMethod = 'status' | 'annotate' | 'list';

export interface PageApiCall {
  id: string;
  method: PageApiMethod;
  args: unknown[];
}

export type PageApiReply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export const PAGE_API_HELP = `window.__inkup: add review notes from a script while an InkUp Session records this tab.
Each note becomes an Annotation marked as coming from the page API, and Process turns it into a Change Item like the reviewer's own.

  __inkup.annotate(selector, { comment, styleChanges?, textChange? })
      selector      CSS selector of one element on this page
      comment       what should change (required)
      styleChanges  { cssProperty: 'new value' | { from?, to } }, e.g. { color: '#0a0' }
      textChange    'new text' | { from?, to }
      → Promise<{ annotation: number, selector }>
  __inkup.status()  → Promise<{ recording, paused, session_id, url, page_api_annotations }>
  __inkup.list()    → Promise<[{ annotation, selector, comment, t }]>, this Session's page API notes
  __inkup.help()    → this text

It exists only on the tab being recorded, while the Session lasts.`;
