// The Jira adapter against tests/support/jira-stub.ts, over real HTTP with Node's fetch: the order of a send (create,
// then attach each screenshot, then update the description), Basic auth on every request, the issue type choice,
// Test's checks, status from name and category, the site check, and the errors in plain words.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type JiraStub, startJiraStub } from '../../../../tests/support/jira-stub';
import {
  chooseIssueType,
  type IssueItem,
  type JiraAdapter,
  jiraAdapter,
  parseJiraSite,
  pushItem,
  TrackerError,
} from '../../src/trackers';

const EMAIL = 'reviewer@example.com';
const TOKEN = 'jira-test-token';
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
const creds = { token: TOKEN };
const SESSION = { id: 'sess-1', name: 'Pricing page review' };
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n + 1, n + 2]);

const item = (screenshots: string[], category = 'style'): IssueItem => ({
  id: 'item_0001',
  title: 'Make the Get started button larger',
  category,
  intent: 'Too small.',
  locations: [{ role: 'subject', element: "button 'Get started'", url: '/pricing.html' }],
  transcript: 'make it bigger',
  agent_prompt: `Enlarge it. ${screenshots.map((s) => `screenshots/${s}.png`).join(' ')}`,
  evidence: { screenshots },
});

let stub: JiraStub;
let jira: JiraAdapter;
const make = (issueType?: string) =>
  jiraAdapter({ fetch, baseUrl: stub.baseURL, email: EMAIL, issueType, siteUrl: 'https://acme.atlassian.net' });
beforeEach(async () => {
  stub = await startJiraStub({
    email: EMAIL,
    token: TOKEN,
    projects: [
      { key: 'ABC', name: 'Alpha' },
      { key: 'BUG', name: 'Only tasks', issueTypes: ['Task'] },
      { key: 'RO', name: 'Read only', can_create: false, can_attach: false },
      { key: 'NOATT', name: 'No attachments', can_attach: false },
    ],
  });
  jira = make();
});
afterEach(() => stub.close());

/** The requests that change something, as `METHOD /path`. */
const writes = () => stub.sequence().filter((s) => !s.startsWith('GET'));

