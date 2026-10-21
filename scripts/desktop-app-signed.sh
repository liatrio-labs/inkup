#!/usr/bin/env bash
# A signed InkUp.app from this checkout, for local smokes that need a stable signature (TCC grants such as Screen
# Recording stick only to a stably signed bundle). It signs with the "Developer ID Application" identity in the login
# keychain, with the hardened runtime (tauri.conf.json), and does not notarize. CI's release signing is separate: it
# takes the certificate from fastlane match (apps/desktop/fastlane, ADR 0025) and is not touched here.
#
#   scripts/desktop-app-signed.sh            # a release build
#   scripts/desktop-app-signed.sh --debug    # a debug build, quicker
#
# APPLE_SIGNING_IDENTITY names the identity when the login keychain holds more than one "Developer ID Application"
# identity (its full name, or its SHA-1 from `security find-identity -v -p codesigning`).
#
# Progress goes to stderr; stdout gets one line, the bundle's path. The script exits non-zero when the identity is
# missing or ambiguous, the build fails, or `codesign --verify --deep --strict` rejects the bundle. The first
# codesign may ask for access to the keychain.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

profile=release
flags=()
for arg in "$@"; do
  case "$arg" in
    --debug) profile=debug; flags+=(--debug) ;;
    *) echo "usage: $0 [--debug]" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "a signed .app is built on macOS only" >&2; exit 2; }

say() { echo "desktop-app-signed: $*" >&2; }
die() { say "$*"; exit 1; }

# The identity: APPLE_SIGNING_IDENTITY, or the only "Developer ID Application" one in the login keychain.
login_keychain="$(security login-keychain | tr -d ' "')"
identities="$(security find-identity -v -p codesigning "$login_keychain" | sed -nE 's/^ *[0-9]+\) [0-9A-F]{40} "(Developer ID Application: .*)"$/\1/p' | sort -u)"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  identity="$APPLE_SIGNING_IDENTITY"
else
  count="$(printf '%s' "$identities" | grep -c . || true)"
  case "$count" in
    0) die "no \"Developer ID Application\" identity in the login keychain ($login_keychain)" ;;
    1) identity="$identities" ;;
    *) die "more than one \"Developer ID Application\" identity in the login keychain: set APPLE_SIGNING_IDENTITY to one of:
$identities" ;;
  esac
fi
say "signing with \"$identity\""

# Tauri signs the bundle (and everything in it) when APPLE_SIGNING_IDENTITY is set. Without the App Store Connect
# variables it skips notarization; they are cleared so a shell that has them set does not notarize a local build.
say "building the $profile .app bundle"
(cd "$ROOT/apps/desktop" &&
  env -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
    APPLE_SIGNING_IDENTITY="$identity" pnpm tauri build "${flags[@]}" --bundles app >&2) ||
  die "the build failed"

target="${CARGO_TARGET_DIR:-$ROOT/apps/desktop/src-tauri/target}"
app="$target/$profile/bundle/macos/InkUp.app"
[ -d "$app" ] || die "no bundle at $app"

codesign --verify --deep --strict --verbose=2 "$app" >&2 || die "codesign --verify --deep --strict rejected $app"
authority="$(codesign -dv --verbose=2 "$app" 2>&1 | sed -n 's/^Authority=\(Developer ID Application: .*\)$/\1/p')"
[ -n "$authority" ] || die "$app is not signed by a Developer ID Application identity"
say "signed by \"$authority\", verified"

echo "$app"
