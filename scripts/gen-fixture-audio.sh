#!/usr/bin/env bash
# Generate fixture WAVs (16 kHz, mono, PCM16) from macOS `say`, with deliberate silences.
# Output is committed to fixtures/audio/ so tests are deterministic on machines without `say`
# or with different voices. Re-run only when changing the scripts below.
#
# Script syntax: segments separated by "|". A segment "~1.5" is 1.5 s of silence; anything
# else is spoken text. Consecutive text segments are joined with no silence between them. Each file
# also gets a sidecar .txt holding the script, and a .timing.json with every spoken clip's start
# and end in seconds (TTS clips carry a little padding of their own).
#
# ONLY=<name> regenerates just that file.
set -euo pipefail

command -v say >/dev/null || { echo "needs macOS say" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "needs ffmpeg" >&2; exit 1; }

VOICE="${VOICE:-Samantha}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/fixtures/audio"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

make_wav() {
  local name="$1" script="$2" i=0 t=0
  if [[ -n "${ONLY:-}" && "$ONLY" != "$name" ]]; then return; fi
  local list="$TMP/$name.list"
  local timing="$TMP/$name.timing"
  : > "$list"
  : > "$timing"
  IFS='|' read -ra parts <<< "$script"
  for part in "${parts[@]}"; do
    part="$(echo "$part" | sed 's/^ *//;s/ *$//')"
    i=$((i + 1))
    local seg="$TMP/$name-$i.wav"
    if [[ "$part" == ~* ]]; then
      ffmpeg -loglevel error -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t "${part#\~}" -c:a pcm_s16le "$seg"
    else
      say -v "$VOICE" -o "$TMP/$name-$i.aiff" "$part"
      ffmpeg -loglevel error -y -i "$TMP/$name-$i.aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$seg"
    fi
    local dur
    dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$seg")"
    if [[ "$part" != ~* ]]; then
      printf '%s\t%s\t%s\n' "$t" "$(echo "$t + $dur" | bc -l)" "$part" >> "$timing"
    fi
    t="$(echo "$t + $dur" | bc -l)"
    echo "file '$seg'" >> "$list"
  done
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$list" -ar 16000 -ac 1 -c:a pcm_s16le -bitexact "$OUT/$name.wav"
  echo "$script" > "$OUT/$name.txt"
  awk -F'\t' 'BEGIN { printf "[" } { printf "%s\n  {\"start\": %.3f, \"end\": %.3f, \"text\": \"%s\"}", (NR > 1 ? "," : ""), $1, $2, $3 } END { print "\n]" }' "$timing" > "$OUT/$name.timing.json"
  echo "wrote fixtures/audio/$name.wav"
}

# (1) Reviewer mis-speaks and discards it with a Voice Command.
make_wav review-scratch-that "~0.5|this button|~1.5|should go here, and make it smaller|~1.5|scratch that|~1.5"
# (2) Two deictic observations separated by a Speech Boundary.
make_wav review-two-notes "~0.5|make this button bigger|~1.5|and this card should be the same height as that one|~1.5"
# (3) Voice Commands only, each surrounded by silence.
make_wav voice-commands "~0.5|next|~1.5|pin that|~1.5|snap|~1.5|pause|~1.5|resume|~1.5"
# (4) The Voice Command e2e (tests/e2e/voice-commands.spec.ts): a note, "scratch that" between silences, a
# "pause" inside continuous speech (three clips joined with no gap), then "pause" between silences.
make_wav voice-session "~2|this button|~1.5|scratch that|~2|the video should|pause|here when it loads|~1.5|pause|~4"
# (5) The Draft Item e2e (tests/e2e/drafts.spec.ts): a note on the CTA, a long silence for the draft pass, "pin
# that" between silences, then a second note, and trailing silence so the looped file stays quiet for the test.
make_wav drafts-session "~2|this button should go in the header|~11|pin that|~3|make this card taller|~20"
# (6) The marketing site's captures (tests/e2e/site-captures.spec.ts) on fixtures/site/demo-store.html: three review
# notes, each made while a Stroke is drawn, with room between them for a Draft Item pass, then a long quiet tail.
make_wav site-demo "~1.5|make this button the first thing people see|~3.5|this headline is too long|~3.5|the price here should say per month|~25"
