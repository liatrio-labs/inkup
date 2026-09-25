#!/usr/bin/env bash
# Smoke for the desktop app (apps/desktop): one host per data dir, find or host, activate, Host here, and the menu
# bar and Dock toggles. Real binaries on temp data dirs, port 0 throughout, so it runs next to a real InkUp. It
# opens app windows on this machine, and drives the window and the tray through macOS accessibility (osascript and
# System Events: the terminal needs Accessibility access).
#
#   1. `inkup serve` hosts A, with a Session in its DB. The app on A comes up as its client and reads that Session.
#   2. Quit serve: the window shows "The InkUp host stopped"; its "Host here" button makes the app host A.
#   3. The app hosts A. A second launch on A exits 0 and the first brings its window forward.
#   4. An app on B runs alongside, hosting B.
#   5. The `inkup` TUI on A while the app hosts it: the running message, exit 1, and the app's window comes forward.
#   6. On B, the tray's "Show in Dock" off: saved in config.toml, and still off (the last one on, so locked) after
#      Quit and a relaunch.
#
# Build first:
#   cargo build --manifest-path host/Cargo.toml -p inkup
#   pnpm -C apps/desktop tauri build --debug --no-bundle
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INKUP="$ROOT/host/target/debug/inkup"
APP="$ROOT/apps/desktop/src-tauri/target/debug/inkup-desktop"
for bin in "$INKUP" "$APP"; do
  [ -x "$bin" ] || { echo "missing $bin: build it first (see the top of this script)"; exit 2; }
done

WORK="$(mktemp -d)"
A="$WORK/A"
B="$WORK/B"
PIDS=()
failed=0
# A scrubbed environment: only the temp data dirs, never the user's.
run() { env -u INKUP_DATA_DIR RUST_LOG=info "$@"; }
# In the background, with $! the binary's own pid (env execs it).
start() { env -u INKUP_DATA_DIR RUST_LOG=info "$@" & }
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; failed=1; }
# Waits up to 15 s for a pattern in a file.
wait_for() {
  for _ in $(seq 150); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
  return 1
}
field() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$1/host.json','utf8')).$2))"; }
# GET /api/host/state with the control token: what the app's window reads through its commands.
state() {
  curl -sf -H "Authorization: Bearer $(field "$1" control_token)" "http://127.0.0.1:$(field "$1" port)/api/host/state"
}

# Presses the button titled $2 in the window of pid $1 (AXPress), once it shows: up to 15 s.
press_button() {
  for _ in $(seq 30); do
    osascript - "$1" "$2" <<'OSA' | grep -q '^pressed' && return 0
on run argv
  tell application "System Events"
    set els to entire contents of window 1 of (first process whose unix id is ((item 1 of argv) as integer))
    repeat with i from 1 to count of els
      set el to item i of els
      try
        if value of attribute "AXRole" of el is "AXButton" and value of attribute "AXTitle" of el is (item 2 of argv) then
          perform action "AXPress" of el
          return "pressed"
        end if
      end try
    end repeat
  end tell
  return "not yet"
end run
OSA
    sleep 0.5
  done
  return 1
}
# The tray menu of pid $1: presses item $2 when given, else prints each item as name|enabled|check mark.
tray() {
  osascript - "$@" <<'OSA'
on run argv
  tell application "System Events"
    tell (first process whose unix id is ((item 1 of argv) as integer))
      set bar to menu bar item 1 of (last menu bar)
      click bar
      delay 0.4
      set m to menu 1 of bar
      if (count of argv) > 1 then
        click menu item (item 2 of argv) of m
        return "pressed " & (item 2 of argv)
      end if
      set out to ""
      repeat with entry in menu items of m
        set mark to ""
        try
          set mark to value of attribute "AXMenuItemMarkChar" of entry
        end try
        if mark is missing value then set mark to ""
        set out to out & (name of entry) & "|" & (enabled of entry) & "|" & mark & linefeed
      end repeat
      key code 53
      return out
    end tell
  end tell
end run
OSA
}

echo "== 1. inkup serve hosts A; the app on A is its client"
start "$INKUP" serve --data-dir "$A" --port 0 --auto-approve-pairing >"$WORK/serve.out" 2>"$WORK/serve.err"
PIDS+=($!)
SERVE=$!
wait_for "$WORK/serve.out" "inkup listening" || fail "serve did not start: $(cat "$WORK/serve.err")"
PORT_A="$(sed -n 's/.*127.0.0.1:\([0-9]*\).*/\1/p' "$WORK/serve.out" | head -1)"
# A paired Client records a Session on A: the contract fixtures over a real WebSocket.
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const fx = (n) => readFileSync('$ROOT/contract/fixtures/' + n, 'utf8');
  const ws = new WebSocket('ws://127.0.0.1:$PORT_A/ws');
  ws.onopen = () => ws.send(fx('hello.unpaired.json'));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'welcome') ws.send(fx('event.session_start.json'));
    if (msg.type === 'ack') { ws.close(); process.exit(0); }
  };
  setTimeout(() => { console.error('no ack'); process.exit(1); }, 10000);
" || fail "could not record a Session on A"
start "$APP" --data-dir "$A" --port 0 >"$WORK/app-client.log" 2>&1
PIDS+=($!)
CLIENT=$!
if wait_for "$WORK/app-client.log" "Client of inkup serve on 127.0.0.1:$PORT_A"; then
  pass "the app on A is a client of inkup serve on 127.0.0.1:$PORT_A"
else
  fail "the app on A did not come up as a client: $(cat "$WORK/app-client.log")"
fi
if state "$A" | grep -q '"title":"Pricing Fixture"'; then
  pass "the control API the app reads lists A's Session (Pricing Fixture)"
else
  fail "A's Session is not in /api/host/state"
