import { describe, expect, it, vi } from 'vitest';
import { backoffMs, clientIdentity, connectHost, socketUrl } from '@/adapters/host';

describe('host adapter', () => {
  it('derives the WebSocket URL from the host address', () => {
    expect(socketUrl('http://127.0.0.1:47823')).toBe('ws://127.0.0.1:47823/ws');
    expect(socketUrl('http://localhost:5000/')).toBe('ws://localhost:5000/ws');
  });

  it('backs off from 0.5 s, doubling, capped at 10 s, with ±20% jitter', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 10].map((a) => backoffMs(a, mid))).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(backoffMs(0, () => 0)).toBe(400);
    expect(backoffMs(0, () => 1)).toBe(600);
  });

  it('introduces the browser by kind and platform', () => {
    expect(clientIdentity('chrome', 'macOS')).toEqual({ client_kind: 'chrome', client_name: 'Chrome on macOS' });
    expect(clientIdentity('firefox', '')).toEqual({ client_kind: 'firefox', client_name: 'Firefox' });
    expect(clientIdentity('edge', 'Windows')).toEqual({ client_kind: 'other', client_name: 'Browser on Windows' });
  });
});

/** A WebSocket the test plays the Host on: it records what the Client sends and delivers what the test says. */
class FakeSocket {
  static last: FakeSocket;
  readonly OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.onclose?.();
  }
  deliver(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, ...message }) });
  }
}

describe('host connection', () => {
  it('sends Change Items, resolves on their ack, and hands pushed Resolutions over', async () => {
    const resolutions: unknown[] = [];
    const connecting = connectHost(
      'http://127.0.0.1:47823',
      { client_kind: 'chrome', client_name: 'Chrome on macOS', token: 'inkc1_x' },
      { WebSocket: FakeSocket as unknown as typeof WebSocket, onResolution: (r) => resolutions.push(r) },
    );
    await Promise.resolve();
    const host = FakeSocket.last;
    expect(host.sent[0]).toMatchObject({ type: 'hello', token: 'inkc1_x' });
    host.deliver({
      type: 'welcome',
      id: 'h-1',
      re: 'c-1',
      client_id: 'c-1',
      host_version: '0.1.0',
      capabilities: ['events', 'items'],
    });
    const conn = await connecting;

    const item = {
      id: 'item_0001',
      title: 'Bigger CTA',
      category: 'style' as const,
      intent: 'Make it bigger.',
      locations: [
        {
          role: 'subject' as const,
          selector: 'a.cta',
          element: "link 'Get started'",
          url: '/',
          screenshot: null,
          annotation: 1,
        },
      ],
      evidence: { video: null, screenshots: [] },
      transcript: 'bigger',
      confidence: 0.9,
      agent_prompt: 'Enlarge a.cta.',
      pinned: false,
    };
    const sent = conn.sendItems('s1', 'run-1', [item]);
    expect(host.sent[1]).toMatchObject({ type: 'items', id: 'c-2', session_id: 's1', run_id: 'run-1', items: [item] });
    host.deliver({ type: 'ack', id: 'h-2', re: 'c-2' });
    await expect(sent).resolves.toBeUndefined();

    const resolution = {
      type: 'resolution',
      id: 'h-3',
      resolution_id: 'r-1',
      session_id: 's1',
      run_id: 'run-1',
      item_id: 'item_0001',
      status: 'resolved',
      note: 'Done',
      source: 'mcp',
      created_at: 1,
    };
    host.deliver(resolution);
    expect(resolutions).toEqual([{ v: 1, ...resolution }]);
  });

  it('runs a command from the Host and answers with its outcome; without a handler it refuses', async () => {
    const hello = { client_kind: 'chrome' as const, client_name: 'Chrome', token: 'inkc1_x' };
    const welcome = {
      type: 'welcome',
      id: 'h-1',
      re: 'c-1',
      client_id: 'c-1',
      host_version: '0.1.0',
      capabilities: ['events'],
    };
    const commands: unknown[] = [];
    const connecting = connectHost('http://127.0.0.1:47823', hello, {
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      onCommand: async (c) => {
        commands.push(c);
        return c.command === 'pause'
          ? { ok: false, session_id: null, message: 'No Session is recording.' }
          : { ok: true, session_id: 's1', message: null };
      },
    });
    await Promise.resolve();
    const host = FakeSocket.last;
    host.deliver(welcome);
    await connecting;

    host.deliver({ type: 'command', id: 'h-2', command: 'set_draw_mode', draw_mode: true });
    await vi.waitFor(() =>
      expect(host.sent[1]).toEqual({
        v: 1,
        type: 'command_result',
        id: 'c-2',
        re: 'h-2',
        ok: true,
        session_id: 's1',
        message: null,
      }),
    );
    expect(commands).toEqual([{ v: 1, type: 'command', id: 'h-2', command: 'set_draw_mode', draw_mode: true }]);
    host.deliver({ type: 'command', id: 'h-3', command: 'pause' });
    await vi.waitFor(() =>
      expect(host.sent[2]).toMatchObject({
        type: 'command_result',
        re: 'h-3',
        ok: false,
        message: 'No Session is recording.',
      }),
    );

    const bare = connectHost('http://127.0.0.1:47823', hello, { WebSocket: FakeSocket as unknown as typeof WebSocket });
    await Promise.resolve();
    const other = FakeSocket.last;
    other.deliver(welcome);
    await bare;
    other.deliver({ type: 'command', id: 'h-2', command: 'start_session' });
    await vi.waitFor(() =>
      expect(other.sent[1]).toMatchObject({ type: 'command_result', re: 'h-2', ok: false, session_id: null }),
    );
  });
});
