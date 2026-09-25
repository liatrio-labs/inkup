// The control API (`/api/host/*`, host/crates/server/src/control.rs): local admin of a running Host, for the desktop
// app first. These Zod schemas are its source of truth. `pnpm schema` writes contract/host-control.schema.json from
// them, and host/crates/protocol generates its Rust types (`inkup_protocol::control`) from that file.
//
// Its version is `CONTROL_API`, apart from the WebSocket protocol's `v`. Every Host that holds a data dir writes it
// into `host.json`, where a client reads it before it calls; `GET /api/host/state` repeats it.
//
// - `host.json` (`HostFile`): who holds the data dir, where it listens, and the control token. 0600 on unix.
// - `GET /api/host/state` (`ControlState`): `HostState`, what the TUI shows, plus the header's facts.
// - `POST /api/host/activate` (`Activated`): whether the Host brought a window forward.
// - `GET /api/host/changes?since=<seq>` (`Changes`): waits until what `state` returns has changed after `seq`.
// - `POST /api/host/commands` (`CommandRequest` → `CommandOutcome`): drives a connected Client's Session.
// - `POST /api/host/tokens` (`NewTokenRequest` → `NewToken`), `DELETE /api/host/tokens/{id}`: agent tokens.
// - `POST /api/host/network` (`NetworkRequest` → `NetworkSwitched`): network mode, where the Host can switch it here.
// - `POST /api/host/pairing/{id}` (`PairingAnswer`): approve or deny a pairing request the Host asks about here.
//
// Loopback only, with `Authorization: Bearer <control_token>`: a paired Client's token or an agent token is refused.
// Nullable fields are always present, `null` when empty, as the Host serialises them.
import { z } from 'zod';

/** Bump on a breaking change to the control API. */
export const CONTROL_API = 2 as const;

const Int = z.number().int();
const EpochMs = Int.describe('epoch ms');

export const HostKind = z.enum(['tui', 'serve', 'desktop']).describe('which kind of Host holds the data dir');
export type HostKind = z.infer<typeof HostKind>;

export const HostFile = z
  .object({
    pid: Int.nonnegative(),
    kind: HostKind,
    port: Int.min(1).max(65535),
    control_token: z.string().min(1).describe('the Bearer token /api/host/* takes'),
    control_api: Int.positive().describe(
      'the control API version the holder speaks; a number, not a literal, so a client of another version can read it and say so',
    ),
    version: z.string().min(1).describe('the holder\'s release, e.g. "0.1.0"'),
    started_at: EpochMs,
  })
  .describe('host.json in the data dir, written by the Host holding host.lock once its server has bound');
export type HostFile = z.infer<typeof HostFile>;

export const ClientView = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  connected: z.boolean(),
  created_at: EpochMs,
  last_seen_at: EpochMs.nullable(),
});
export type ClientView = z.infer<typeof ClientView>;

export const SessionOverview = z.object({
  id: z.string(),
  client_id: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  t0: EpochMs.nullable(),
  created_at: EpochMs,
  updated_at: EpochMs,
  live: z.boolean().describe('no session_end yet'),
  paused: z.boolean().describe('live, and its latest pause is not followed by a resume'),
  items: Int.describe('current Change Items'),
  open_items: Int.describe('current Change Items with no Resolution'),
  annotations: Int,
  draft_items: Int,
});
export type SessionOverview = z.infer<typeof SessionOverview>;

