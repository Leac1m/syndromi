#!/usr/bin/env bash
# Public HTTPS URL for the local syndromi server (phone approvals, Blinks), via a Cloudflare quick
# tunnel: no account, a random https://*.trycloudflare.com URL per run, testing use only.
#
#   pnpm tunnel                         # tunnels http://localhost:8787 (PORT to change)
#   PUBLIC_URL=<printed url> pnpm server # then start (or restart) the server with that URL
#
# cloudflared is installed into ~/.local/bin if missing: a pinned, settled release whose SHA-256 is
# checked against the value published in the release notes and GitHub's asset digest.
set -euo pipefail

VERSION="2026.9.3" # published 2026-09-24
SHA256="77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2" # cloudflared-linux-amd64
BIN="${HOME}/.local/bin/cloudflared"
PORT="${PORT:-8787}"

if command -v cloudflared >/dev/null 2>&1; then
  CF="$(command -v cloudflared)"
elif [ -x "$BIN" ]; then
  CF="$BIN"
else
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "Only linux amd64 is pinned here; install cloudflared yourself and re-run." >&2
    exit 1
  fi
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  echo "Installing cloudflared ${VERSION} into ${BIN}…" >&2
  curl -fsSL -o "$tmp" \
    "https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-linux-amd64"
  echo "${SHA256}  ${tmp}" | sha256sum -c - >&2
  mkdir -p "$(dirname "$BIN")"
  install -m 0755 "$tmp" "$BIN"
  CF="$BIN"
fi

echo "Tunnelling http://localhost:${PORT}. Look for the https://*.trycloudflare.com URL below," >&2
echo "then start the server with PUBLIC_URL set to it." >&2
exec "$CF" tunnel --no-autoupdate --url "http://localhost:${PORT}"
