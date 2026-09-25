// @vitest-environment happy-dom
// The window against the contract's fixture (contract/fixtures/host-control/control-state.json), through the real
// App and host.ts: only the app's commands (Tauri IPC) are mocked, as the Rust side would answer them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlState } from '@inkup/protocol/host-control';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, TABS } from './App';
import type { HostView, Toggles } from './host';

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
    ]);
    expect(TABS).toHaveLength(6);

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
