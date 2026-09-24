// One WebSocket to the Host (ADR 0004, packages/protocol): hello, then pairing or welcome, then events and Change
// Items that the Host acks by the id of the message that carried them, Resolutions it pushes, and commands its user
// gives (answered with command_result). Knows nothing of Dexie or the outbox.

import type { ChangeItem } from '@inkup/core/process/change-item';
import type { TimelineEvent } from '@inkup/core/timeline';
import {
  type ClientKind,
  type CommandMessage,
  type CommandResultMessage,
  type ErrorCode,
  type EventMessage,
  type ForgetMessage,
  type ItemsMessage,
  type ResolutionMessage,
  type ScreenshotDiscardMessage,
  ServerMessage,
  type SessionDiscardMessage,
} from '@inkup/protocol';

export interface Hello {
  client_kind: ClientKind;
  client_name: string;
  /** Absent: ask the Host's user to pair this Client. */
  token?: string;
  /** Pairing with a Host on another machine: the 6-digit code it shows (ADR 0006). */
  pairing_code?: string;
}

export interface Welcome {
  client_id: string;
  host_version: string;
  capabilities: string[];
}

/** The Host refused something, with a protocol error code. `unknown_token` means pair again. */
export class HostRefused extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HostRefused';
  }
}

export interface HostConnection {
  readonly welcome: Welcome;
  /** The token this connection was issued, when it paired; null when it said hello with one. */
  readonly token: string | null;
  /** Resolves when the Host acks the event; rejects with HostRefused, or with an Error when the socket closes. */
  sendEvent(sessionId: string, event: TimelineEvent): Promise<void>;
  /** The Session's current Change Items, all of them; resolves when the Host acks. */
  sendItems(sessionId: string, runId: string, items: ChangeItem[]): Promise<void>;
  /** A cancelled Session (E10): the Host deletes it; resolves when the Host acks. */
  sendDiscard(sessionId: string): Promise<void>;
  /** Forget: the Host revokes this Client's token, acks, and closes the connection. */
  sendForget(): Promise<void>;
  /** A screenshot no Annotation uses (#22): the Host deletes its blob and its `screenshot` event. */
  sendScreenshotDiscard(sessionId: string, screenshotId: string): Promise<void>;
  close(): void;
  /** Resolves once the socket is closed, from either end. */
  readonly closed: Promise<void>;
}

/** How a command went: `message` says why when it did not. */
export type CommandOutcome = Pick<CommandResultMessage, 'ok' | 'session_id' | 'message'>;

export interface ConnectOptions {
  /** How long to wait for welcome. Pairing waits for a person, so allow minutes. */
  timeoutMs?: number;
  WebSocket?: typeof WebSocket;
  /** A Resolution the Host pushed (after welcome it replays those it has, then sends new ones). */
  onResolution?: (resolution: ResolutionMessage) => void;
  /** A command from the Host's user (start, pause, resume, stop, draw mode). Without one, every command is refused. */
  onCommand?: (command: CommandMessage) => Promise<CommandOutcome>;
}

/** `http://127.0.0.1:47823` → `ws://127.0.0.1:47823/ws`. */
export const socketUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/ws`;

export function connectHost(baseUrl: string, hello: Hello, options: ConnectOptions = {}): Promise<HostConnection> {
  const Socket = options.WebSocket ?? WebSocket;
  const ws = new Socket(socketUrl(baseUrl));
  let sent = 0;
  const nextId = () => `c-${++sent}`;
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let token: string | null = null;
  let welcome: Welcome | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));

  return new Promise<HostConnection>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The host did not answer in time.'));
      ws.close();
    }, options.timeoutMs ?? 10_000);

    const connection: HostConnection = {
      get welcome() {
        return welcome!;
      },
      get token() {
        return token;
      },
      closed,
      close: () => ws.close(),
      sendEvent(sessionId, event) {
        const message: EventMessage = { v: 1, type: 'event', id: nextId(), session_id: sessionId, event };
        return request(message);
      },
      sendItems(sessionId, runId, items) {
        const message: ItemsMessage = {
          v: 1,
          type: 'items',
          id: nextId(),
          session_id: sessionId,
          run_id: runId,
          items,
        };
        return request(message);
      },
      sendDiscard(sessionId) {
        const message: SessionDiscardMessage = { v: 1, type: 'session_discard', id: nextId(), session_id: sessionId };
        return request(message);
      },
      sendForget() {
        const message: ForgetMessage = { v: 1, type: 'forget', id: nextId() };
        return request(message);
      },
      sendScreenshotDiscard(sessionId, screenshotId) {
        const message: ScreenshotDiscardMessage = {
          v: 1,
          type: 'screenshot_discard',
          id: nextId(),
          session_id: sessionId,
          screenshot_id: screenshotId,
        };
        return request(message);
      },
    };
    function request(
      message: EventMessage | ItemsMessage | SessionDiscardMessage | ScreenshotDiscardMessage | ForgetMessage,
    ) {
      return new Promise<void>((res, rej) => {
        if (ws.readyState !== ws.OPEN) return rej(new Error('The host connection is closed.'));
        pending.set(message.id, { resolve: res, reject: rej });
        ws.send(JSON.stringify(message));
      });
    }

    ws.onopen = () => ws.send(JSON.stringify({ v: 1, type: 'hello', id: nextId(), ...hello }));
    ws.onmessage = (e) => {
      const parsed = ServerMessage.safeParse(JSON.parse(String(e.data)));
      if (!parsed.success) return console.warn('host: unreadable message', parsed.error.message);
      const msg = parsed.data;
      switch (msg.type) {
        case 'paired':
          token = msg.token;
          return;
        case 'welcome':
          welcome = { client_id: msg.client_id, host_version: msg.host_version, capabilities: msg.capabilities };
          clearTimeout(timer);
          return resolve(connection);
        case 'ack':
          pending.get(msg.re)?.resolve();
          pending.delete(msg.re);
          return;
        case 'resolution':
          return options.onResolution?.(msg);
        case 'command': {
          const reply = (outcome: CommandOutcome) => {
            if (ws.readyState !== ws.OPEN) return;
            const result: CommandResultMessage = { v: 1, type: 'command_result', id: nextId(), re: msg.id, ...outcome };
            ws.send(JSON.stringify(result));
          };
          const refused = (message: string) => reply({ ok: false, session_id: null, message });
          if (!options.onCommand) return refused('This browser does not take commands.');
          void options.onCommand(msg).then(reply, (e: unknown) => refused(e instanceof Error ? e.message : String(e)));
          return;
        }
        case 'error': {
          const refused = new HostRefused(msg.code, msg.message);
          const waiting = msg.re ? pending.get(msg.re) : undefined;
          if (waiting) {
            pending.delete(msg.re!);
            return waiting.reject(refused);
          }
          // Before welcome, an error is the handshake's answer.
          if (!welcome) {
            clearTimeout(timer);
            reject(refused);
          }
          return;
        }
      }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (!welcome) reject(new Error('Could not reach the host.'));
      for (const p of pending.values()) p.reject(new Error('The host connection closed.'));
      pending.clear();
      resolveClosed();
    };
  });
}
