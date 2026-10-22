// The design job reports Impeccable findings and fails only when a scan cannot run, unless
// IMPECCABLE_MODE=blocking (scripts/ci-design.ts).
import { describe, expect, it } from 'vitest';
import {
  addedDisables,
  annotationLine,
  groupFindings,
  scanShouldFail,
  summaryMarkdown,
} from '../../scripts/ci-design.ts';

const primary = [{ antipattern: 'overused-font', file: 'a.css', line: 4, snippet: 'Inter' }];
const drift = [{ antipattern: 'design-system-color', file: 'a.css', line: 8, advisory: true }];
const advisory = [{ antipattern: 'em-dash-overuse', advisory: true }];

describe('scanShouldFail', () => {
  it('advisory reports findings and fails only when a scan cannot run', () => {
    expect(scanShouldFail(0, [], 'advisory')).toBe(false);
    expect(scanShouldFail(2, primary, 'advisory')).toBe(false);
    expect(scanShouldFail(0, drift, 'advisory')).toBe(false);
    expect(scanShouldFail(0, advisory, 'advisory')).toBe(false);
    expect(scanShouldFail(1, [], 'advisory')).toBe(true);
    expect(scanShouldFail(3, primary, 'advisory')).toBe(true);
  });

  it('blocking fails on primary findings, design-system drift, or exit 2', () => {
    expect(scanShouldFail(2, primary, 'blocking')).toBe(true);
    expect(scanShouldFail(0, drift, 'blocking')).toBe(true);
    expect(scanShouldFail(2, [], 'blocking')).toBe(true);
    expect(scanShouldFail(0, advisory, 'blocking')).toBe(false);
    expect(scanShouldFail(0, [], 'blocking')).toBe(false);
    expect(scanShouldFail(1, [], 'blocking')).toBe(true);
  });
});

describe('groupFindings', () => {
  it('keeps design-system drift out of the advisory bucket', () => {
    const groups = groupFindings([...primary, ...drift, ...advisory]);
    expect(groups.primary.map((finding) => finding.antipattern)).toEqual(['overused-font']);
    expect(groups.drift.map((finding) => finding.antipattern)).toEqual(['design-system-color']);
    expect(groups.advisory.map((finding) => finding.antipattern)).toEqual(['em-dash-overuse']);
  });
});

describe('addedDisables', () => {
  it('warns on any added marker in a UI file, including the forms the engine honours', () => {
    const diff = [
      'diff --git a/a.css b/a.css',
      '+++ b/a.css',
      '@@ -10,0 +11,5 @@',
      '+/* note: impeccable-disable-line design-system-color */',
      '-.b { } /* impeccable-disable */',
      '+ * impeccable-disable design-system-color',
      '+.b::after { content: "it\'s"; } /* impeccable-disable design-system-color -- owner\'s ok */',
      '+ok',
      'diff --git a/AGENTS.md b/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,0 +2 @@',
      '+An inline `impeccable-disable` needs the repo owner.',
      'diff --git a/tests/unit/ci-design.test.ts b/tests/unit/ci-design.test.ts',
      '+++ b/tests/unit/ci-design.test.ts',
      '@@ -1,0 +1 @@',
      "+  if (line.includes('impeccable-disable')) added.push(line);",
    ].join('\n');
    expect(addedDisables(diff)).toEqual([
      { file: 'a.css', line: 11, text: '/* note: impeccable-disable-line design-system-color */' },
      { file: 'a.css', line: 12, text: '* impeccable-disable design-system-color' },
      {
        file: 'a.css',
        line: 13,
        text: '.b::after { content: "it\'s"; } /* impeccable-disable design-system-color -- owner\'s ok */',
      },
    ]);
  });

  it('finishes a long quoted line without backtracking', () => {
    const nasty = `'${'\\&'.repeat(28)}`;
    const diff = ['+++ b/a.css', '@@ -1 +1 @@', `+${nasty}`].join('\n');
    const start = Date.now();
    expect(addedDisables(diff)).toEqual([]);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('annotationLine', () => {
  const workspace = '/home/runner/work/inkup/inkup';

  it('strips the checkout prefix from a source finding', () => {
    const line = annotationLine(
      { antipattern: 'overused-font', file: `${workspace}/apps/site/src/a.tsx`, line: 12, snippet: 'Inter' },
      'primary',
      workspace,
    );
    expect(line).toBe('::warning file=apps/site/src/a.tsx,line=12::primary: overused-font Inter');
    const markdown = summaryMarkdown(
      'source',
      groupFindings([{ antipattern: 'overused-font', file: `${workspace}/apps/site/src/a.tsx`, line: 12 }]),
      'advisory',
      2,
      workspace,
    );
    expect(markdown).toContain('`apps/site/src/a.tsx:12`');
    expect(markdown).not.toContain(workspace);
  });

  it('omits file= for a URL and keeps the colons', () => {
    const line = annotationLine(
      { antipattern: 'skipped-heading', file: 'http://127.0.0.1:4173/', line: 0, snippet: 'h1' },
      'primary',
    );
    expect(line.startsWith('::warning::')).toBe(true);
    expect(line).not.toContain('file=');
    expect(line).toContain('http://127.0.0.1:4173/');
  });
});

describe('summaryMarkdown', () => {
  it('names primary findings and design-system drift', () => {
    const markdown = summaryMarkdown('source', groupFindings([...primary, ...drift]), 'advisory', 2);
    expect(markdown).toContain('### source');
    expect(markdown).toContain('Primary 1');
    expect(markdown).toContain('design-system drift 1');
    expect(markdown).toContain('overused-font');
    expect(markdown).toContain('design-system-color');
  });
});
