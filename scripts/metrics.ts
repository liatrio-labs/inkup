// `pnpm metrics <dir-or-file>… [--json]`: PRD §8 metrics over exported session.json files (packages/core/src/metrics.ts).
// Directories are searched recursively for *.json files that are Sessions (they have schema_version and events).
// Older schema versions are read too: the fields added since default.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateMetrics, formatMetrics, type SessionMetrics, sessionMetrics } from '../packages/core/src/metrics.ts';
import { SessionDocumentSchema } from '../packages/core/src/session-document.ts';
import { SCHEMA_VERSION } from '../packages/core/src/timeline.ts';

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .flatMap((f) => (f === 'node_modules' || f.startsWith('.') ? [] : files(join(path, f))))
    .filter((f) => f.endsWith('.json'));
}

export function loadMetrics(paths: readonly string[]): {
  metrics: SessionMetrics[];
  skipped: { file: string; why: string }[];
} {
  const metrics: SessionMetrics[] = [];
  const skipped: { file: string; why: string }[] = [];
  const seen = new Set<string>();
  for (const file of paths.flatMap(files)) {
    let raw: { schema_version?: unknown; events?: unknown };
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      skipped.push({ file, why: 'not JSON' });
      continue;
    }
    if (typeof raw?.schema_version !== 'number' || !Array.isArray(raw.events)) continue; // not a session.json
    const parsed = SessionDocumentSchema.safeParse({ ...raw, schema_version: SCHEMA_VERSION });
    if (!parsed.success) {
      skipped.push({
        file,
        why: parsed.error.issues
          .slice(0, 2)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      });
      continue;
    }
    // The same Session exported twice counts once (the later file wins).
    const m = sessionMetrics(parsed.data);
    if (seen.has(m.session_id))
      metrics.splice(
        metrics.findIndex((x) => x.session_id === m.session_id),
        1,
      );
    seen.add(m.session_id);
    metrics.push(m);
  }
  return { metrics, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter((a) => a !== '--json');
  if (paths.length === 0) {
    console.error('usage: pnpm metrics <dir-or-session.json>… [--json]');
    process.exit(2);
  }
  const { metrics, skipped } = loadMetrics(paths);
  const report = aggregateMetrics(metrics);
  if (json) console.log(JSON.stringify({ report, sessions: metrics, skipped }, null, 2));
  else {
    for (const line of formatMetrics(report)) console.log(line);
    for (const s of skipped) console.error(`skipped ${s.file}: ${s.why}`);
  }
}
