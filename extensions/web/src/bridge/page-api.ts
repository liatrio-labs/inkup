// The page API's page side (E5), run in the MAIN world by the bridge: `window.__inkup` exists only while the
// overlay says this tab is being recorded. Each call goes to the overlay over DOM events (./protocol.ts), which
// checks it against the live Session with the service worker; nothing here is trusted.
import {
  PAGE_API_CALL,
  PAGE_API_GLOBAL,
  PAGE_API_HELP,
  PAGE_API_REPLY,
  PAGE_API_STATE,
  type PageApiCall,
  type PageApiMethod,
  type PageApiReply,
} from './protocol';

export const PAGE_API_TIMEOUT_MS = 15_000;

export function servePageApi(win: Window = window): void {
  const doc = win.document;
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();

  doc.addEventListener(PAGE_API_REPLY, (e) => {
    let reply: PageApiReply;
    try {
      reply = JSON.parse(String((e as CustomEvent).detail));
    } catch {
      return;
    }
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    if (reply.ok) call.resolve(reply.result);
    else call.reject(new Error(reply.error));
  });

  const call = (method: PageApiMethod, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      let detail: string;
      try {
        detail = JSON.stringify({ id, method, args } satisfies PageApiCall);
      } catch {
        reject(new TypeError('__inkup: arguments must be plain JSON values'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('__inkup: no answer from the extension'));
      }, PAGE_API_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      doc.dispatchEvent(new CustomEvent(PAGE_API_CALL, { detail }));
    });

  const api = Object.freeze({
    help: () => PAGE_API_HELP,
    status: () => call('status', []),
    annotate: (selector: string, options: unknown) => call('annotate', [selector, options]),
    list: () => call('list', []),
  });

  doc.addEventListener(PAGE_API_STATE, (e) => {
    let enabled = false;
    try {
      enabled = JSON.parse(String((e as CustomEvent).detail)).enabled === true;
    } catch {
      return;
    }
    const w = win as unknown as Record<string, unknown>;
    if (enabled)
      Object.defineProperty(win, PAGE_API_GLOBAL, {
        value: api,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    else if (w[PAGE_API_GLOBAL] === api) delete w[PAGE_API_GLOBAL];
    if (!enabled)
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('__inkup: the Session ended'));
      }
  });
}
