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
  it('warns on added impeccable-disable lines and ignores removals', () => {
    const diff = [
      '+++ b/a.css',
      '+.a { color: red } /* impeccable-disable-line overused-font */',
      '-.b { } /* impeccable-disable */',
      '+ok',
      '+/* impeccable-disable design-system-color */',
    ].join('\n');
    expect(addedDisables(diff)).toEqual([
      '.a { color: red } /* impeccable-disable-line overused-font */',
      '/* impeccable-disable design-system-color */',
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
