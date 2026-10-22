// The pull request title becomes the squash commit, and release-please reads that (CONTRIBUTING.md). The header
// rules are the ones @commitlint/config-conventional applies to a subject line: a known type, an optional
// lower-case scope, a subject, at most 100 characters, and no trailing period. Sentence case, start case, PascalCase
// and UPPER CASE subjects are refused; a subject that starts with a lowercase word or an acronym is not.
import { pathToFileURL } from 'node:url';

const TYPES = new Set(['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test']);

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9-]+)\))?(?<breaking>!)?: (?<subject>.+)$/;

export type TitleCheck = { ok: true } | { ok: false; errors: string[] };

function subjectCase(subject: string): string | null {
  const words = subject.split(/\s+/).filter(Boolean);
  const letters = subject.replace(/[^A-Za-z]/g, '');
  if (letters.length > 0 && letters === letters.toUpperCase()) return 'upper-case';
  if (!subject.includes(' ') && /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(subject)) return 'pascal-case';
  if (words.length > 1 && words.every((word) => /^[A-Z][a-z0-9]*$/.test(word))) return 'start-case';
  if (/^[A-Z][a-z]/.test(subject)) return 'sentence-case';
  return null;
}

/** Whether `title` is a Conventional Commit header. */
export function checkTitle(title: string): TitleCheck {
  const errors: string[] = [];
  if (title !== title.trim() || title.includes('\n')) errors.push('title must be a single line');
  const header = title.trim();
  if (header.length > 100) errors.push('header must be at most 100 characters');
  const match = HEADER.exec(header);
  if (!match?.groups) {
    errors.push('title must be a Conventional Commit header: type(scope): subject');
    return { ok: false, errors };
  }
  const { type, scope, subject } = match.groups;
  if (!TYPES.has(type ?? '')) errors.push(`unknown type "${type}"`);
  if (scope !== undefined && !/^[a-z0-9-]+$/.test(scope)) errors.push('scope must be lower-case');
  if (!subject?.trim()) errors.push('subject must not be empty');
  else if (subject.endsWith('.')) errors.push('subject must not end with a period');
  else {
    const badCase = subjectCase(subject);
    if (badCase) errors.push(`subject must not be ${badCase}`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const result = checkTitle(process.env.PR_TITLE ?? '');
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    process.exit(1);
  }
}
