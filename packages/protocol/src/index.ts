// The host wire protocol (ADR 0004, ADR 0005): the JSON messages a Client and the Host exchange over the
// WebSocket at /ws, and the /health document. These Zod schemas are the source of truth. `pnpm schema` writes
// protocol.schema.json from them, and host/crates/protocol generates its Rust types from that file.
//
// Every message is an envelope {v, type, id, ...}. `id` is unique per sender; a reply names the message it
// answers in `re`. Field names are snake_case, like the Session timeline.
//
// A Client opens /ws and sends `hello` first:
// - never paired: hello{client_kind, client_name} → the Host asks its user → `paired{token}`, then `welcome`
// - paired: hello{token} → `welcome{capabilities}`
// - never paired, from another machine (network mode, ADR 0006): hello{client_kind, client_name} → the Host shows a
//   6-digit code (and a QR code of a `inkup://pair` link) and answers `error{pairing_code_required}`; the
//   Client asks its user for the code and connects again with hello{pairing_code} → `paired{token}`, `welcome`
// After `welcome` it streams `event{session_id, event}` and the Host answers each with `ack{event_id}`. After a
// Process run, and after each review edit of its items, it sends the run's current Change Items as
// `items{session_id, run_id, items}`, answered with `ack`. The Host pushes `resolution` whenever an agent (or the
// Host's user) resolves an item of this Client's Sessions, and replays them all after each `welcome`.
// A Session the reviewer cancelled (E10) is discarded once its undo window has passed: `session_discard{session_id}`,
// answered with `ack`, deletes it from the Host with everything it held.
// Forget in the Client sends `forget` first: the Host revokes the Client's token, acks and closes the connection;
// the Client's Sessions stay on the Host.
// A screenshot taken for an Annotation that was never recorded (an Object Select pick dropped with Esc, or anything
// left unreferenced at Stop) is withdrawn: `screenshot_discard{session_id, screenshot_id}`, answered with `ack`,
// deletes its blob and its `screenshot` event from the Host.
// The Host's user (the TUI, or another paired Client) can drive a Session: the Host sends `command` and the Client
// answers `command_result{re}`.
// Anything the Host refuses gets `error{code}`.
import { ChangeItemSchema } from '@inkup/core/process/change-item';
import { TimelineEventSchema } from '@inkup/core/timeline';
import { z } from 'zod';

export * from './host-control.ts';

/** Bump on a breaking change to any message. Every envelope carries it as `v`. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * What a Host can do, reported in /health and `welcome`. A Client gates each host feature on one of these
 * (graceful simplification), so a feature is present or absent as a whole. Strings, not an enum, so an older
 * Client still reads a newer Host's list.
 */
export const KNOWN_CAPABILITIES = [
  'events',
  'blobs',
  'items',
  'resolutions',
  'discard',
  'forget',
  'screenshot_discard',
] as const;

const MessageId = z.string().min(1).max(128).describe('unique per sender; a reply names it in `re`');
const Re = z.string().min(1).max(128).describe('the `id` of the message this answers');
const Capabilities = z
  .array(z.string().min(1))
  .describe(`what the Host can do; known values: ${KNOWN_CAPABILITIES.join(', ')}`);

const envelope = <T extends string>(type: T) =>
  z.object({ v: z.literal(PROTOCOL_VERSION).describe('protocol version'), type: z.literal(type), id: MessageId });

export const ClientKind = z.enum(['chrome', 'firefox', 'safari', 'other']);
export type ClientKind = z.infer<typeof ClientKind>;

export const HelloMessage = envelope('hello')
  .extend({
    client_kind: ClientKind,
    client_name: z.string().min(1).max(100).describe('shown to the user when the Client asks to pair'),
    token: z.string().min(1).max(256).optional().describe('the token from `paired`; absent to ask for pairing'),
    pairing_code: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional()
      .describe('the 6-digit code the Host showed, when pairing from another machine (network mode)'),
  })
  .describe('Client → Host, the first message on every connection');

export const PairedMessage = envelope('paired')
  .extend({
    re: Re,
    client_id: z.string().min(1),
    token: z.string().min(1).max(256).describe('send it in every later hello, and as the Bearer token for HTTP'),
  })
  .describe('Host → Client: the user approved pairing. `welcome` follows on the same connection');

