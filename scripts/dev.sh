#!/usr/bin/env bash

# Start the REBUILD frontend (web/, Next.js on :3000) together with the shared
# nurse-scheduling backend (FastAPI on :8000). Ctrl+C stops both.
#
# The backend lives in a sibling repo. Override its location with BACKEND_REPO
# if it is not at ../nurse-scheduling. Override the BFF -> backend URL with
# BACKEND_API_URL (only the Optimize/export flow needs the backend; the editors
# are client-side).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
WEB_DIR="$SCRIPT_DIR/../web"
BACKEND_REPO="${BACKEND_REPO:-$SCRIPT_DIR/../../nurse-scheduling}"
START_BACKEND="$BACKEND_REPO/scripts/start_backend.sh"
BACKEND_API_URL="${BACKEND_API_URL:-http://127.0.0.1:8000}"

BACKEND_PID=""
FRONTEND_PID=""

log() { printf '\033[1;36m[dev]\033[0m %s\n' "$*"; }

cleanup() {
  echo
  log "Stopping dev servers..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  log "Stopped."
}
trap cleanup EXIT INT TERM

if [ ! -x "$START_BACKEND" ]; then
  echo "Error: backend start script not found/executable at $START_BACKEND" >&2
  echo "Set BACKEND_REPO=/path/to/nurse-scheduling if the backend lives elsewhere." >&2
  exit 1
fi
if [ ! -d "$WEB_DIR" ]; then
  echo "Error: rebuild frontend not found at $WEB_DIR" >&2
  exit 1
fi

log "Starting backend  -> $BACKEND_API_URL  (docs: /docs)"
"$START_BACKEND" &
BACKEND_PID=$!

log "Starting frontend -> http://127.0.0.1:3000  (rebuild: web/)"
( cd "$WEB_DIR" && BACKEND_API_URL="$BACKEND_API_URL" pnpm dev ) &
FRONTEND_PID=$!

echo
log "Both servers are starting. Press Ctrl+C to stop both."
echo

# Exit (and trigger cleanup) as soon as either server dies.
wait -n "$FRONTEND_PID" "$BACKEND_PID" 2>/dev/null || true
