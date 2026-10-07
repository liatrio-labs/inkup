// Jira's site is checked before it is saved: an Atlassian Cloud site, tidied, unless a development build points at a
// stub. A release build ignores the override, so a site that is not Atlassian's is refused there.
import { describe, expect, it } from 'vitest';
import { STORES } from '@/lib/trackers';

const prepare = STORES.jira!.prepare!;
const stub = { jiraBaseUrl: 'http://127.0.0.1:4569' };

describe('Jira site check', () => {
  it('tidies an Atlassian Cloud site', () => {
    expect(prepare('site', ' Acme.atlassian.net/ ', null)).toEqual({ value: 'https://acme.atlassian.net' });
  });

  it('refuses any other site, and says what it must look like; a development build with a stub does not check', () => {
    expect(prepare('site', 'https://jira.example.com', null)).toEqual({
      error: expect.stringContaining('https://<your-team>.atlassian.net'),
    });
    expect(prepare('site', 'http://127.0.0.1:1', stub)).toEqual({ value: 'http://127.0.0.1:1' });
  });

  it('leaves the other fields as they are', () => {
    expect(prepare('email', 'me@example.com', null)).toEqual({ value: 'me@example.com' });
    expect(prepare('token', 'abc', null)).toEqual({ value: 'abc' });
  });
});
