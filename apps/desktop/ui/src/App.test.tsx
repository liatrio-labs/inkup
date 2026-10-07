// @vitest-environment happy-dom
// The window against the contract's fixture (contract/fixtures/host-control/control-state.json), through the real
// App and host.ts: only the app's commands (Tauri IPC) are mocked, as the Rust side would answer them. Tracker push
// runs the real send controls and pushItem against a stubbed GitHub adapter, registered in place of the real one,
// and against the real Jira adapter on a stubbed tauri-plugin-http fetch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ImageUpload, type IssueDraft, TRACKERS, type TrackerDefinition } from '@inkup/core/trackers';
import { ControlState, type FullItem, type ItemView, type TrackerLink } from '@inkup/protocol/host-control';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, TABS } from './App';
import type { CliStatus, HostView, Toggles } from './host';
import { resetTrackerSends } from './send-to-tracker';
import { resetTrackerSetups } from './trackers';

/** The stubbed GitHub: what it was sent, and how it answers. */
const stub = vi.hoisted(() => ({
  /** The fetch the registry gave the adapter: tauri-plugin-http's. */
  fetch: null as null | ((input: string) => Promise<unknown>),
  tokens: [] as string[],
  uploads: [] as { destination: string; session: string; id: string; bytes: number[] }[],
  issues: [] as { destination: string; title: string; body: string }[],
  /** Titles whose issue creation fails. */
  failing: new Set<string>(),
  /** While set, each issue waits until it is released. */
  hold: false,
  waiting: [] as (() => void)[],
  statusFails: false,
  contentsWrite: true,
  /** The real Linear and Jira entries: a test adds them to TRACKERS to run them on a stubbed fetch. */
  others: [] as TrackerDefinition[],
}));
const pluginFetch = vi.hoisted(() => vi.fn(async (_input: string, _init?: RequestInit) => new Response('{}')));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: pluginFetch }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('@inkup/core/trackers', async (importOriginal) => {
  const real = await importOriginal<typeof import('@inkup/core/trackers')>();
  const github = real.TRACKERS.find((t) => t.tracker === 'github') as TrackerDefinition;
  const definition: TrackerDefinition = {
    ...github,
    adapter: (fetch) => {
      stub.fetch = fetch as unknown as (input: string) => Promise<unknown>;
      return {
        tracker: 'github',
        label: 'GitHub',
        test: async (c, destination) => {
          stub.tokens.push(c.token);
          const token = { id: 'token', ok: true, message: 'The token works.' };
          if (stub.contentsWrite) return { ok: true, checks: [token] };
          const contents = {
            id: 'contents',
            ok: false,
            message: `This token can't write to ${destination}. Give it Contents: read and write.`,
          };
          return { ok: false, checks: [token, contents] };
        },
        listDestinations: async () => [{ id: 'acme/web', name: 'acme/web' }],
        uploadImages: async (c, destination, session, images: readonly ImageUpload[]) => {
          stub.tokens.push(c.token);
          for (const i of images) stub.uploads.push({ destination, session, id: i.id, bytes: [...i.bytes] });
          return new Map(images.map((i) => [i.id, `https://github.com/${destination}/blob/inkup-assets/${i.id}.png`]));
        },
        createIssue: async (c, destination, issue: IssueDraft) => {
          stub.tokens.push(c.token);
          if (stub.hold) await new Promise<void>((resolve) => stub.waiting.push(resolve));
          if (stub.failing.has(issue.title))
            throw new real.TrackerError(
              'permission',
              `This token can't create issues in ${destination}. Give it Issues: read and write.`,
            );
          stub.issues.push({ destination, title: issue.title, body: issue.body });
          const n = stub.issues.length;
          return { tracker: 'github', destination, key: `#${n}`, url: `https://github.com/${destination}/issues/${n}` };
        },
        getStatus: async () => {
          if (stub.statusFails) throw new real.TrackerError('network', "Couldn't reach GitHub.");
          return { state: 'open' };
        },
      };
    },
  };
  stub.others = real.TRACKERS.filter((t) => t.tracker !== 'github');
  return { ...real, TRACKERS: [definition] };
});

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '../../../../contract/fixtures/host-control', name), 'utf8'));

