import { describe, expect, it } from 'vitest';
import { ago, type ClientView, clientState, type SessionOverview, sessionPage, sessionState } from './host';

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
