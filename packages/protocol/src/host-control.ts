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
//
// Loopback only, with `Authorization: Bearer <control_token>`: a paired Client's token or an agent token is refused.
// Nullable fields are always present, `null` when empty, as the Host serialises them.
import { z } from 'zod';

/** Bump on a breaking change to the control API. */
export const CONTROL_API = 1 as const;

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
  .object({ id: Int.nonnegative(), url: z.string().nullable(), session_id: z.string().nullable(), since: EpochMs })
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

export const ControlState = z
  .object({
    control_api: z.literal(CONTROL_API),
    kind: HostKind,
    version: z.string().min(1),
    address: z.string().describe('127.0.0.1:<port>'),
    network: NetworkView.nullable().describe('set in network mode'),
    update: z.string().nullable().describe('a newer release, once the background check finds one'),
    state: HostState,
  })
  .describe('GET /api/host/state?timeline=<session id>');
export type ControlState = z.infer<typeof ControlState>;

export const Activated = z
  .object({ handled: z.boolean().describe('false when the Host has no window to bring forward (the TUI, serve)') })
  .describe('POST /api/host/activate');
export type Activated = z.infer<typeof Activated>;

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
} as const;
