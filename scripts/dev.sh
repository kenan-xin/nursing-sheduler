#!/usr/bin/env bash

# Start the frontend (web/, Next.js on :3000) together with the backend that
# THIS repository ships (core/, FastAPI on :8000). Ctrl+C stops both.
#
# WHY THE DEFAULT IS THIS REPO'S core/ (G6.1 root cause, 2026-08-09)
# -----------------------------------------------------------------
# This script used to default `BACKEND_REPO` to a sibling checkout
# (`../../nurse-scheduling`) and start ITS backend. That made a foreign
# repository the implicit source of truth for a developer running this app:
# whatever route table the sibling happened to be on became the API the BFF
# talked to. A sibling checkout predating `GET /optimize/{job_id}/roster`
# therefore answered that path with FastAPI's generic `404 {"detail":"Not
# Found"}`, so every completed run downloaded its XLSX and then reported that
# its roster could not be saved — with nothing in the setup hinting that the
# backend was not this repo's.
#
# The contract is now the other way round, and it is the whole fix:
#
#   * IMPLICIT DEFAULT — `core/` in this worktree. Same source tree as the web
#     app, so the two can never disagree about which routes exist.
#   * EXPLICIT OPT-IN  — an external backend is used ONLY when BACKEND_REPO is
#     set to a non-empty value. There is no sibling fallback, so a missing or
#     unset variable can never silently redirect the app somewhere else.
#
# A port already in use is the same failure wearing a different hat: if
# something else is already serving BACKEND_API_URL, our uvicorn cannot bind and
# the app quietly keeps talking to the squatter. So the launcher probes whatever
# actually answers and refuses to continue against a backend that does not serve
# the roster route.
#
# ROUTE COMPATIBILITY IS NOT PROVENANCE (2026-08-10). Refusing an INCOMPATIBLE
# squatter was only half of it. A compatible one — a stale checkout that happens
# to be new enough, a container, an unrelated service — answers the probe exactly
# like this repository's backend does, and adopting it made a foreign PROCESS the
# implicit source of truth in the same way the sibling checkout made a foreign
# REPOSITORY one. Nothing reachable over HTTP names a worktree: `/openapi.json`
# describes routes and `/info` describes a build, so "positively established
# provenance" can only mean "explicitly declared". Adoption therefore belongs to
# the explicit contract alone:
#
#   * IMPLICIT DEFAULT — owns its backend. An occupied endpoint is refused,
#     whatever it serves.
#   * EXPLICIT OPT-IN  — BACKEND_REPO set: an already-running backend at
#     BACKEND_API_URL may be adopted, because the developer named it.
#
# The cost is deliberate: a developer whose own core/ is already running must
# stop it before rerunning this script. The normal flow — Ctrl+C, whose trap
# kills the backend it started — is unaffected.
#
# BACKEND_API_URL IS ALSO THE BIND ADDRESS (2026-08-10). The repo-core command
# used to hardcode `127.0.0.1:8000` while everything around it — the printed
# plan, the readiness wait, the BFF — used BACKEND_API_URL. Setting the override
# to any other port therefore started the backend on 8000, waited on a port
# nothing was serving, and reported that the backend never became reachable. One
# variable now decides both, and a local URL this script cannot actually serve is
# refused with guidance instead of being advertised and then ignored.
#
# Environment:
#   BACKEND_REPO    absolute path to an external backend checkout. Explicit opt-in,
#                   and the ONLY way an already-running backend may be adopted.
#   BACKEND_API_URL BFF -> backend base URL (default http://127.0.0.1:8000). For a
#                   repo-core launch this is ALSO the bind address: its host and
#                   port are what uvicorn is given.
#   PYTHON          interpreter for the repo-core backend (default: core/.venv,
#                   then the repo .venv, then the mise pin, then python3).
#
# Modes (used by web/dev-launcher.test.ts; both are side-effect free):
#   --plan               print the resolved launch plan and exit
#   --check-backend URL  probe URL for roster-route support and exit

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/web"
CORE_DIR="$REPO_ROOT/core"
BACKEND_API_URL="${BACKEND_API_URL:-http://127.0.0.1:8000}"

