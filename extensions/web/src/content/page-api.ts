// The page API's overlay side (E5). The MAIN-world bridge relays `window.__inkup` calls here as DOM events
// (src/bridge/protocol.ts). This side turns on the global only while its tab records a Session, checks every call
// (the page can send these events itself), reads the named element as the drawing path would (snapshot, sources,
// page context), and asks the service worker, which checks the Session again before recording anything.
import type { ElementSnapshot } from '@inkup/core/candidates';
import type { Rect } from '@inkup/core/geometry';
import type { EventOf, PageApiNote } from '@inkup/core/timeline';
import {
  BRIDGE_READY,
  PAGE_API_CALL,
  PAGE_API_REPLY,
  PAGE_API_STATE,
  type PageApiCall,
  type PageApiReply,
} from '@/bridge/protocol';
import { pageContext } from './overlay';
import { snapshotElementWithSources } from './snapshot';

/** The style and text changes a call asks for, in the `style_edit` shape. */
export type PageApiEdit = Pick<EventOf<'style_edit'>, 'changes' | 'text'>;

export interface PageApiAnnotateInput {
  selector: string;
  note: PageApiNote;
  /** Recorded as a `style_edit` on the Annotation. */
  edit?: PageApiEdit;
  bbox: Rect;
  snapshots: ElementSnapshot[];
  page: ReturnType<typeof pageContext>;
}

export type PageApiRequest =
  | { method: 'status' }
  | { method: 'list' }
  | { method: 'annotate'; input: PageApiAnnotateInput };
export type PageApiResult = { ok: true; result: unknown } | { ok: false; error: string };

const MAX_STYLE_PROPS = 20;
const clip = (s: string, n: number) => s.slice(0, n);

class PageApiError extends Error {}

function kebab(prop: string): string {
  return prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The call's options, checked and completed from the element: a style's `from` is its current computed value, the
 * text's `from` the element's text, unless the script gives them.
 */
export function readNote(el: Element, options: unknown): { note: PageApiNote; edit?: PageApiEdit } {
  if (typeof options !== 'object' || options === null)
    throw new PageApiError('annotate(selector, { comment }): options must be an object');
  const o = options as Record<string, unknown>;
  if (typeof o.comment !== 'string' || !o.comment.trim())
    throw new PageApiError('annotate: comment must be a non-empty string');
  const note: PageApiNote = { comment: clip(o.comment.trim(), 2000) };
  const edit: PageApiEdit = { changes: {} };
  if (o.styleChanges !== undefined) {
    if (typeof o.styleChanges !== 'object' || o.styleChanges === null)
      throw new PageApiError('annotate: styleChanges must be an object of CSS property → value');
    const computed = getComputedStyle(el);
    const entries = Object.entries(o.styleChanges as Record<string, unknown>).slice(0, MAX_STYLE_PROPS);
    for (const [prop, v] of entries) {
      const to = toOf(v);
      if (to === null) throw new PageApiError(`annotate: styleChanges.${prop} must be a string or { from?, to }`);
      const from = fromOf(v) ?? computed.getPropertyValue(kebab(prop)).trim();
      edit.changes[clip(kebab(prop), 100)] = { from: clip(from, 200), to: clip(to, 200) };
    }
  }
  if (o.textChange !== undefined) {
    const to = toOf(o.textChange);
    if (to === null) throw new PageApiError('annotate: textChange must be a string or { from?, to }');
    edit.text = {
      from: clip(fromOf(o.textChange) ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim(), 2000),
      to: clip(to, 2000),
    };
  }
  return Object.keys(edit.changes).length || edit.text ? { note, edit } : { note };
}

const toOf = (v: unknown): string | null =>
  typeof v === 'string'
    ? v
    : typeof v === 'object' && v !== null && typeof (v as { to?: unknown }).to === 'string'
      ? (v as { to: string }).to
      : null;
const fromOf = (v: unknown): string | undefined =>
  typeof v === 'object' && v !== null && typeof (v as { from?: unknown }).from === 'string'
    ? (v as { from: string }).from
    : undefined;

async function annotateInput(args: unknown[], overlayHost: () => Element | null): Promise<PageApiAnnotateInput> {
  const [selector, options] = args;
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 500)
    throw new PageApiError('annotate(selector, …): selector must be a CSS selector string');
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    throw new PageApiError(`annotate: "${selector}" is not a valid CSS selector`);
  }
  if (!el) throw new PageApiError(`annotate: no element matches "${selector}"`);
  const host = overlayHost();
  if (host && (el === host || host.contains(el)))
    throw new PageApiError('annotate: that element belongs to the review extension');
  const { note, edit } = readNote(el, options);
  const page = pageContext();
  const { bbox, snapshots, sourced } = snapshotElementWithSources(el);
  await sourced;
  return { selector, note, ...(edit ? { edit } : {}), bbox, snapshots, page };
}

export interface PageApiLink {
  /** Turns `window.__inkup` on (this tab records a Session) or off. */
  setEnabled(on: boolean): void;
  /** Stops answering calls: this copy of the content script is leaving the page (./instance.ts). */
  disconnect(): void;
}

export function connectPageApi(
  send: (req: PageApiRequest) => Promise<PageApiResult>,
  overlayHost: () => Element | null,
): PageApiLink {
  let enabled = false;
  const reply = (r: PageApiReply) =>
    document.dispatchEvent(new CustomEvent(PAGE_API_REPLY, { detail: JSON.stringify(r) }));
  const listening = new AbortController();
  const { signal } = listening;

  document.addEventListener(
    PAGE_API_CALL,
    (e) => {
      let call: PageApiCall;
      try {
        call = JSON.parse(String((e as CustomEvent).detail));
      } catch {
        return;
      }
      if (typeof call?.id !== 'string') return;
      const id = call.id;
      void (async () => {
        try {
          if (!enabled) throw new PageApiError('__inkup: no Session is recording this tab');
          const args = Array.isArray(call.args) ? call.args : [];
          const req: PageApiRequest | null =
            call.method === 'status'
              ? { method: 'status' }
              : call.method === 'list'
                ? { method: 'list' }
                : call.method === 'annotate'
                  ? { method: 'annotate', input: await annotateInput(args, overlayHost) }
                  : null;
          if (!req) throw new PageApiError(`__inkup: unknown method ${String(call.method)}`);
          const r = await send(req);
          reply(r.ok ? { id, ok: true, result: r.result } : { id, ok: false, error: r.error });
        } catch (err) {
          reply({
            id,
            ok: false,
            error:
              err instanceof PageApiError
                ? err.message
                : `__inkup: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    },
    { signal },
  );

  // A bridge injected after this script (tabs open at install) missed the state: tell it again.
  document.addEventListener(
    BRIDGE_READY,
    () => {
      if (enabled)
        document.dispatchEvent(new CustomEvent(PAGE_API_STATE, { detail: JSON.stringify({ enabled: true }) }));
    },
    { signal },
  );

  return {
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      document.dispatchEvent(new CustomEvent(PAGE_API_STATE, { detail: JSON.stringify({ enabled: on }) }));
    },
    disconnect: () => listening.abort(),
  };
}