export const TimelineEntry = z.object({
  t: Int.describe('ms since the Session t0'),
  kind: z.string().describe('said, annotation, command, draft, comment or session'),
  text: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const Timeline = z.object({ session_id: z.string(), entries: z.array(TimelineEntry) });
export type Timeline = z.infer<typeof Timeline>;

export const ItemStatus = z.enum(['open', 'in_progress', 'resolved', 'wont_fix', 'needs_info']);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const ItemView = z.object({
  id: z.string().describe('item-<seq>, as agents see it'),
  session_id: z.string(),
  title: z.string(),
  category: z.string(),
  status: ItemStatus,
  note: z.string().nullable().describe("the latest resolution's note"),
  agent: z.string().nullable().describe('the agent behind the latest resolution'),
  since: EpochMs.nullable().describe('when the latest resolution was made'),
  prompt: z.string(),
});
export type ItemView = z.infer<typeof ItemView>;

export const Watcher = z
  .object({
    id: Int.nonnegative(),
    url: z.string().nullable(),
    session_id: z.string().nullable(),
    since: Int.nonnegative().describe('the item seq its cursor waits after, not a time'),
  })
  .describe('an agent blocked in watch_items');
export type Watcher = z.infer<typeof Watcher>;

export const AgentToken = z
  .object({ id: z.string(), name: z.string(), created_at: EpochMs, last_used_at: EpochMs.nullable() })
  .describe('an agent token not revoked; never its secret');
export type AgentToken = z.infer<typeof AgentToken>;

export const HostState = z
  .object({
    clients: z.array(ClientView),
    sessions: z.array(SessionOverview).describe('most recently updated first'),
    timeline: Timeline.nullable().describe('of the Session asked for, else of the newest live Session'),
    items: z.array(ItemView),
    watchers: z.array(Watcher),
    agent_tokens: z.array(AgentToken),
  })
  .describe('what the TUI shows (inkup_server::HostState)');
export type HostState = z.infer<typeof HostState>;

export const NetworkView = z
  .object({
    claimed: z.string().nullable().describe('the .local name, once claimed on mDNS'),
    addresses: z.array(z.string()).describe("this machine's LAN addresses"),
    base_url: z.string().describe('where another machine reaches the Host'),
  })
  .describe('network mode as the header shows it');
export type NetworkView = z.infer<typeof NetworkView>;

export const RemotePairing = z
  .object({
    code: z
      .string()
      .regex(/^[0-9]{6}$/)
      .describe('the 6-digit code the user types in the Client'),
    from: z.string().describe('the address the request came from'),
    link: z.string().describe('inkup://pair?url=…&code=…, for a QR code'),
  })
  .describe('a pairing request from another machine (network mode): shown, not approved');
export type RemotePairing = z.infer<typeof RemotePairing>;

export const PairingPrompt = z
  .object({
    id: Int.nonnegative().describe('answer it at POST /api/host/pairing/{id}'),
    prompt: z.string().describe('"Chrome extension "Work laptop" wants to connect"'),
    client_kind: z.string(),
    client_name: z.string(),
    remote: RemotePairing.nullable(),
  })
  .describe('a pairing request waiting for the user');
export type PairingPrompt = z.infer<typeof PairingPrompt>;

export const ControlState = z
  .object({
    control_api: z.literal(CONTROL_API),
    kind: HostKind,
    version: z.string().min(1),
    address: z.string().describe('127.0.0.1:<port>'),
    network: NetworkView.nullable().describe('set in network mode'),
    update: z.string().nullable().describe('a newer release, once the background check finds one'),
    network_switch: z.boolean().describe('whether POST /api/host/network can switch network mode on this Host'),
    pending_pairing: z
      .array(PairingPrompt)
      .describe('pairing requests this Host asks about through the control API; empty when its terminal asks'),
    state: HostState,
  })
  .describe('GET /api/host/state?timeline=<session id>');
export type ControlState = z.infer<typeof ControlState>;

export const Activated = z
  .object({ handled: z.boolean().describe('false when the Host has no window to bring forward (the TUI, serve)') })
  .describe('POST /api/host/activate');
export type Activated = z.infer<typeof Activated>;

export const Changes = z
  .object({ seq: Int.nonnegative().describe('pass it back as `since` to wait for the next change') })
  .describe('GET /api/host/changes?since=<seq>: answered at the next change, or after a while with no change');
export type Changes = z.infer<typeof Changes>;

export const HostCommand = z.enum(['start_session', 'pause', 'resume', 'stop', 'set_draw_mode']);
export type HostCommand = z.infer<typeof HostCommand>;

export const CommandRequest = z
  .object({
    client_id: z.string().min(1),
    command: HostCommand,
    draw_mode: z.boolean().optional().describe('set_draw_mode only: on or off'),
  })
  .describe("POST /api/host/commands: what the TUI's keys do to a connected Client's Session");
export type CommandRequest = z.infer<typeof CommandRequest>;

export const CommandOutcome = z
  .object({ ok: z.boolean(), session_id: z.string().nullable(), message: z.string().nullable() })
  .describe("the Client's answer to a command");
export type CommandOutcome = z.infer<typeof CommandOutcome>;

export const NewTokenRequest = z
  .object({ name: z.string().trim().min(1).max(60).describe('who it is for, e.g. "claude-code on laptop"') })
  .describe('POST /api/host/tokens');
export type NewTokenRequest = z.infer<typeof NewTokenRequest>;

export const NewToken = z
  .object({
    id: z.string(),
    name: z.string(),
    created_at: EpochMs,
    token: z.string().min(1).describe('the secret: shown once, stored nowhere but by its user'),
  })
  .describe('a new agent token');
export type NewToken = z.infer<typeof NewToken>;

export const NetworkRequest = z.object({ on: z.boolean() }).describe('POST /api/host/network');
export type NetworkRequest = z.infer<typeof NetworkRequest>;

export const NetworkSwitched = z
  .object({ handled: z.boolean().describe('false when this Host switches network mode in its own terminal') })
  .describe('the Host restarts its server in the new mode after answering');
export type NetworkSwitched = z.infer<typeof NetworkSwitched>;

export const PairingAnswer = z
  .object({ decision: z.enum(['approve', 'deny']) })
  .describe('POST /api/host/pairing/{id}; a request from another machine can only be denied');
export type PairingAnswer = z.infer<typeof PairingAnswer>;

/** Every schema in host-control.schema.json, by its definition name. */
export const CONTROL_DEFINITIONS = {
  HostFile,
  ControlState,
  Activated,
  HostKind,
  HostState,
  ClientView,
  SessionOverview,
  Timeline,
  TimelineEntry,
  ItemStatus,
  ItemView,
  Watcher,
  AgentToken,
  NetworkView,
  PairingPrompt,
  RemotePairing,
  Changes,
  HostCommand,
  CommandRequest,
  CommandOutcome,
  NewTokenRequest,
  NewToken,
  NetworkRequest,
  NetworkSwitched,
  PairingAnswer,
} as const;
