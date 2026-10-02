#!/usr/bin/env bash
# One command for rehearsals and the recording: a Cloudflare quick tunnel, then the server with
# PUBLIC_URL set to the tunnel and hosted schedules off (agents run only on "Run now").
#
#   pnpm demo:up                                      # server on :8787, dashboard on :3000
#   DASHBOARD_ORIGINS=http://localhost:3001 pnpm demo:up
#
# Ctrl-C stops both. The tunnel URL changes on every start; Telegram buttons pick it up.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
log="$(mktemp -t syndromi-tunnel.XXXXXX)"
tunnel_pid=""

cleanup() {
  if [ -n "$tunnel_pid" ]; then kill "$tunnel_pid" 2>/dev/null || true; fi
  rm -f "$log"
}
trap cleanup EXIT INT TERM

PORT="$PORT" bash scripts/tunnel.sh >"$log" 2>&1 &
tunnel_pid=$!

url=""
for _ in $(seq 1 60); do
  url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -n 1 || true)"
  [ -n "$url" ] && break
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    echo "The tunnel exited:" >&2
    cat "$log" >&2
    exit 1
  fi
  sleep 1
done
if [ -z "$url" ]; then
  echo "No tunnel URL after 60 s; the tunnel log:" >&2
  cat "$log" >&2
  exit 1
fi

echo "Tunnel: ${url} → http://localhost:${PORT}"
echo "Starting the server (PUBLIC_URL=${url}, SYNDROMI_HOSTED_SCHEDULE=off)…"
PUBLIC_URL="$url" SYNDROMI_HOSTED_SCHEDULE=off PORT="$PORT" \
  node_modules/.bin/tsx --env-file-if-exists=.env apps/server/src/main.ts
