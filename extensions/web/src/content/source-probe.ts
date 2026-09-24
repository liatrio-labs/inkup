// The isolated side of the source probe (E4, src/bridge/protocol.ts): tags the elements, asks the MAIN-world bridge,
// and removes the tags. The bridge answers inside dispatchEvent, so the result is normally there at once; the
// timeout covers a bridge that answers late. A page where the bridge never answered (it could not load there) is
// remembered, so later probes do not each wait out the timeout, until the bridge announces itself.
import {
  BRIDGE_READY,
  PROBE_ATTR,
  SOURCE_PROBE,
  SOURCE_RESULT,
  type SourceInfo,
  type SourceResult,
} from '@/bridge/protocol';

export const PROBE_TIMEOUT_MS = 1500;

let bridgeMissing = false;
let listening = false;
const pending = new Map<string, (results: (SourceInfo | null)[]) => void>();

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener(BRIDGE_READY, () => (bridgeMissing = false));
  document.addEventListener(SOURCE_RESULT, (e) => {
    let answer: SourceResult;
    try {
      answer = JSON.parse(String((e as CustomEvent).detail));
    } catch {
      return;
    }
    const done = pending.get(answer.id);
    if (done && Array.isArray(answer.results)) done(answer.results);
  });
}

const clean = (s: SourceInfo | null | undefined): SourceInfo | null => {
  if (!s || typeof s !== 'object') return null;
  const file = typeof s.file === 'string' && s.file.length <= 500 ? s.file : undefined;
  const line = Number.isInteger(s.line) && s.line! > 0 ? s.line : undefined;
  const components = Array.isArray(s.components)
    ? s.components.filter((c): c is string => typeof c === 'string' && c.length <= 100).slice(0, 8)
    : [];
  return file || components.length ? { ...(file ? { file } : {}), ...(line ? { line } : {}), components } : null;
};

/** Each element's source, in order (null: nothing known). Resolves at once when the bridge answers synchronously. */
export function probeSources(
  elements: readonly Element[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<(SourceInfo | null)[]> {
  const none = () => elements.map(() => null);
  if (elements.length === 0 || bridgeMissing) return Promise.resolve(none());
  listen();
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (results: (SourceInfo | null)[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      if (results === null) bridgeMissing = true;
      resolve(results ? elements.map((_, i) => clean(results[i])) : none());
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    pending.set(id, finish);
    elements.forEach((el, i) => {
      el.setAttribute(PROBE_ATTR, `${id}:${i}`);
    });
    try {
      document.dispatchEvent(new CustomEvent(SOURCE_PROBE, { detail: JSON.stringify({ id }) }));
    } finally {
      for (const el of elements) el.removeAttribute(PROBE_ATTR);
    }
  });
}
