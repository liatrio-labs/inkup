// The design job's decision (ci.yml). `impeccable detect` exits 0 with no primary findings, 2 with primary
// findings, and 1 when a target cannot be scanned. Advisory mode reports primary findings and design-system-*
// drift and fails only when a scan cannot run. IMPECCABLE_MODE=blocking also fails on primary findings or
// design-system-* drift. The workflow sets advisory; the maintainer switches it.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type DesignFinding = {
  antipattern?: string;
  name?: string;
  description?: string;
  file?: string;
  line?: number;
  snippet?: string;
  advisory?: boolean;
};

export type FindingGroups = {
  primary: DesignFinding[];
  drift: DesignFinding[];
  advisory: DesignFinding[];
};

/** Primary findings, design-system drift, and advisory findings. Drift wins when an id is both. */
export function groupFindings(findings: readonly DesignFinding[]): FindingGroups {
  const primary: DesignFinding[] = [];
  const drift: DesignFinding[] = [];
  const advisory: DesignFinding[] = [];
  for (const finding of findings) {
    const id = finding.antipattern ?? '';
    if (id.startsWith('design-system-')) drift.push(finding);
    else if (finding.advisory === true) advisory.push(finding);
    else primary.push(finding);
  }
  return { primary, drift, advisory };
}

/**
 * Whether the design job fails. Exit 1, and any other exit besides 0 or 2, means the scan did not run.
 * Advisory never fails on findings. Blocking fails on exit 2, a primary finding, or design-system-* drift.
 */
export function scanShouldFail(scanExit: number, findings: readonly DesignFinding[], mode: string): boolean {
  if (scanExit !== 0 && scanExit !== 2) return true;
  if (mode !== 'blocking') return false;
  const groups = groupFindings(findings);
  return scanExit === 2 || groups.primary.length > 0 || groups.drift.length > 0;
}

/** Added diff lines that introduce an inline impeccable-disable comment. */
export function addedDisables(diff: string): string[] {
  const added: string[] = [];
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (line.includes('impeccable-disable')) added.push(line.slice(1).trim());
  }
  return added;
}

function oneLine(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/::/g, ' ').trim();
}

function annotation(finding: DesignFinding, kind: string): string {
  const file = (finding.file ?? '').replace(/[,:]/g, '');
  const line = finding.line && finding.line > 0 ? finding.line : 1;
  const id = finding.antipattern ?? 'finding';
  const snippet = finding.snippet ? ` ${finding.snippet}` : '';
  return `::warning file=${file},line=${line}::${oneLine(`${kind}: ${id}${snippet}`)}`;
}

export function summaryMarkdown(label: string, groups: FindingGroups, mode: string, scanExit: number): string {
  const lines = [
    `### ${label}`,
    '',
    `Mode \`${mode}\`. Scan exit ${scanExit}.`,
    `Primary ${groups.primary.length}. design-system drift ${groups.drift.length}. Advisory ${groups.advisory.length}.`,
    '',
  ];
  const show = (title: string, items: readonly DesignFinding[]) => {
    if (items.length === 0) return;
    lines.push(`#### ${title}`, '');
    for (const finding of items.slice(0, 40)) {
      const where = `${finding.file ?? '(no file)'}:${finding.line ?? 0}`;
      lines.push(`- \`${where}\` ${finding.antipattern ?? 'finding'}`);
    }
    if (items.length > 40) lines.push('', `${items.length - 40} more are in the log.`);
    lines.push('');
  };
  show('Primary', groups.primary);
  show('design-system drift', groups.drift);
  return `${lines.join('\n').trimEnd()}\n`;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

function asFindings(value: unknown): DesignFinding[] {
  if (!Array.isArray(value)) throw new Error('detect JSON was not an array');
  const findings: DesignFinding[] = [];
  for (const item of value) {
    if (typeof item === 'object' && item !== null) findings.push(item as DesignFinding);
  }
  return findings;
}

if (isDirectRun()) {
  const command = process.argv[2];
  if (command === 'disables') {
    for (const line of addedDisables(readFileSync(0, 'utf8'))) {
      process.stdout.write(`::warning::new impeccable-disable: ${oneLine(line)}\n`);
    }
    process.exit(0);
  }
  if (command === 'summarize') {
    const label = process.argv[3];
    const file = process.argv[4];
    const exitArg = process.argv[5];
    if (!label || !file || exitArg === undefined || !Number.isInteger(Number(exitArg))) {
      process.stderr.write('usage: node scripts/ci-design.ts summarize <label> <findings.json> <scan-exit>\n');
      process.exit(1);
    }
    let findings: DesignFinding[];
    try {
      findings = asFindings(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      process.stderr.write(`detect JSON could not be read: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
    const scanExit = Number(exitArg);
    const mode = process.env.IMPECCABLE_MODE || 'advisory';
    const groups = groupFindings(findings);
    const markdown = summaryMarkdown(label, groups, mode, scanExit);
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) appendFileSync(summaryPath, markdown);
    process.stdout.write(markdown);
    for (const finding of groups.primary.slice(0, 50)) process.stdout.write(`${annotation(finding, 'primary')}\n`);
    for (const finding of groups.drift.slice(0, 50)) process.stdout.write(`${annotation(finding, 'design-system')}\n`);
    process.exit(scanShouldFail(scanExit, findings, mode) ? 1 : 0);
  }
  process.stderr.write('usage: node scripts/ci-design.ts <disables|summarize>\n');
  process.exit(2);
}