export const WelcomeMessage = envelope('welcome')
  .extend({
    re: Re,
    client_id: z.string().min(1),
    host_version: z.string().min(1),
    capabilities: Capabilities,
  })
  .describe('Host → Client: the connection is authenticated');

/**
 * What the Host checks of a timeline event: the fields it indexes. It stores the rest verbatim, keyed on `id`, so
 * a Host keeps accepting events from a newer timeline schema version than it was built with (the extension and
 * the Host update independently). This is the `event` of EventMessage in protocol.schema.json, and so on the
 * Rust side; TypeScript senders use the full timeline schema (see EventMessage).
 */
export const WireTimelineEvent = z
  .looseObject({
    id: z.string().min(1).describe('the event UUID; the Host upserts on it, so a resend is harmless'),
    type: z.string().min(1),
    t: z.number().int().nonnegative().describe('ms since the Session t0'),
  })
  .describe('a Session timeline event, stored verbatim');

/** A Client sends real timeline events (packages/core timeline.ts), checked in full before they leave. */
export const EventMessage = envelope('event')
  .extend({ session_id: z.string().min(1).max(128), event: TimelineEventSchema })
  .describe('Client → Host: append (or resend) one timeline event');

/**
 * What the Host checks of a Change Item: its id. It stores the rest verbatim and reads the fields it shows agents
 * leniently, for the same reason as WireTimelineEvent. This is an item of ItemsMessage in protocol.schema.json.
 */
export const WireChangeItem = z
  .looseObject({
    id: z.string().min(1).describe('item_0001, …: unique within its Process run'),
    title: z.string(),
  })
  .describe('a Change Item, stored verbatim');

/** A Client sends real Change Items (packages/core change-item.ts). */
export const ItemsMessage = envelope('items')
  .extend({
    session_id: z.string().min(1).max(128),
    run_id: z.string().min(1).max(128).describe('the Process run the items come from'),
    items: z.array(ChangeItemSchema).describe("the run's items with the review edits applied, in review order"),
  })
  .describe(
    "Client → Host: the Session's current Change Items, all of them. They replace what the Host held for the Session: an item left out (deleted, merged away, or from an earlier run) is withdrawn, never deleted",
  );

export const SessionDiscardMessage = envelope('session_discard')
  .extend({ session_id: z.string().min(1).max(128) })
  .describe(
    'Client → Host: the reviewer cancelled this Session and did not undo it. The Host deletes it with its events, blobs, Change Items, Resolutions and Signals; an unknown Session is acked too',
  );

export const ForgetMessage = envelope('forget').describe(
  "Client → Host: the reviewer chose Forget. The Host revokes this Client's token (its Sessions stay), answers `ack` and closes the connection",
);

export const ScreenshotDiscardMessage = envelope('screenshot_discard')
  .extend({
    session_id: z.string().min(1).max(128),
    screenshot_id: z.string().min(1).max(256).describe("the `screenshot` event's screenshot_id, also its blob id"),
  })
  .describe(
    'Client → Host: a screenshot no Annotation uses (its pick was dropped, E7). The Host deletes its blob and its `screenshot` event; an unknown one is acked too',
  );

export const AckMessage = envelope('ack')
  .extend({ re: Re, event_id: z.string().min(1).optional().describe('the event stored, when `re` was an event') })
  .describe('Host → Client: the message is stored; the outbox may drop it');

/** `in_progress`: an agent has started on the item (MCP `start_item`); a later resolution replaces it. */
export const ResolutionStatus = z.enum(['in_progress', 'resolved', 'wont_fix', 'needs_info']);
export type ResolutionStatus = z.infer<typeof ResolutionStatus>;

export const ResolutionMessage = envelope('resolution')
  .extend({
    resolution_id: z.string().min(1),
    session_id: z.string().min(1),
    run_id: z.string().min(1),
    item_id: z.string().min(1).describe('the Change Item id within its run'),
    status: ResolutionStatus,
    note: z.string().describe('what the agent did, or what it needs to know'),
    source: z.string().min(1).describe('who resolved it: `mcp` (an agent) or `host` (the Host user)'),
    agent: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("the agent's name as its MCP client reported it (clientInfo), when an agent sent it"),
    created_at: z.number().int().nonnegative().describe('epoch ms'),
  })
  .describe(
    'Host → Client: an agent started on an item of one of its Sessions, or resolved it. The latest resolution of an item wins',
  );

