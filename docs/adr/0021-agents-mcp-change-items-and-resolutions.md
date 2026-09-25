---
status: accepted
date: 2026-09-23
---

# Agents read Change Items and Signals over MCP, claim them with `start_item`, and answer with Resolutions that the reviewer sees; the Host never deletes an item

The point of the Host is hand-off: a coding agent reads what the reviewer asked for and says what it did. Several agents
may watch one Host, a reviewer may keep editing items after an agent read them, and the reviewer must see the answer on
the card where they asked.

**Items have stable Host ids.** An item is keyed by its run and item id, but agents see `item-<seq>`, the Host's
never-reused sequence, which survives review edits. `read_items` and `watch_items` return a cursor
`<item seq>.<event seq>`, so nothing arriving between two calls is missed. Items are pushed as the whole current set
and withdrawn, never deleted, when they leave it (ADR 0020). Screenshots are cited by id (`screenshots/<id>.png` in the
`agent_prompt`), and `get_screenshot` returns MCP image content, optionally cropped: blob files are named by a hash an
agent could not open.

**Signals before Process.** A Session with no Change Items yet exposes its live Annotations (with the words said around
them), Text Comments and Draft Items, derived on the Host from the events it already has, minus what was scratched or
discarded. `watch_items` wakes on them. The instructions say Signals are a heads-up, not tasks. The first `items` push
supersedes them.

**Claim, then resolve.** `start_item(id, note?)` records a Resolution `in_progress` with the agent's name
(`clientInfo.name` from MCP `initialize`); it is idempotent, refuses an item already `resolved` or `wont_fix`, and lets
`needs_info` be picked up again. `resolve_item` records `resolved`, `wont_fix` or `needs_info` with a note. Status is the
latest Resolution and history is kept; `open` means no Resolution at all, so an item in work is not open. Resolutions
go back to the owning Client over the WebSocket and are replayed after each `welcome`; the card shows the latest one.
The server instructions and tool descriptions carry the workflow; there is no separate agent guide.

**`inkup mcp install` edits config files.** It writes the `inkup` entry for Claude Code, Cursor and Codex directly
(JSON keeps key order, TOML keeps comments via `toml_edit`), atomically with permissions kept, and refuses to touch a
file that does not parse. It does not shell out to `claude mcp add`, so it works whichever agent CLIs are on PATH.
`--reset` removes the entry. Tokens for remote Hosts are ADR 0006.

**The TUI and commands to the browser.** `inkup` with no subcommand is the TUI; `serve` is headless. The TUI renders the
same `HostState` that `GET /api/state` returns, so tests assert what the TUI shows. The Host can ask a connected Client
to `start_session`, `pause`, `resume`, `stop` or `set_draw_mode` (`command` / `command_result` on the WebSocket, and
`POST /api/clients/<id>/commands`); the Client runs it as the panel's button would, or refuses with a reason.

## Considered options

- Host ids from the extension's item ids: `item_0001` is unique only within a run.
- Deleting items the reviewer removed: an agent's Resolution would lose its item.
- A separate "claimed" field: one more state machine; a Resolution row already carries status, agent and time.
- Shelling out to each agent's CLI for install: depends on what is installed and on each CLI's flags.

## Consequences

- An agent must call `start_item` before it touches code and leave items another agent has in work; the MCP
  instructions say so.
- Standalone (no Host) there are no Resolutions, and the card shows none.

## History

- 2026-09-23 (H3): items, Signals, `read_items`/`watch_items`/`resolve_item` and Resolutions.
- 2026-09-23 (E13): `start_item` and the `in_progress` status, with the agent's name (store migration 3).
