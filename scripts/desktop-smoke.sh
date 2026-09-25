#!/usr/bin/env bash
# Slice 1 smoke for the desktop app (apps/desktop): one host per data dir, find or host, activate. Real binaries on
# temp data dirs, port 0 throughout, so it runs next to a real InkUp. It opens app windows on this machine.
#
#   1. `inkup serve` hosts A, with a Session in its DB. The app on A comes up as its client and reads that Session.
#   3. The app hosts A. A second launch on A exits 0 and the first brings its window forward.
#   4. An app on B runs alongside, hosting B.
#   5. The `inkup` TUI on A while the app hosts it: the running message, exit 1, and the app's window comes forward.
#
# (Step 2, the host-lost banner, comes with the window's banner.) Build first:
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
kill "$CLIENT" "$SERVE"
wait "$CLIENT" "$SERVE" 2>/dev/null

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

echo
if [ "$failed" = 0 ]; then echo "desktop smoke: all steps passed"; else echo "desktop smoke: FAILED"; fi
exit "$failed"