/** The fixture as the contract reads it, with `patch` over it. */
const state = (patch: Partial<ControlState> = {}): ControlState => ({
  ...ControlState.parse(fixture('control-state.json')),
  ...patch,
});

const HOST: HostView = { mode: 'host', kind: 'desktop', address: '127.0.0.1:47823', data_dir: '/tmp/inkup' };
const CLIENT: HostView = { mode: 'client', kind: 'serve', address: '127.0.0.1:47823', data_dir: '/tmp/inkup' };

type Call = { cmd: string; args: Record<string, unknown> };

/** Mocks the app's commands. `answers` overrides one: a function of its args, or a value. */
function app(view: HostView, host: ControlState | (() => ControlState), answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let toggles: Toggles = { menubar: true, dock: true };
  let changes = 0;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd in answers) {
        const answer = answers[cmd];
        return typeof answer === 'function' ? answer(args) : answer;
      }
      switch (cmd) {
        case 'host_view':
          return view;
        case 'host_state':
          return typeof host === 'function' ? host() : host;
        // The first long-poll answers at once; the next waits, as a host with no change does.
        case 'host_changes':
          return changes++ === 0 ? 1 : new Promise(() => {});
        case 'desktop_toggles':
          return toggles;
        case 'set_desktop_toggles':
          toggles = (args as { toggles: Toggles }).toggles;
          return toggles;
        case 'pairing_qr':
          return '<svg xmlns="http://www.w3.org/2000/svg"/>';
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  render(<App />);
  return calls;
}

/** Radix Tabs switch on mouse down. */
function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

beforeEach(() => {
  // A fixed clock, so the "ago" words hold.
  Date.now = () => 1_790_124_400_000;
});

afterEach(() => {
  cleanup();
  clearMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetTrackerSetups();
  resetTrackerSends();
  Object.assign(stub, {
    fetch: null,
    tokens: [],
    uploads: [],
    issues: [],
    failing: new Set(),
    hold: false,
    waiting: [],
    statusFails: false,
    contentsWrite: true,
  });
  TRACKERS.splice(1);
  pluginFetch.mockReset();
  pluginFetch.mockImplementation(async () => new Response('{}'));
});

describe('the window, from the contract fixture', () => {
  it('renders every tab', async () => {
    app(CLIENT, state({ pending_pairing: [] }));
    await screen.findByText('Pricing Fixture');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Clients (2)',
      'Sessions (1)',
      'Timeline',
      'Items (1)',
      'Agents (1)',
      'Tokens (1)',
      'Trackers',
    ]);
    expect(TABS).toHaveLength(7);

    const panel = () => screen.getByRole('tabpanel');
    const seen: Record<string, string[]> = {
      Clients: [
        'Chrome on MacBook',
        'connected, recording',
        'Firefox on studio-mac',
        'paired',
        'Pause',
        'Stop',
        'Draw',
      ],
      Sessions: ['Pricing Fixture', 'live', '0/1', 'Timeline'],
      Timeline: [
        '00:01',
        'make this bigger',
        "#1 on button 'Get started'",
        'started on http://localhost:4401/pricing.html',
      ],
      Items: ['item-1', 'in work', 'Make the Get started button bigger', 'claude-code, just now'],
      Agents: ['watch #1', 'http://localhost:4401', 'any Session'],
      Tokens: ['codex on desktop', 'a-0f1e2d3c', 'never', 'New token', 'Revoke'],
    };
    for (const [tab, texts] of Object.entries(seen)) {
      openTab(new RegExp(`^${tab}`));
      for (const text of texts) expect(within(panel()).getAllByText(text).length, `${tab}: ${text}`).toBeGreaterThan(0);
    }
  });

  it('shows the header: client mode, the network warning and the update notice', async () => {
    app(CLIENT, state({ pending_pairing: [] }));
    expect(await screen.findByText('Client of inkup serve on 127.0.0.1:47823 · inkup 0.1.0')).toBeTruthy();
    expect(screen.getByText('client')).toBeTruthy();
    expect(screen.getByText('Network mode: unencrypted on this LAN — trusted networks only')).toBeTruthy();
    expect(
      screen.getByText(/inkup\.local · 192\.168\.1\.20\. Other machines reach it at http:\/\/inkup\.local:47823/),
    ).toBeTruthy();
    expect(screen.getByText('inkup 0.2.0 is out: run `inkup update`')).toBeTruthy();
  });
});

