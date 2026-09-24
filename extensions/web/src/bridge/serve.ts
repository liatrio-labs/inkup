// The bridge's answer to a source probe (src/bridge/protocol.ts), run in the MAIN world.
import { PROBE_ATTR, SOURCE_PROBE, SOURCE_RESULT, type SourceResult } from './protocol';
import { readSource } from './source';

export function serveSourceProbes(doc: Document = document): void {
  doc.addEventListener(SOURCE_PROBE, (e) => {
    let id: string;
    try {
      id = String(JSON.parse(String((e as CustomEvent).detail)).id);
    } catch {
      return;
    }
    const results: SourceResult['results'] = [];
    for (const el of doc.querySelectorAll(`[${PROBE_ATTR}^="${CSS.escape(id)}:"]`)) {
      const index = Number(el.getAttribute(PROBE_ATTR)!.slice(id.length + 1));
      if (Number.isInteger(index) && index >= 0 && index < 1000) results[index] = readSource(el);
    }
    const answer: SourceResult = { id, results: Array.from(results, (r) => r ?? null) };
    doc.dispatchEvent(new CustomEvent(SOURCE_RESULT, { detail: JSON.stringify(answer) }));
  });
}