describe('jiraAdapter send', () => {
  it('creates the issue, attaches each screenshot, then updates the description, all with Basic auth', async () => {
    const link = await pushItem({
      adapter: jira,
      credentials: creds,
      destination: 'ABC',
      item: item(['s1', 's2']),
      session: SESSION,
      images: [
        { id: 's1', bytes: png(1) },
        { id: 's2', bytes: png(2) },
      ],
      now: () => new Date('2026-10-07T10:00:00.000Z'),
    });
    expect(link).toEqual({
      tracker: 'jira',
      destination: 'ABC',
      key: 'ABC-1',
      url: 'https://acme.atlassian.net/browse/ABC-1',
      created_at: '2026-10-07T10:00:00.000Z',
    });
    expect(writes()).toEqual([
      'POST /issue',
      'POST /issue/ABC-1/attachments',
      'POST /issue/ABC-1/attachments',
      'PUT /issue/ABC-1',
    ]);
    for (const r of stub.requests) expect(r.headers.authorization).toBe(BASIC);
    for (const r of stub.calls('POST', /\/attachments$/)) expect(r.headers['x-atlassian-token']).toBe('no-check');

    const created = stub.calls('POST', /\/issue$/)[0]!.body.fields;
    expect(created.project).toEqual({ key: 'ABC' });
    expect(created.issuetype).toEqual({ name: 'Task' });
    expect(created.summary).toBe('Make the Get started button larger');
    expect(JSON.stringify(created.description)).not.toContain('attachment/content');

    const issue = stub.issues[0]!;
    expect(issue.attachments.map((a) => a.filename)).toEqual(['s1.png', 's2.png']);
    const text = JSON.stringify(issue.description);
    expect(text).toContain(`${stub.baseURL}/rest/api/3/attachment/content/${issue.attachments[0]!.id}`);
    expect(text).toContain(`${stub.baseURL}/rest/api/3/attachment/content/${issue.attachments[1]!.id}`);
    expect(text).not.toContain('screenshots/s1.png');
    expect(text).toContain('Sent from InkUp · Pricing page review · item_0001');
  });

  it('creates an item with no images once, with nothing to attach or update', async () => {
    await pushItem({
      adapter: jira,
      credentials: creds,
      destination: 'ABC',
      item: item([]),
      session: SESSION,
      images: [],
    });
    expect(writes()).toEqual(['POST /issue']);
  });

  it.each([
    [['Task', 'Bug'], 'bug', undefined, 'Bug'],
    [['Task'], 'bug', undefined, 'Task'],
    [['Task', 'Bug'], 'style', undefined, 'Task'],
    [['Task', 'Bug'], 'style', 'bug', 'Bug'],
    [['Story'], 'style', undefined, 'Story'],
  ])('chooses the issue type from %j, category %s, picked %s: %s', (types, category, picked, want) => {
    expect(chooseIssueType(types, category, picked)).toBe(want);
  });

  it('sends a bug as a Bug when the project has the type, and as a Task when it does not', async () => {
    const send = (destination: string, adapter = jira) =>
      pushItem({ adapter, credentials: creds, destination, item: item([], 'bug'), session: SESSION, images: [] });
    await send('ABC');
    await send('BUG');
    expect(stub.issues.map((i) => i.issuetype)).toEqual(['Bug', 'Task']);
    await send('ABC', make('Story'));
    expect(stub.issues[2]!.issuetype).toBe('Story');
    await expect(send('BUG', make('Story'))).rejects.toThrow('This project has no "Story" issue type');
  });

  it('says which permission is missing, and names the issue when screenshots fail after it exists', async () => {
    const send = (destination: string) =>
      pushItem({
        adapter: jira,
        credentials: creds,
        destination,
        item: item(['s1']),
        session: SESSION,
        images: [{ id: 's1', bytes: png(1) }],
      });
    await expect(send('RO')).rejects.toMatchObject({
      kind: 'permission',
      message: expect.stringContaining('This account can\'t create issues in "RO"'),
    });
    const err = await send('NOATT').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerError);
    expect((err as TrackerError).message).toContain('NOATT-1 was created in Jira');
    expect((err as TrackerError).message).toContain("can't add attachments");
    expect((err as TrackerError).message).toContain('https://acme.atlassian.net/browse/NOATT-1');
  });

  it('turns a rejected token and an unreachable site into messages that say what to do', async () => {
    const wrong = jiraAdapter({ fetch, baseUrl: stub.baseURL, email: EMAIL });
    await expect(wrong.listDestinations({ token: 'nope' })).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringContaining('Enter a new one in Trackers settings'),
    });
    const down = jiraAdapter({
      fetch: () => Promise.reject(new Error('refused')),
      baseUrl: stub.baseURL,
      email: EMAIL,
    });
    await expect(down.listDestinations(creds)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('jiraAdapter reads', () => {
  it("lists the projects and a project's issue types (not sub-tasks)", async () => {
    const projects = await jira.listDestinations(creds);
    expect(projects.map((d) => d.id)).toEqual(['ABC', 'BUG', 'RO', 'NOATT']);
    expect(projects[0]).toEqual({ id: 'ABC', name: 'Alpha (ABC)' });
    expect(await jira.listIssueTypes(creds, 'ABC')).toEqual(['Task', 'Bug', 'Story']);
  });

  it('Test checks the token, the project and the permissions to create and attach', async () => {
    const ok = await jira.test(creds, 'ABC');
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.id)).toEqual(['token', 'project', 'create', 'attach']);
    const ro = await jira.test(creds, 'RO');
    expect(ro.ok).toBe(false);
    expect(ro.checks.find((c) => c.id === 'create')).toMatchObject({
      ok: false,
      message: expect.stringContaining('This account can\'t create issues in "RO"'),
    });
    const missing = await jira.test(creds, 'ZZZ');
    expect(missing.checks.at(-1)).toMatchObject({ id: 'project', ok: false });
    const bad = await jira.test({ token: 'nope' }, 'ABC');
    expect(bad.checks).toHaveLength(1);
    expect(bad.checks[0]).toMatchObject({ id: 'token', ok: false });
  });

  it.each([
    ['To Do', 'new', { state: 'open', name: 'To Do', category: 'new' }],
    ['In Progress', 'indeterminate', { state: 'open', name: 'In Progress', category: 'indeterminate' }],
    ['Done', 'done', { state: 'closed', reason: null, name: 'Done', category: 'done' }],
  ] as const)('reads status "%s" (category %s) from the status name and its category', async (name, category, want) => {
    await jira.createIssue(creds, 'ABC', { title: 'T', body: 'B' });
    Object.assign(stub.issues[0]!.status, { name, category });
    expect(await jira.getStatus(creds, { destination: 'ABC', key: 'ABC-1' })).toEqual(want);
    await expect(jira.getStatus(creds, { destination: 'ABC', key: 'ABC-9' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('parseJiraSite', () => {
  it.each([
    ['https://acme.atlassian.net', 'https://acme.atlassian.net'],
    ['https://Acme.atlassian.net/', 'https://acme.atlassian.net'],
    ['acme.atlassian.net', 'https://acme.atlassian.net'],
    ['acme', 'https://acme.atlassian.net'],
    ['  https://acme-co.atlassian.net  ', 'https://acme-co.atlassian.net'],
  ])('accepts %s', (input, want) => expect(parseJiraSite(input)).toBe(want));

  it.each([
    'https://jira.example.com',
    'http://acme.atlassian.net',
    'https://acme.atlassian.net.evil.com',
    'https://evil.com/acme.atlassian.net',
    'https://user:pw@acme.atlassian.net',
    'https://acme.atlassian.net:8443',
    'https://acme.atlassian.net/jira',
    'https://atlassian.net',
    '',
  ])('refuses %j', (input) => expect(parseJiraSite(input)).toBeNull());
});