describe('the network switch', () => {
  it('is off limits as a client, and says where to switch it', async () => {
    app(CLIENT, state({ pending_pairing: [] }));
    const network = await screen.findByRole('switch', { name: 'Network mode' });
    expect((network as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus(screen.getByTestId('network-elsewhere'));
    expect(
      (
        await screen.findAllByText(
          'This app is a client of inkup serve. Restart inkup serve with or without --network.',
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('asks first, then switches through the app when it hosts', async () => {
    const calls = app(HOST, state({ pending_pairing: [], network: null }), { set_network: true });
    // Enabled once the app knows it hosts (a new element: no tooltip around it).
    await waitFor(() =>
      expect((screen.getByRole('switch', { name: 'Network mode' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Network mode' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Network mode: unencrypted on this LAN — trusted networks only')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn it on' }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'set_network', args: { on: true } }));
  });
});

describe('the actions', () => {
  it('sends Session commands for a Client, and draw mode', async () => {
    const outcome = { ok: true, session_id: '3f6c1d2e-8a4b-4c7e-9f10-2b5d6e7a8c90', message: null };
    const calls = app(HOST, state({ pending_pairing: [] }), { send_command: outcome });
    await screen.findByText('Pricing Fixture');
    openTab(/^Clients/);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Draw' }));
    const client_id = 'c-1a2b3c4d';
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === 'send_command').map((c) => c.args.request)).toEqual([
        { client_id, command: 'pause' },
        { client_id, command: 'stop' },
        { client_id, command: 'set_draw_mode', draw_mode: true },
      ]),
    );
    await waitFor(() =>
      expect((screen.getByRole('switch', { name: 'Draw' }) as HTMLButtonElement).dataset.state).toBe('checked'),
    );
  });

  it('makes a token, shows it once with a copy button, and revokes one after asking', async () => {
    const made = fixture('new-token.json');
    const calls = app(HOST, state({ pending_pairing: [] }), { create_token: made });
    await screen.findByText('Pricing Fixture');
    openTab(/^Tokens/);
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'claude-code on laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(((await screen.findByLabelText('The new token')) as HTMLInputElement).value).toBe(made.token);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`inkup mcp install --remote http://inkup.local:47823 --token ${made.token}`)),
    ).toBeTruthy();
    expect(calls).toContainEqual({ cmd: 'create_token', args: { name: 'claude-code on laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke the token for codex on desktop' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('Revoke the token for codex on desktop? The agent is refused from then on.'),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'revoke_token', args: { id: 'a-0f1e2d3c' } }));
  });

  it("gives a new token's command the port this host keeps, while network mode is off", async () => {
    // Started with --port 0: network mode restarts on the port it has, not on the default 47823.
    const made = fixture('new-token.json');
    app({ ...HOST, address: '127.0.0.1:57341' }, state({ network: null, pending_pairing: [] }), { create_token: made });
    await screen.findByText('Pricing Fixture');
    openTab(/^Tokens/);
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'claude-code on laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText(`inkup mcp install --remote http://<this machine>:57341 --token ${made.token}`),
    ).toBeTruthy();
    expect(screen.getByText('It works once network mode is on.')).toBeTruthy();
  });

  it('keeps one of the menu bar and the Dock on', async () => {
    const calls = app(HOST, state({ pending_pairing: [] }));
    const dock = await screen.findByRole('switch', { name: 'Dock' });
    const menubar = screen.getByRole('switch', { name: 'Menu bar' });
    fireEvent.click(dock);
    await waitFor(() => expect((menubar as HTMLButtonElement).disabled).toBe(true));
    expect(calls).toContainEqual({ cmd: 'set_desktop_toggles', args: { toggles: { menubar: true, dock: false } } });
  });
});

describe('pairing', () => {
  it('shows a request from another machine with its code and QR, and can only refuse it', async () => {
    const calls = app(HOST, state());
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Pairing request from another machine')).toBeTruthy();
    expect(within(dialog).getByTestId('pairing-code').textContent).toBe('042 917');
    const qr = within(dialog).getByRole('img') as HTMLImageElement;
    expect(qr.src.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(calls).toContainEqual({
      cmd: 'pairing_qr',
      args: { link: 'inkup://pair?url=http://inkup.local:47823&code=042917' },
    });
    expect(within(dialog).queryByRole('button', { name: 'Pair' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refuse' }));
    expect(calls).toContainEqual({ cmd: 'answer_pairing', args: { id: 3, answer: { decision: 'deny' } } });

    // Then the one from this machine: Pair approves it.
    const next = await screen.findByText('Chrome extension "Work laptop" wants to connect');
    const local = next.closest('[role="alertdialog"]') as HTMLElement;
    fireEvent.click(within(local).getByRole('button', { name: 'Pair' }));
    expect(calls).toContainEqual({ cmd: 'answer_pairing', args: { id: 4, answer: { decision: 'approve' } } });
  });
});

describe('the host going away', () => {
  it('shows the banner as a client, and Host here takes over', async () => {
    let up = true;
    const calls = app(
      CLIENT,
      () => {
        if (!up) throw new Error('the InkUp host did not answer');
        return state({ pending_pairing: [] });
      },
      { host_here: HOST },
    );
    await screen.findByText('Pricing Fixture');
    up = false;
    // The next refetch fails: picking a Session's timeline makes one.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
    });
    expect(await screen.findByText('The InkUp host stopped')).toBeTruthy();
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Host here' }));
    await waitFor(() => expect(calls.some((c) => c.cmd === 'host_here')).toBe(true));
    expect(await screen.findByText('Hosting on 127.0.0.1:47823 · inkup 0.1.0')).toBeTruthy();
    expect(screen.queryByText('The InkUp host stopped')).toBeNull();
  });
});

describe('Install CLI', () => {
  const BUNDLED = '/Applications/InkUp.app/Contents/MacOS/inkup';
  const status = (patch: Partial<CliStatus>): CliStatus =>
    ({ bundled: BUNDLED, link: '/usr/local/bin/inkup', on_path: [], state: 'none', ...patch }) as CliStatus;

  it('is not there outside macOS', async () => {
    app(HOST, state({ pending_pairing: [] }), { cli_status: null });
    await screen.findByText('Pricing Fixture');
    expect(screen.queryByTestId('cli-button')).toBeNull();
  });

  it('installs the link, then offers to uninstall it', async () => {
    const installed = status({ state: 'ours', on_path: ['/usr/local/bin/inkup'] });
    const calls = app(HOST, state({ pending_pairing: [] }), { cli_status: status({}), install_cli: installed });
    fireEvent.click(await screen.findByRole('button', { name: 'Install CLI' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Not installed\. Install links \/usr\/local\/bin\/inkup to the CLI inside this app/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'install_cli', args: { replace: false } }));
    expect(await within(dialog).findByRole('button', { name: 'Uninstall' })).toBeTruthy();
    expect(screen.getByTestId('cli-button').textContent).toBe('CLI installed');
  });

  it('offers to reinstall a link into an app that moved', async () => {
    const broken = status({ state: 'broken', target: '/Users/me/Downloads/InkUp.app/Contents/MacOS/inkup' });
    const calls = app(HOST, state({ pending_pairing: [] }), {
      cli_status: broken,
      install_cli: status({ state: 'ours' }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reinstall CLI' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/which is gone: the app was moved or deleted/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reinstall' }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'install_cli', args: { replace: false } }));
  });

  it('replaces another inkup only after asking, and says which one PATH runs', async () => {
    const other = status({
      state: 'other',
      target: '/usr/local/Cellar/inkup/0.5.0/bin/inkup',
      on_path: ['/opt/homebrew/bin/inkup', '/usr/local/bin/inkup'],
    });
    const calls = app(HOST, state({ pending_pairing: [] }), {
      cli_status: other,
      install_cli: status({ state: 'ours' }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Install CLI' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/points at another inkup: \/usr\/local\/Cellar\/inkup\/0\.5\.0\/bin\/inkup/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        'A terminal runs /opt/homebrew/bin/inkup: it comes first on PATH, before /usr/local/bin/inkup.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Install' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace…' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(calls.some((c) => c.cmd === 'install_cli')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: 'install_cli', args: { replace: true } }));
  });
});

describe('tracker push', () => {
  const TOKEN = 'github_pat_STUBTOKEN';
  const base = state({ pending_pairing: [] });
  const template = base.state.items[0] as ItemView;
  const fullFixture = fixture('full-item.json') as FullItem;
  const sentLink = () => fixture('tracker-link.json') as TrackerLink;

  /** The Items view's rows: `item-<n>`, titled as given, linked when a link is given. */
  const rows = (...items: [string, TrackerLink?][]): ControlState => ({
    ...base,
    state: {
      ...base.state,
      items: items.map(([title, link], i) => ({
        ...template,
        id: `item-${i + 1}`,
        title,
        status: 'open',
        tracker_links: link ? [link] : [],
      })),
    },
  });

  /** The host's side: the full read of `item-<n>` (the fixture item with that row's title), its screenshots, and
   * the links recorded so far. */
  function hostSide(host: ControlState) {
    const recorded = new Map<string, TrackerLink[]>();
    const full = (id: string): FullItem => {
      const row = host.state.items.find((i) => i.id === id) as ItemView;
      return {
        ...fullFixture,
        id,
        item: {
          ...fullFixture.item,
          id: `item_000${id.slice(5)}`,
          title: row.title,
          tracker_links: [...(row.tracker_links ?? []), ...(recorded.get(id) ?? [])],
        },
      };
    };
    return {
      host_item: ({ id }: { id: string }) => full(id),
      host_screenshot: ({ id }: { id: string }) => new TextEncoder().encode(`png ${id}`).buffer,
      record_tracker_link: ({ id, link }: { id: string; link: TrackerLink }) => {
        recorded.set(id, [...(recorded.get(id) ?? []), link]);
        return full(id);
      },
    };
  }

  /** GitHub set up: its token in the keychain, acme/web picked. */
  function githubReady() {
    localStorage.setItem('inkup.trackers', JSON.stringify({ github: { destination: 'acme/web' } }));
    return {
      tracker_secret: ({ tracker, field }: { tracker: string; field: string }) =>
        tracker === 'github' && field === 'token' ? TOKEN : null,
    };
  }

  it('sends one item: its screenshots, then its issue, records the link and shows it with its status', async () => {
    const host = rows(['Make the Get started button bigger']);
    const calls = app(HOST, host, { ...githubReady(), ...hostSide(host) });
    await screen.findByText('Pricing Fixture');
    openTab(/^Items/);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to GitHub' }));

    expect((await screen.findByTestId('tracker-link')).textContent).toBe('GitHub #1');
    await waitFor(() => expect(screen.getByTestId('tracker-status').dataset.state).toBe('open'));
    expect(calls).toContainEqual({
      cmd: 'record_tracker_link',
      args: {
        id: 'item-1',
        link: expect.objectContaining({
          tracker: 'github',
          destination: 'acme/web',
          key: '#1',
          url: 'https://github.com/acme/web/issues/1',
        }),
      },
    });
    // The screenshot and its crop came from the host and went up first; then one issue, with them and the footer.
    expect(stub.uploads.map((u) => [u.id, new TextDecoder().decode(new Uint8Array(u.bytes))])).toEqual([
      ['shot-1', 'png shot-1'],
      ['shot-1.crop', 'png shot-1.crop'],
    ]);
    expect(stub.uploads[0]?.session).toBe(fullFixture.session_id);
    expect(stub.issues).toHaveLength(1);
    expect(stub.issues[0]?.title).toBe('Make the Get started button bigger');
    expect(stub.issues[0]?.body).toContain('https://github.com/acme/web/blob/inkup-assets/shot-1.png');
    expect(stub.issues[0]?.body).toContain('Sent from InkUp · Pricing Fixture · item_0001');
    // The token came from the keychain, and the adapter's fetch is tauri-plugin-http's.
    expect(new Set(stub.tokens)).toEqual(new Set([TOKEN]));
    await stub.fetch?.('https://api.github.com/user');
    expect(pluginFetch).toHaveBeenCalledWith('https://api.github.com/user', undefined);

    // Send is gone: sending again is in the menu, behind a confirm. Cancel makes nothing.
    expect(screen.queryByRole('button', { name: 'Send to GitHub' })).toBeNull();
    fireEvent.click(screen.getByTestId('tracker-menu'));
    fireEvent.click(screen.getByRole('button', { name: 'Send again…' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/It is already GitHub #1 in acme\/web/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(stub.issues).toHaveLength(1);
  });

  it('says "status unavailable" when an issue\'s status cannot be read, and blocks nothing', async () => {
    stub.statusFails = true;
    const host = rows(['Linked already', sentLink()], ['Not yet']);
    app(HOST, host, { ...githubReady(), ...hostSide(host) });
    await screen.findByText('Pricing Fixture');
    openTab(/^Items/);
    await waitFor(() => expect(screen.getByTestId('tracker-status').dataset.state).toBe('status unavailable'));
    expect(screen.getByRole('button', { name: 'Send to GitHub' })).toBeTruthy();
  });

  it('bulk-sends the unsent items one at a time, skips a linked one, keeps going after a failure and retries it', async () => {
    const host = rows(['One'], ['Two'], ['Three'], ['Four', sentLink()]);
    app(HOST, host, { ...githubReady(), ...hostSide(host) });
    stub.hold = true;
    stub.failing.add('Two');
    await screen.findByText('Pricing Fixture');
    openTab(/^Items/);
    fireEvent.click(await screen.findByRole('button', { name: 'Send 3 unsent to GitHub' }));
    for (const at of [1, 2, 3]) {
      await waitFor(() => expect(screen.getByTestId('bulk-progress').textContent).toBe(`Sending ${at} of 3`));
      await waitFor(() => expect(stub.waiting).toHaveLength(1));
      await act(async () => (stub.waiting.shift() as () => void)());
    }
    const failed = await screen.findByTestId('bulk-failed');
    expect(failed.textContent).toContain("1 item wasn't sent: item-2");
    expect(stub.issues.map((i) => i.title)).toEqual(['One', 'Three']);
    expect(screen.getAllByTestId('tracker-link').map((a) => a.textContent)).toEqual([
      'GitHub #1',
      'GitHub #2',
      'GitHub #1',
    ]);
    expect(screen.getByTestId('tracker-error').textContent).toBe(
      "This token can't create issues in acme/web. Give it Issues: read and write.",
    );

    stub.hold = false;
    stub.failing.clear();
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(stub.issues.map((i) => i.title)).toEqual(['One', 'Three', 'Two']));
    await waitFor(() => expect(screen.queryByTestId('bulk-failed')).toBeNull());
    expect(screen.queryByTestId('tracker-error')).toBeNull();
  });

  it('tests a saved token in Trackers and says which permission it lacks', async () => {
    stub.contentsWrite = false;
    app(HOST, state({ pending_pairing: [] }), githubReady());
    await screen.findByText('Pricing Fixture');
    openTab(/^Trackers/);
    expect(await screen.findByText('Saved in the keychain: github_…OKEN')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    const result = await screen.findByTestId('github-test-result');
    expect(result.textContent).toContain(
      "Problem: This token can't write to acme/web. Give it Contents: read and write.",
    );
  });

  it('keeps a saved token in the keychain only: not in web storage, and never sent to the host', async () => {
    const CANARY = 'github_pat_DESKTOPCANARY';
    let saved: string | null = null;
    const calls = app(HOST, state({ pending_pairing: [] }), {
      tracker_secret: () => saved,
      set_tracker_secret: ({ value }: { value: string }) => {
        saved = value || null;
        return null;
      },
    });
    await screen.findByText('Pricing Fixture');
    openTab(/^Trackers/);
    fireEvent.change(await screen.findByLabelText('GitHub token'), { target: { value: CANARY } });
    fireEvent.change(screen.getByLabelText('Default repo'), { target: { value: 'acme/web' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByTestId('github-notice')).textContent).toContain('What goes to GitHub');
    expect(await screen.findByText('Saved in the keychain: github_…NARY')).toBeTruthy();
    expect(calls).toContainEqual({
      cmd: 'set_tracker_secret',
      args: { tracker: 'github', field: 'token', value: CANARY },
    });
    const storage = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(storage).not.toContain(CANARY);
    expect(JSON.parse(localStorage.getItem('inkup.trackers') ?? '{}')).toEqual({ github: { destination: 'acme/web' } });
    expect(JSON.stringify(calls.filter((c) => c.cmd !== 'set_tracker_secret'))).not.toContain(CANARY);
  });

  describe('every tracker in the registry', () => {
    const SITE = 'https://acme.atlassian.net';
    const API = `${SITE}/rest/api/3`;
    const JIRA_TOKEN = 'jira-STUBTOKEN';

    beforeEach(() => {
      TRACKERS.push(...stub.others);
    });

    /** Jira, as its REST API answers: one project with a Task type, issue ABC-1, an attachment url per upload. */
    function jiraSite() {
      const requests: { method: string; path: string; auth: string | null; noCheck: string | null; body: unknown }[] =
        [];
      pluginFetch.mockImplementation(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        const path = String(input).startsWith(API) ? String(input).slice(API.length) : String(input);
        const body =
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body instanceof FormData ? 'form' : null;
        requests.push({
          method,
          path,
          auth: headers.get('authorization'),
          noCheck: headers.get('x-atlassian-token'),
          body,
        });
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
        if (method === 'GET' && path === '/project/ABC')
          return json({ key: 'ABC', issueTypes: [{ name: 'Task', subtask: false }] });
        if (method === 'POST' && path === '/issue') return json({ id: '10001', key: 'ABC-1' }, 201);
        if (method === 'POST' && path === '/issue/ABC-1/attachments') {
          const n = requests.filter((r) => r.path === path).length;
          return json([{ content: `${SITE}/rest/api/3/attachment/content/${n}` }]);
        }
        if (method === 'PUT' && path === '/issue/ABC-1') return new Response(null, { status: 204 });
        if (method === 'GET' && path === '/issue/ABC-1?fields=status')
          return json({ fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } });
        return json({ errorMessages: [`Not stubbed: ${method} ${path}`] }, 500);
      });
      return requests;
    }

    it('sends one item to Jira through its adapter on tauri-plugin-http: create, attach, then update', async () => {
      const requests = jiraSite();
      localStorage.setItem(
        'inkup.trackers',
        JSON.stringify({ jira: { site: SITE, email: 'me@example.com', destination: 'ABC' } }),
      );
      const host = rows(['Make the Get started button bigger']);
      const calls = app(HOST, host, {
        tracker_secret: ({ tracker, field }: { tracker: string; field: string }) =>
          tracker === 'jira' && field === 'token' ? JIRA_TOKEN : null,
        ...hostSide(host),
      });
      await screen.findByText('Pricing Fixture');
      openTab(/^Items/);
      // GitHub has no token here, so Jira is the only tracker to send to.
      expect(screen.queryByRole('button', { name: 'Send to GitHub' })).toBeNull();
      fireEvent.click(await screen.findByRole('button', { name: 'Send to Jira' }));

      expect((await screen.findByTestId('tracker-link')).textContent).toBe('Jira ABC-1');
      await waitFor(() => expect(screen.getByTestId('tracker-status').dataset.state).toBe('In Progress'));
      expect(screen.getByTestId('tracker-status').dataset.category).toBe('indeterminate');
      expect(calls).toContainEqual({
        cmd: 'record_tracker_link',
        args: {
          id: 'item-1',
          link: expect.objectContaining({
            tracker: 'jira',
            destination: 'ABC',
            key: 'ABC-1',
            url: `${SITE}/browse/ABC-1`,
          }),
        },
      });
      // sendItem's order: the issue first, each screenshot attached to it, then its description with them in.
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /project/ABC',
        'POST /issue',
        'POST /issue/ABC-1/attachments',
        'POST /issue/ABC-1/attachments',
        'PUT /issue/ABC-1',
        'GET /issue/ABC-1?fields=status',
      ]);
      expect(new Set(requests.map((r) => r.auth))).toEqual(new Set([`Basic ${btoa(`me@example.com:${JIRA_TOKEN}`)}`]));
      expect(requests.filter((r) => r.path.endsWith('/attachments')).every((r) => r.noCheck === 'no-check')).toBe(true);
      const created = requests[1]?.body as { fields: { summary: string; issuetype: { name: string } } };
      expect(created.fields.summary).toBe('Make the Get started button bigger');
      expect(created.fields.issuetype).toEqual({ name: 'Task' });
      expect(JSON.stringify(requests[4]?.body)).toContain(`${SITE}/rest/api/3/attachment/content/1`);
    });

    it('lists GitHub, Linear and Jira in Trackers, and refuses a Jira site that is not Atlassian Cloud', async () => {
      let saved: Record<string, string> = {};
      const calls = app(HOST, state({ pending_pairing: [] }), {
        tracker_secret: ({ tracker, field }: { tracker: string; field: string }) =>
          saved[`${tracker}:${field}`] ?? null,
        set_tracker_secret: ({ tracker, field, value }: { tracker: string; field: string; value: string }) => {
          saved = { ...saved, [`${tracker}:${field}`]: value };
          return null;
        },
      });
      await screen.findByText('Pricing Fixture');
      openTab(/^Trackers/);
      await screen.findByTestId('tracker-jira');
      expect(screen.getAllByTestId(/^tracker-(github|linear|jira)$/).map((c) => c.dataset.testid)).toEqual([
        'tracker-github',
        'tracker-linear',
        'tracker-jira',
      ]);

      const card = within(screen.getByTestId('tracker-jira'));
      fireEvent.change(card.getByLabelText('Jira site'), { target: { value: 'https://jira.example.com' } });
      fireEvent.change(card.getByLabelText('Atlassian email'), { target: { value: 'me@example.com' } });
      fireEvent.change(card.getByLabelText('Jira API token'), { target: { value: JIRA_TOKEN } });
      fireEvent.click(card.getByRole('button', { name: 'Save' }));
      expect((await card.findByRole('status')).textContent).toBe(
        'The site must look like https://<your-team>.atlassian.net. Check the address in your Jira URL.',
      );
      // Nothing was saved: not the token, not the site.
      expect(calls.filter((c) => c.cmd === 'set_tracker_secret')).toEqual([]);
      expect(localStorage.getItem('inkup.trackers')).toBeNull();

      // A team name is enough: it is saved as the full Atlassian Cloud site.
      fireEvent.change(card.getByLabelText('Jira site'), { target: { value: 'acme' } });
      fireEvent.click(card.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(card.getByRole('status').textContent).toBe('Jira settings saved.'));
      expect(JSON.parse(localStorage.getItem('inkup.trackers') ?? '{}').jira).toMatchObject({
        site: SITE,
        email: 'me@example.com',
      });
      expect(saved).toEqual({ 'jira:token': JIRA_TOKEN });
    });
  });
});