# The ASGI app this repository serves, and the OpenAPI path whose presence proves
# a backend is new enough to save rosters. Both are literals on purpose: the
# probe below matches this exact templated path against the served document.
BACKEND_MODULE="nurse_scheduling.serve:app"
ROSTER_ROUTE="/optimize/{job_id}/roster"

# The hosts this script is willing to bind a local backend to. Anything else is a
# URL it can probe but cannot serve, which is exactly the case that has to be
# refused rather than silently redirected to a default.
LOCAL_BIND_HOSTS="127.0.0.1 localhost 0.0.0.0 ::1"

log() { printf '\033[1;36m[dev]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[dev]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Resolution (pure — no process is started here, so `--plan` can print it)
# ---------------------------------------------------------------------------

# Prefer a project-local virtualenv, then the repo's mise pin, then whatever
# `python3` resolves to. `PYTHON` overrides everything, matching web/lib/python.ts.
resolve_python() {
  if [ -n "${PYTHON:-}" ]; then printf '%s' "$PYTHON"; return 0; fi
  if [ -x "$CORE_DIR/.venv/bin/python" ]; then printf '%s' "$CORE_DIR/.venv/bin/python"; return 0; fi
  if [ -x "$REPO_ROOT/.venv/bin/python" ]; then printf '%s' "$REPO_ROOT/.venv/bin/python"; return 0; fi
  if command -v mise > /dev/null 2>&1; then
    local pinned
    if pinned="$(mise which --cd "$REPO_ROOT" python3 2> /dev/null)" && [ -n "$pinned" ]; then
      printf '%s' "$pinned"; return 0
    fi
  fi
  printf '%s' python3
}

# Derive the local bind host/port from BACKEND_API_URL.
#
# Pure and total: on success it sets `LOCAL_BIND_HOST`/`LOCAL_BIND_PORT`, and on
# refusal it sets `LOCAL_LAUNCH_REFUSAL` to a stable reason token the plan can
# print and the tests can assert. Refusal is not failure here — an external
# backend or an already-running one may still be perfectly valid.
LOCAL_BIND_HOST=""
LOCAL_BIND_PORT=""
LOCAL_LAUNCH_REFUSAL=""

resolve_local_bind() {
  local url="$1" rest hostport host port path
  LOCAL_BIND_HOST=""; LOCAL_BIND_PORT=""; LOCAL_LAUNCH_REFUSAL=""

  case "$url" in
    http://*) rest="${url#http://}" ;;
    # TLS is a reverse proxy's job, not uvicorn's, so this is a URL the script
    # can talk to but cannot itself serve.
    https://*) LOCAL_LAUNCH_REFUSAL="tls"; return 1 ;;
    *) LOCAL_LAUNCH_REFUSAL="scheme"; return 1 ;;
  esac

  hostport="${rest%%/*}"
  path="${rest#"$hostport"}"
  # The backend is mounted at the root; a base URL with a path prefix would need a
  # proxy in front, which this script does not provide.
  if [ -n "$path" ] && [ "$path" != "/" ]; then LOCAL_LAUNCH_REFUSAL="path"; return 1; fi

  case "$hostport" in
    \[*\]*)
      host="${hostport%%\]*}"; host="${host#\[}"
      port="${hostport##*\]}"; port="${port#:}"
      ;;
    *:*) host="${hostport%%:*}"; port="${hostport##*:}" ;;
    *) host="$hostport"; port="80" ;;
  esac

  case " $LOCAL_BIND_HOSTS " in
    *" $host "*) ;;
    *) LOCAL_LAUNCH_REFUSAL="remote-host"; return 1 ;;
  esac
  case "$port" in
    '' | *[!0-9]*) LOCAL_LAUNCH_REFUSAL="port"; return 1 ;;
  esac

  LOCAL_BIND_HOST="$host"
  LOCAL_BIND_PORT="$port"
  return 0
}

# BACKEND_REPO selects an external backend ONLY when explicitly set and non-empty.
# Set-but-blank is treated as unset rather than as a selection, so an exported
# empty variable cannot half-select a backend with no path to start.
if [ -n "${BACKEND_REPO:-}" ]; then
  BACKEND_SOURCE="external"
  BACKEND_DIR="$BACKEND_REPO"
  BACKEND_START="$BACKEND_REPO/scripts/start_backend.sh"
  BACKEND_CMD="$BACKEND_START"