fi

echo "== 2. serve quits; the window's Host here takes A over"
# Ctrl-C, as a user quits it: serve gives up the data dir.
kill -INT "$SERVE"
wait "$SERVE" 2>/dev/null
if press_button "$CLIENT" "Host here"; then
  pass "the window showed the host-lost banner, and Host here was pressed"
else
  fail "no Host here button in the window"
fi
if wait_for "$WORK/app-client.log" "Host here: Hosting on" && [ "$(field "$A" kind)" = desktop ] \
  && [ "$(field "$A" pid)" = "$CLIENT" ]; then
  pass "the app hosts A ($(grep -o 'Host here: Hosting on [0-9.:]*' "$WORK/app-client.log"); host.json: desktop, pid $CLIENT)"
else
  fail "Host here did not take A over: $(cat "$WORK/app-client.log")"
fi
if state "$A" | grep -q '"title":"Pricing Fixture"'; then
  pass "A's Session is still there, now read from the app's own server"
else
  fail "A's Session is not in the app's /api/host/state"
fi
kill "$CLIENT"
wait "$CLIENT" 2>/dev/null

echo "== 3. the app hosts A; a second launch brings it forward and exits 0"
start "$APP" --data-dir "$A" --port 0 >"$WORK/app-a.log" 2>&1
PIDS+=($!)
wait_for "$WORK/app-a.log" "Hosting on" && pass "the app hosts A ($(grep -o 'Hosting on [0-9.:]*' "$WORK/app-a.log"))" \
  || fail "the app did not host A: $(cat "$WORK/app-a.log")"
run "$APP" --data-dir "$A" --port 0 >"$WORK/app-a2.log" 2>&1
code=$?
[ "$code" = 0 ] && grep -q "InkUp is already running (desktop app" "$WORK/app-a2.log" \
  && pass "second launch exited $code: $(grep 'already running' "$WORK/app-a2.log")" \
  || fail "second launch exited $code: $(cat "$WORK/app-a2.log")"
wait_for "$WORK/app-a.log" "another launch asked for the window" && pass "the first app brought its window forward" \
  || fail "the first app was not asked to come forward"

echo "== 4. an app on B runs alongside"
start "$APP" --data-dir "$B" --port 0 >"$WORK/app-b.log" 2>&1
PIDS+=($!)
if wait_for "$WORK/app-b.log" "Hosting on" && [ "$(field "$B" kind)" = desktop ] \
  && [ "$(field "$B" port)" != "$(field "$A" port)" ]; then
  pass "the app hosts B on port $(field "$B" port), A still on $(field "$A" port)"
else
  fail "the app on B did not host: $(cat "$WORK/app-b.log")"
fi

echo "== 5. the inkup TUI on A while the app hosts it"
before="$(grep -c "another launch asked for the window" "$WORK/app-a.log")"
run "$INKUP" --data-dir "$A" --port 0 </dev/null >"$WORK/tui.out" 2>"$WORK/tui.err"
code=$?
[ "$code" = 1 ] && grep -q "InkUp is already running (desktop app, pid [0-9]*, port [0-9]*). Use --data-dir" "$WORK/tui.err" \
  && pass "TUI exited $code: $(cat "$WORK/tui.err")" || fail "TUI exited $code: $(cat "$WORK/tui.err")"
for _ in $(seq 50); do
  [ "$(grep -c "another launch asked for the window" "$WORK/app-a.log")" -gt "$before" ] && break
  sleep 0.1
done
[ "$(grep -c "another launch asked for the window" "$WORK/app-a.log")" -gt "$before" ] \
  && pass "the app's window came forward for the TUI" || fail "the TUI did not bring the app forward"

echo "== 6. the Dock toggle, from the tray, survives Quit and a relaunch"
# System Events finds a process by name, so with two apps up it may drive the other one's tray: A goes first.
APP_A="$(field "$A" pid)"
kill "$APP_A"
wait "$APP_A" 2>/dev/null
APP_B="$(field "$B" pid)"
pressed="$(tray "$APP_B" "Show in Dock" 2>&1)"
if wait_for "$WORK/app-b.log" "menu bar on, Dock off" && grep -q '^dock = false' "$B/config.toml"; then
  pass "Show in Dock off: $(grep -A2 '^\[desktop\]' "$B/config.toml" | tr '\n' ' ')"
else
  fail "the Dock toggle was not saved ($pressed): $(cat "$WORK/app-b.log")"
fi
pressed="$(tray "$APP_B" "Quit InkUp" 2>&1)"
for _ in $(seq 50); do kill -0 "$APP_B" 2>/dev/null || break; sleep 0.1; done
if ! kill -0 "$APP_B" 2>/dev/null && [ ! -e "$B/host.json" ]; then
  pass "Quit InkUp stopped the app and gave up B"
else
  fail "Quit InkUp left the app or host.json behind ($pressed)"
fi
start "$APP" --data-dir "$B" --port 0 >"$WORK/app-b2.log" 2>&1
PIDS+=($!)
APP_B=$!
if wait_for "$WORK/app-b2.log" "menu bar on, Dock off"; then
  menu="$(tray "$APP_B")"
  if echo "$menu" | grep -q '^Show in Dock|true|$' && echo "$menu" | grep -q '^Show in Menu Bar|false|✓$'; then
    pass "relaunched with the Dock off: Show in Dock unchecked; Show in Menu Bar checked and locked on"
  else
    fail "the tray does not match: $menu"
  fi
else
  fail "the relaunch did not read the toggles: $(cat "$WORK/app-b2.log")"
fi

echo
if [ "$failed" = 0 ]; then echo "desktop smoke: all steps passed"; else echo "desktop smoke: FAILED"; fi
exit "$failed"