export const ErrorCode = z.enum([
  'bad_message',
  'unsupported_version',
  'unknown_token',
  'pairing_denied',
  'pairing_timeout',
  'pairing_code_required',
  'wrong_pairing_code',
  'not_welcomed',
  'conflict',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorMessage = envelope('error')
  .extend({
    re: Re.nullable().describe('the message refused; null when it could not be read'),
    code: ErrorCode,
    message: z.string(),
  })
  .describe('Host → Client: a refusal. After a handshake error the Host closes the connection');

export const CommandName = z.enum(['start_session', 'pause', 'resume', 'stop', 'set_draw_mode']);
export type CommandName = z.infer<typeof CommandName>;

export const CommandMessage = envelope('command')
  .extend({
    command: CommandName.describe(
      'start_session records audio, Strokes and screenshots, but no video (video needs a click in the browser)',
    ),
    draw_mode: z.boolean().optional().describe('set_draw_mode only: on or off'),
  })
  .describe('Host → Client: drive the Session. The Client answers `command_result`');

export const CommandResultMessage = envelope('command_result')
  .extend({
    re: Re,
    ok: z.boolean(),
    session_id: z.string().min(1).nullable().describe('the Session the command acted on, when there is one'),
    message: z.string().nullable().describe('why it failed, for the Host user'),
  })
  .describe('Client → Host: what came of a `command`');

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  EventMessage,
  ItemsMessage,
  SessionDiscardMessage,
  ScreenshotDiscardMessage,
  ForgetMessage,
  CommandResultMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const ServerMessage = z.discriminatedUnion('type', [
  PairedMessage,
  WelcomeMessage,
  AckMessage,
  ErrorMessage,
  ResolutionMessage,
  CommandMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export const Envelope = z.discriminatedUnion('type', [
  HelloMessage,
  EventMessage,
  ItemsMessage,
  SessionDiscardMessage,
  ForgetMessage,
  ScreenshotDiscardMessage,
  PairedMessage,
  WelcomeMessage,
  AckMessage,
  ErrorMessage,
  ResolutionMessage,
  CommandMessage,
  CommandResultMessage,
]);
export type Envelope = z.infer<typeof Envelope>;
export type EventMessage = z.infer<typeof EventMessage>;
export type WelcomeMessage = z.infer<typeof WelcomeMessage>;
export type ItemsMessage = z.infer<typeof ItemsMessage>;
export type SessionDiscardMessage = z.infer<typeof SessionDiscardMessage>;
export type ForgetMessage = z.infer<typeof ForgetMessage>;
export type ScreenshotDiscardMessage = z.infer<typeof ScreenshotDiscardMessage>;
export type ResolutionMessage = z.infer<typeof ResolutionMessage>;
export type CommandMessage = z.infer<typeof CommandMessage>;
export type CommandResultMessage = z.infer<typeof CommandResultMessage>;

export const Health = z
  .object({
    name: z.literal('inkup'),
    version: z.string().min(1),
    protocol_version: z.number().int().positive(),
    capabilities: Capabilities,
    hub_name: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('the name the Host goes by on the network, e.g. "inkup on studio-mac"'),
  })
  .describe('GET /health: how a Client finds the Host and what it can do');
export type Health = z.infer<typeof Health>;

/** Every schema in protocol.schema.json, by its definition name. */
export const DEFINITIONS = {
  Envelope,
  ClientMessage,
  ServerMessage,
  HelloMessage,
  PairedMessage,
  WelcomeMessage,
  EventMessage,
  ItemsMessage,
  SessionDiscardMessage,
  ForgetMessage,
  ScreenshotDiscardMessage,
  AckMessage,
  ErrorMessage,
  ResolutionMessage,
  CommandMessage,
  CommandResultMessage,
  ClientKind,
  CommandName,
  ErrorCode,
  ResolutionStatus,
  WireTimelineEvent,
  WireChangeItem,
  Health,
} as const;