else
  BACKEND_SOURCE="repo-core"
  BACKEND_DIR="$CORE_DIR"
  BACKEND_START=""
  if resolve_local_bind "$BACKEND_API_URL"; then
    BACKEND_CMD="$(resolve_python) -m uvicorn $BACKEND_MODULE --host $LOCAL_BIND_HOST --port $LOCAL_BIND_PORT --reload --no-access-log"
  else
    # No command at all, rather than one bound somewhere the app is not looking.
    BACKEND_CMD=""
  fi
fi

# Why a refused local launch is worth an explicit sentence: the failure it
# replaces was a backend running perfectly well on a port nobody was talking to.
local_launch_refusal_message() {
  case "$LOCAL_LAUNCH_REFUSAL" in
    tls) printf 'BACKEND_API_URL is an https URL; this script cannot terminate TLS.' ;;
    scheme) printf 'BACKEND_API_URL is not an http:// URL.' ;;
    path) printf 'BACKEND_API_URL has a path prefix; the backend is served at the root.' ;;
    remote-host) printf 'BACKEND_API_URL points at a host this script cannot bind (%s).' "$LOCAL_BIND_HOSTS" ;;
    port) printf 'BACKEND_API_URL has no usable port.' ;;
    *) printf 'BACKEND_API_URL cannot be served locally.' ;;
  esac
}

print_plan() {
  printf 'backend_source=%s\n' "$BACKEND_SOURCE"
  printf 'backend_dir=%s\n' "$BACKEND_DIR"
  printf 'backend_cmd=%s\n' "$BACKEND_CMD"
  printf 'backend_api_url=%s\n' "$BACKEND_API_URL"
  printf 'backend_bind_host=%s\n' "$LOCAL_BIND_HOST"
  printf 'backend_bind_port=%s\n' "$LOCAL_BIND_PORT"
  printf 'backend_launch_refused=%s\n' "$LOCAL_LAUNCH_REFUSAL"
  printf 'web_dir=%s\n' "$WEB_DIR"
}

# ---------------------------------------------------------------------------
# Capability probe
# ---------------------------------------------------------------------------

# Exit 0 = serves the roster route, 1 = answers but does NOT serve it,
# 2 = nothing reachable there. The three are kept apart because they call for
# three different messages: proceed, stop and fix the backend, or start one.
probe_backend_capability() {
  local base="$1" document
  document="$(curl -fsS --max-time 5 "${base%/}/openapi.json" 2> /dev/null)" || return 2
  case "$document" in
    *"$ROSTER_ROUTE"*) return 0 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  --plan)
    print_plan
    exit 0
    ;;
  --check-backend)
    if [ -z "${2:-}" ]; then
      err "--check-backend needs a base URL"
      exit 64
    fi
    probe_backend_capability "$2"
    exit $?
    ;;
esac

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

if [ ! -d "$WEB_DIR" ]; then
  err "frontend not found at $WEB_DIR"
  exit 1
fi

if [ "$BACKEND_SOURCE" = "external" ]; then
  if [ ! -x "$BACKEND_START" ]; then
    err "BACKEND_REPO is set to $BACKEND_REPO, but $BACKEND_START is missing or not executable."
    err "Unset BACKEND_REPO to use this repository's own backend (core/)."
    exit 1
  fi
  log "Backend source: EXTERNAL (BACKEND_REPO=$BACKEND_REPO)"
  log "An external backend may lag this repo's routes; the capability check below is what catches that."
else
  if [ ! -d "$CORE_DIR/nurse_scheduling" ]; then
    err "this repository's backend package is missing at $CORE_DIR/nurse_scheduling"
    exit 1
  fi
  log "Backend source: this repository ($CORE_DIR)"
fi

# A repo-core launch whose URL cannot be bound is refused HERE, before anything
# starts. It used to be a warning that a running backend could talk us out of;
# adoption is no longer a repo-core outcome, so there is nothing left to wait and
# see about.
if [ "$BACKEND_SOURCE" = "repo-core" ] && [ -n "$LOCAL_LAUNCH_REFUSAL" ]; then
  err "Cannot start this repository's backend at $BACKEND_API_URL: $(local_launch_refusal_message)"
  err "The default launch serves core/ from THIS worktree; it will not adopt someone else's"
  err "process instead. Point BACKEND_API_URL at a local http host/port, or set BACKEND_REPO"
  err "to an external checkout you have chosen deliberately."
  exit 1
