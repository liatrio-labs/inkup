// The design job reports Impeccable findings and fails only when a scan cannot run, unless
// IMPECCABLE_MODE=blocking (scripts/ci-design.ts).
import { describe, expect, it } from 'vitest';
import { addedDisables, groupFindings, scanShouldFail, summaryMarkdown } from '../../scripts/ci-design.ts';

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
  it('warns on added disable comments and ignores removals, prose and strings', () => {
    const diff = [
      'diff --git a/a.css b/a.css',
      '+++ b/a.css',
      '@@ -10,0 +11,4 @@',
      '+.a { color: red } /* impeccable-disable-line overused-font */',
      '-.b { } /* impeccable-disable */',
      '+ok',
      '+/* impeccable-disable design-system-color */',
      '+// impeccable-disable overused-font: owner approved, conversation 2026-10-22 2:20 PM CT',
      'diff --git a/AGENTS.md b/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -1,0 +2,2 @@',
      '+An inline `impeccable-disable` needs the repo owner.',
      '+<!-- An inline impeccable-disable is allowed only with approval. -->',
      'diff --git a/tests/unit/ci-design.test.ts b/tests/unit/ci-design.test.ts',
      '+++ b/tests/unit/ci-design.test.ts',
      '@@ -1,0 +1,2 @@',
      "+  '+.a { color: red } /* impeccable-disable-line overused-font */',",
      "+  if (line.includes('impeccable-disable')) added.push(line);",
    ].join('\n');
    expect(addedDisables(diff)).toEqual([
      { file: 'a.css', line: 11, text: '.a { color: red } /* impeccable-disable-line overused-font */' },
      { file: 'a.css', line: 13, text: '/* impeccable-disable design-system-color */' },
      {
        file: 'a.css',
        line: 14,
        text: '// impeccable-disable overused-font: owner approved, conversation 2026-10-22 2:20 PM CT',
      },
    ]);
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
