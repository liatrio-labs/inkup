// The tracker registry: every Client's settings and send UI is driven by it, so each entry must name its fields,
// build its adapter from what was entered (against a stub), and say what leaves the machine.
import { afterEach, describe, expect, it } from 'vitest';
import { startGithubStub } from '../../../../tests/support/github-stub';
import { startJiraStub } from '../../../../tests/support/jira-stub';
import { startLinearStub } from '../../../../tests/support/linear-stub';
import { TRACKERS, trackerDefinition } from '../../src/trackers';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('TRACKERS', () => {
  it('lists GitHub, Linear then Jira, each with a secret token field, its words and a notice', () => {
    expect(TRACKERS.map((t) => t.tracker)).toEqual(['github', 'linear', 'jira']);
    for (const t of TRACKERS) {
      expect(trackerDefinition(t.tracker)).toBe(t);
      expect(t.fields.find((f) => f.id === 'token')).toMatchObject({ secret: true });
      expect(t.notice.title).toBe(`What goes to ${t.label}`);
      expect(t.destinationLabel).toMatch(/^Default /);
      expect(t.help).not.toMatch(/ticket/i);
      expect(t.notice.body).not.toMatch(/ticket/i);
    }
  });

  it('builds the adapter for the base URL it is given, with the credentials from the values', async () => {
    const github = await startGithubStub({ token: 'gh-token', repos: [{ full_name: 'acme/web' }] });
    const linear = await startLinearStub({ key: 'lin-key' });
    closers.push(github.close, linear.close);
    const values = { token: ' gh-token ', destination: 'acme/web' };
    const gh = trackerDefinition('github')!;
    expect(gh.credentials(values)).toEqual({ token: 'gh-token' });
    const repos = await gh
      .adapter(fetch, { ...values, baseUrl: github.baseURL })
      .listDestinations(gh.credentials(values));
    expect(repos).toEqual([{ id: 'acme/web', name: 'acme/web' }]);

    const lin = trackerDefinition('linear')!;
    const teams = await lin
      .adapter(fetch, { token: 'lin-key', destination: '', baseUrl: linear.baseURL })
      .listDestinations(lin.credentials({ token: 'lin-key' }));
    expect(teams.map((t) => t.id)).toEqual(['team-web']);
  });

  it("builds Jira's adapter from the site, email and issue type, and refuses a site that is not Atlassian Cloud", async () => {
    const jira = await startJiraStub({ email: 'me@example.com', token: 'jira-token' });
    closers.push(jira.close);
    const def = trackerDefinition('jira')!;
    expect(def.fields.map((f) => [f.id, f.secret])).toEqual([
      ['site', false],
      ['email', false],
      ['token', true],
    ]);
    const values = { site: 'https://acme.atlassian.net', email: 'me@example.com', token: ' jira-token ' };
    expect(def.credentials(values)).toEqual({ token: 'jira-token' });
    // The dev override (baseUrl) stands in for the site; without it the site is used, and must be Atlassian's.
    const projects = await def
      .adapter(fetch, { ...values, baseUrl: jira.baseURL })
      .listDestinations(def.credentials(values));
    expect(projects.map((p) => p.id)).toEqual(['ABC']);
    expect(() => def.adapter(fetch, { ...values, site: 'https://jira.example.com' })).toThrow('atlassian.net');
    expect(() => def.adapter(fetch, values)).not.toThrow();
  });
});

describe('a rate limit', () => {
  it('carries how long GitHub asked to wait, so a bulk send can pause', async () => {
    const github = await startGithubStub({ repos: [{ full_name: 'acme/web' }] });
    closers.push(github.close);
    github.fail(() => ({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '3' } }));
    const adapter = trackerDefinition('github')!.adapter(fetch, { token: 't', baseUrl: github.baseURL });
    await expect(adapter.createIssue({ token: 't' }, 'acme/web', { title: 'T', body: 'B' })).rejects.toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 3000,
    });
  });
});