fi

# Something already answering BACKEND_API_URL owns the port; our backend could
# not bind it even if we tried. Whether that is a reason to USE it depends
# entirely on whether this launch selected it — see the provenance note at the
# top of this file.
ADOPTED_EXISTING=0
set +e
probe_backend_capability "$BACKEND_API_URL"
PREFLIGHT=$?
set -e
case "$PREFLIGHT" in
  0)
    if [ "$BACKEND_SOURCE" = "external" ]; then
      log "A backend is already serving $BACKEND_API_URL and supports the roster route — reusing it."
      log "Adopted under the explicit selection BACKEND_REPO=$BACKEND_REPO."
      ADOPTED_EXISTING=1
    else
      err "Something is already serving $BACKEND_API_URL and it DOES provide $ROSTER_ROUTE — but"
      err "this launcher did not start it and cannot tell what it is."
      err "Serving the right routes is not the same as being the right backend: a stale checkout,"
      err "a container, or an unrelated compatible service answers that probe identically. The"
      err "default launch owns this repository's backend, so it will not adopt an unowned process."
      err "Either stop it (e.g. 'lsof -nP -iTCP:${LOCAL_BIND_PORT:-8000} -sTCP:LISTEN') and rerun,"
      err "or point BACKEND_API_URL at a free local port,"
      err "or set BACKEND_REPO=<path> to declare that external backend deliberately."
      exit 1
    fi
    ;;
  1)
    err "Something is already serving $BACKEND_API_URL, but it does NOT provide $ROSTER_ROUTE."
    err "Rosters cannot be saved against it, and starting another backend would not take the port."
    err "Stop that process (e.g. 'lsof -nP -iTCP:${LOCAL_BIND_PORT:-8000} -sTCP:LISTEN'), then rerun this script."
    exit 1
    ;;
esac

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo
  log "Stopping dev servers..."
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2> /dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2> /dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2> /dev/null || true
  log "Stopped."
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

if [ "$ADOPTED_EXISTING" -eq 0 ]; then
  log "Starting backend  -> $BACKEND_API_URL  (docs: /docs)"
  if [ "$BACKEND_SOURCE" = "external" ]; then
    "$BACKEND_START" &
  else
    # cwd is core/ so `nurse_scheduling` imports from this worktree, and --reload
    # watches this worktree rather than some other checkout.
    (cd "$CORE_DIR" && exec $BACKEND_CMD) &
  fi
  BACKEND_PID=$!

  # Bounded wait, then the same capability check. A backend that starts but does
  # not serve rosters is a wrong-backend failure, not a slow one.
  BACKEND_READY=0
  for _ in $(seq 1 40); do
    if ! kill -0 "$BACKEND_PID" 2> /dev/null; then break; fi
    set +e
    probe_backend_capability "$BACKEND_API_URL"
    CAPABILITY=$?
    set -e
    if [ "$CAPABILITY" -eq 0 ]; then BACKEND_READY=1; break; fi
    if [ "$CAPABILITY" -eq 1 ]; then
      err "The backend now serving $BACKEND_API_URL does not provide $ROSTER_ROUTE."
      err "Rosters cannot be saved against it. Check BACKEND_REPO / BACKEND_API_URL."
      exit 1
    fi
    sleep 0.5
  done
  if [ "$BACKEND_READY" -eq 0 ]; then
    err "The backend did not become reachable at $BACKEND_API_URL."
    exit 1
  fi
  log "Backend is serving the roster route."
fi

log "Starting frontend -> http://127.0.0.1:3000  (web/)"
(cd "$WEB_DIR" && BACKEND_API_URL="$BACKEND_API_URL" pnpm dev) &
FRONTEND_PID=$!

echo
log "Press Ctrl+C to stop."
echo

# Exit (and trigger cleanup) as soon as either server dies.
if [ -n "$BACKEND_PID" ]; then
  wait -n "$FRONTEND_PID" "$BACKEND_PID" 2> /dev/null || true
else
  wait "$FRONTEND_PID" 2> /dev/null || true
fi
