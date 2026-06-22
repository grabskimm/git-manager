#!/usr/bin/env sh
# GitManager installer for macOS and Linux.
#
# Downloads the latest desktop installer from GitHub Releases and installs it,
# upgrading in place if GitManager is already installed.
#
#   curl -fsSL https://raw.githubusercontent.com/grabskimm/git-manager/main/install.sh | sh
#
# Options (env vars):
#   GM_VERSION=v1.2.3   install a specific tag instead of the latest release
#   GM_REPO=owner/repo  override the source repo (default grabskimm/git-manager)
set -eu

REPO="${GM_REPO:-grabskimm/git-manager}"
API="https://api.github.com/repos/${REPO}/releases"

err() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

have curl || err "curl is required"

# Resolve the release JSON (a specific tag, or the latest).
if [ -n "${GM_VERSION:-}" ]; then
  RELEASE_URL="${API}/tags/${GM_VERSION}"
else
  RELEASE_URL="${API}/latest"
fi

info "Fetching release metadata for ${REPO}…"
JSON="$(curl -fsSL "$RELEASE_URL")" || err "could not fetch release metadata (is there a published release yet?)"

# Pick the first asset whose download URL ENDS WITH the given extension. Anchoring
# on end-of-line avoids matching electron-builder's ".dmg.blockmap" sidecar files.
asset_for() {
  printf '%s\n' "$JSON" \
    | grep -o '"browser_download_url"[ ]*:[ ]*"[^"]*"' \
    | sed 's/.*"\(https[^"]*\)".*/\1/' \
    | grep -iE -- "$1\$" \
    | head -n1
}

OS="$(uname -s)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$OS" in
  Darwin)
    URL="$(asset_for '.dmg')"
    [ -n "$URL" ] || err "no macOS .dmg asset found in the release"
    DMG="$TMP/GitManager.dmg"
    info "Downloading $(basename "$URL")…"
    curl -fSL --progress-bar "$URL" -o "$DMG"

    info "Mounting image…"
    MNT="$(hdiutil attach -nobrowse -noautoopen "$DMG" | grep -o '/Volumes/.*' | head -n1)"
    [ -n "$MNT" ] || err "could not mount the .dmg"
    APP="$(/bin/ls -d "$MNT"/*.app 2>/dev/null | head -n1)"
    [ -n "$APP" ] || { hdiutil detach "$MNT" >/dev/null 2>&1 || true; err "no .app inside the image"; }

    DEST="/Applications/$(basename "$APP")"
    if [ -d "$DEST" ]; then
      info "Upgrading existing install at $DEST…"
      rm -rf "$DEST"
    else
      info "Installing to $DEST…"
    fi
    cp -R "$APP" /Applications/
    hdiutil detach "$MNT" >/dev/null 2>&1 || true
    # Clear the quarantine flag so an unsigned build still opens.
    xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
    info "Done. Launch GitManager from /Applications (or: open \"$DEST\")."
    ;;

  Linux)
    URL="$(asset_for '.appimage')"
    [ -n "$URL" ] || err "no Linux .AppImage asset found in the release"
    BINDIR="${GM_BINDIR:-$HOME/.local/bin}"
    mkdir -p "$BINDIR"
    DEST="$BINDIR/GitManager.AppImage"
    [ -e "$DEST" ] && info "Upgrading existing install at $DEST…" || info "Installing to $DEST…"
    info "Downloading $(basename "$URL")…"
    curl -fSL --progress-bar "$URL" -o "$DEST.tmp"
    chmod +x "$DEST.tmp"
    mv -f "$DEST.tmp" "$DEST"
    # Convenience launcher on PATH.
    ln -sf "$DEST" "$BINDIR/gitmanager-app"
    info "Done. Run: $BINDIR/gitmanager-app  (or launch $DEST directly)."
    case ":$PATH:" in
      *":$BINDIR:"*) : ;;
      *) info "Note: $BINDIR is not on your PATH — add it to use 'gitmanager-app'." ;;
    esac
    ;;

  *)
    err "unsupported OS '$OS' — on Windows use install.ps1 instead"
    ;;
esac
