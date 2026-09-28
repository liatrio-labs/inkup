import { readFileSync } from 'node:fs';
import { ControlState } from '@inkup/protocol/host-control';
import { describe, expect, it } from 'vitest';
import {
  ago,
  type ClientView,
  type CliStatus,
  clientState,
  cliOnPath,
  cliState,
  type SessionOverview,
  sessionPage,
  sessionState,
} from './host';

const session = (patch: Partial<SessionOverview>): SessionOverview => ({
  id: 's-1',
  client_id: 'c-1',
  url: 'https://example.com/pricing',
  title: null,
  t0: 0,
  created_at: 0,
  updated_at: 0,
  live: false,
  paused: false,
  items: 0,
  open_items: 0,
  annotations: 0,
  draft_items: 0,
  ...patch,
});

const client: ClientView = {
  id: 'c-1',
  kind: 'chrome',
  name: 'Chrome',
  connected: true,
  created_at: 0,
  last_seen_at: 0,
};

describe('the words the TUI uses', () => {
  it('names a Session state', () => {
    expect(sessionState(session({ live: true }))).toBe('live');
    expect(sessionState(session({ live: true, paused: true }))).toBe('paused');
    expect(sessionState(session({ items: 2 }))).toBe('processed');
    expect(sessionState(session({}))).toBe('ended');
  });

  it('names a Client state from its live Session', () => {
    expect(clientState({ ...client, connected: false }, [])).toBe('paired');
    expect(clientState(client, [])).toBe('connected');
    expect(clientState(client, [session({ live: true })])).toBe('connected, recording');
    expect(clientState(client, [session({ live: true, paused: true })])).toBe('connected, paused');
    expect(clientState(client, [session({ live: true, client_id: 'c-2' })])).toBe('connected');
  });

  it('names the page and the time', () => {
    expect(sessionPage(session({ title: 'Pricing' }))).toBe('Pricing');
    expect(sessionPage(session({}))).toBe('https://example.com/pricing');
    expect(ago(10_000, null)).toBe('never');
    expect(ago(10_000, 9_000)).toBe('just now');
    expect(ago(3_600_000, 0)).toBe('1h ago');
  });
});

describe('the contract fixture (contract/fixtures/host-control/control-state.json)', () => {
  it('reads as the window reads it', () => {
    const url = new URL('../../../../contract/fixtures/host-control/control-state.json', import.meta.url);
    const { state } = ControlState.parse(JSON.parse(readFileSync(url, 'utf8')));
    expect(state.sessions.map(sessionState)).toEqual(['live']);
    expect(state.sessions.map(sessionPage)).toEqual(['Pricing Fixture']);
    expect(state.clients.map((c) => clientState(c, state.sessions))).toEqual(['connected, recording', 'paired']);
  });
});

describe('Install CLI', () => {
  const LINK = '/usr/local/bin/inkup';
  const status = (patch: Partial<CliStatus>): CliStatus =>
    ({
      bundled: '/Applications/InkUp.app/Contents/MacOS/inkup',
      link: LINK,
      on_path: [],
      state: 'none',
      ...patch,
    }) as CliStatus;

  it('says what is at the link', () => {
    expect(cliState(status({}))).toMatch(/^Not installed\. .*if \/usr\/local\/bin is not yours to change\.$/);
    expect(cliState(status({ state: 'ours' }))).toMatch(/^Installed: /);
    expect(cliState(status({ state: 'broken', target: '/x/InkUp.app/Contents/MacOS/inkup' }))).toContain(
      'points at /x/InkUp.app/Contents/MacOS/inkup, which is gone',
    );
    expect(cliState(status({ state: 'file' }))).toContain('is a file, not a link');
    expect(cliState(status({ bundled: null }))).toContain('scripts/desktop-cli.sh');
  });

  it('says which inkup a terminal runs', () => {
    expect(cliOnPath(status({ state: 'ours', on_path: [LINK] }))).toBeNull();
    expect(cliOnPath(status({ state: 'none' }))).toBeNull();
    expect(cliOnPath(status({ state: 'ours' }))).toBe(
      "/usr/local/bin is not on your shell's PATH, so a terminal does not find inkup.",
    );
    expect(cliOnPath(status({ state: 'ours', on_path: ['/opt/homebrew/bin/inkup', LINK] }))).toBe(
      'A terminal runs /opt/homebrew/bin/inkup: it comes first on PATH, before /usr/local/bin/inkup.',
    );
    expect(cliOnPath(status({ state: 'none', on_path: ['/Users/me/.cargo/bin/inkup'] }))).toBe(
      'A terminal runs /Users/me/.cargo/bin/inkup: it comes first on PATH.',
    );
    expect(cliOnPath(status({ state: 'ours', on_path: [LINK, '/Users/me/.cargo/bin/inkup'] }))).toBe(
      'A terminal runs /usr/local/bin/inkup. Later on PATH, not run: /Users/me/.cargo/bin/inkup.',
    );
  });
});
