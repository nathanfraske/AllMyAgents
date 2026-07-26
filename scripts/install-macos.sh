#!/bin/bash
# Install AllMyAgents on macOS, with no Apple Developer ID and no Gatekeeper fight.
#
#   curl -fsSL https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh | bash
#
# WHY THIS EXISTS, and why it is not a hack.
#
# Gatekeeper does not check every app — it checks QUARANTINED apps. The `com.apple.quarantine`
# extended attribute is written by the program that did the downloading (Safari, Chrome, Mail…), not
# by macOS itself. curl does not write it. An app that was never quarantined is never shown to
# Gatekeeper, so it opens normally even though it is unsigned.
#
# That is the whole trick. There is no signature to forge, nothing disabled system-wide, and no
# security setting changed: this narrowly avoids marking OUR OWN download as untrusted-from-the-web.
# Compare the alternative we used to document — download in a browser, then `xattr -dr` the flag off
# afterwards — which reaches the identical end state with more steps and more room to get it wrong.
#
# WHAT THIS DOES NOT DO. It does not make the app notarized, and it does not make it safe by virtue of
# having run. macOS is no longer vouching for this binary; you are, because you know where it came
# from. If you did not get this URL from the AllMyAgents repo, stop. Proper notarization needs a paid
# Apple Developer ID — see docs/alpha-cut-checklist.md.
#
# Reading a script before piping it to a shell is a good habit; this one is deliberately short enough
# to do that. To install without piping:
#   curl -fsSLO https://raw.githubusercontent.com/nathanfraske/AllMyAgents/main/scripts/install-macos.sh
#   less install-macos.sh && bash install-macos.sh

set -euo pipefail

REPO="${AMA_REPO:-nathanfraske/AllMyAgents}"
APP="AllMyAgents.app"
DEST_DIR="${AMA_DEST:-/Applications}"

die() { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
say() { printf '\033[36m==>\033[0m %s\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS. On Windows use the .msi, on Linux build from source."

# Which build. Tauri names the artifacts _aarch64 (Apple Silicon) and _x64 (Intel).
case "$(uname -m)" in
  arm64) ARCH="aarch64"; ARCH_LABEL="Apple Silicon" ;;
  x86_64) ARCH="x64"; ARCH_LABEL="Intel" ;;
  *) die "unrecognised architecture '$(uname -m)'" ;;
esac
say "Mac architecture: $ARCH_LABEL ($ARCH)"

TAG="${AMA_TAG:-}"
API="https://api.github.com/repos/${REPO}/releases/latest"
[ -n "$TAG" ] && API="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"

say "Looking up the ${TAG:-latest} release..."
RELEASE_JSON="$(curl -fsSL "$API")" || die "could not reach the GitHub API. Are you online?"

VERSION="$(printf '%s' "$RELEASE_JSON" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))')"
# Match this Mac's architecture exactly. Installing an arm64 build on an Intel Mac produces
# "you can't open the application because it is not supported on this type of Mac", which looks like
# a broken app rather than the wrong download — so refuse rather than guess.
URL="$(printf '%s' "$RELEASE_JSON" | ARCH="$ARCH" /usr/bin/python3 -c '
import json, os, sys
arch = os.environ["ARCH"]
assets = json.load(sys.stdin).get("assets", [])
for a in assets:
    n = a.get("name", "")
    if n.endswith(".dmg") and ("_%s.dmg" % arch) in n:
        print(a["browser_download_url"]); break
')"
[ -n "$URL" ] || die "release ${VERSION:-latest} has no .dmg for $ARCH_LABEL ($ARCH). Ask for an ${ARCH} build to be published."

say "Downloading $VERSION for $ARCH_LABEL..."
TMP="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$TMP'; hdiutil detach '$TMP/mnt' >/dev/null 2>&1 || true" EXIT
DMG="$TMP/AllMyAgents.dmg"
# THE LOAD-BEARING LINE. curl does not set com.apple.quarantine, so what lands here is never flagged
# as web-downloaded and Gatekeeper is never consulted for it. Downloading this same file in a browser
# instead is what produces "AllMyAgents is damaged and can't be opened".
curl -fL --progress-bar -o "$DMG" "$URL" || die "download failed"

say "Mounting..."
mkdir -p "$TMP/mnt"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$TMP/mnt" >/dev/null || die "could not mount the disk image"
[ -d "$TMP/mnt/$APP" ] || die "the disk image does not contain $APP"

if [ -e "$DEST_DIR/$APP" ]; then
  say "Replacing the existing $DEST_DIR/$APP..."
  rm -rf "$DEST_DIR/$APP" 2>/dev/null || sudo rm -rf "$DEST_DIR/$APP" || die "could not remove the old install"
fi

say "Installing to $DEST_DIR..."
cp -R "$TMP/mnt/$APP" "$DEST_DIR/" 2>/dev/null || sudo cp -R "$TMP/mnt/$APP" "$DEST_DIR/" || die "could not copy into $DEST_DIR"
hdiutil detach "$TMP/mnt" >/dev/null 2>&1 || true

# Belt and braces. Nothing above should have set the flag, but a previous BROWSER download of the same
# app can leave a quarantined copy behind, and on some setups the attribute is inherited rather than
# freshly applied. Clearing it costs nothing and removes the one failure mode this script exists to
# prevent. `|| true` because there is normally no attribute to remove and that is not an error.
xattr -dr com.apple.quarantine "$DEST_DIR/$APP" 2>/dev/null || true

if xattr -p com.apple.quarantine "$DEST_DIR/$APP" >/dev/null 2>&1; then
  die "the app is still quarantined -- Gatekeeper will block it. Run: xattr -dr com.apple.quarantine '$DEST_DIR/$APP'"
fi

# The embedded Node runtime is what the hub actually runs on. If it cannot execute, the app launches
# to a window that never connects — which is a much more confusing failure than not installing at all.
NODE="$DEST_DIR/$APP/Contents/Resources/hub-runtime/node/node"
if [ -x "$NODE" ]; then
  "$NODE" --version >/dev/null 2>&1 || die "the bundled Node runtime will not execute -- the app would start but never connect"
fi

printf '\n\033[32mOK\033[0m Installed %s to %s\n\n' "${VERSION:-AllMyAgents}" "$DEST_DIR/$APP"
echo "Open it from Applications, or run:  open '$DEST_DIR/$APP'"
echo
echo "First launch needs an internet connection -- it fetches the hub's dependencies and the vendor"
echo "CLIs from npm, which takes a couple of minutes. The window says so while it works."
