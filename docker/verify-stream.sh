#!/usr/bin/env bash
# Release-blocking ASSEMBLED streaming gate (T16). Unlike `verify-deploy.sh` (which
# probes the PRIVATE base over the internal network and never streams), this gate
# brings up the DIRECT overlay — base `compose.yml` + `compose.direct.yml` — so the
# Next BFF is published on a real host port, and drives the durable Optimize &
# Export SSE run protocol end to end through the assembled Browser→Next→FastAPI
# path.
#
# The gate is a sequence of FAIL-FAST STAGES. Each job-owning stage submits work,
# asserts real product outcomes, and cleans up the ids it created:
#
#   setup         build + up + health + base-topology keepalive-default proof
#   curl live     streaming, disconnect pollability, nonterminal cancel, replay, cleanup
#   curl tiny     completion, real XLSX, content-disposition, DELETE, final 404
#   browser t/r   real Chromium tiny + replay against the published port, no interception
#   browser abort real `/about` navigation, baselined BFF audit, ids-only handoff cleanup
#
# At every stage boundary, ANY assertion, command, authority or cleanup failure
# releases every id it can safely release, tears Compose down, runs all five residue
# checks (containers, images, networks, volumes, browser downloads), exits non-zero,
# and NEVER starts the next job-owning stage. A setup/health failure stops before the
# first submission. A global failure count is never permission to continue.
#
# There is no reporter, classifier, verdict channel or synthetic broken-navigation
# lane: each stage's own product assertions and lifecycle results decide the verdict.
# The browser abort lane proves its navigation DIRECTLY — a committed same-origin
# main-frame response at exactly `/about`, the settled URL, and the old fixture gone —
# and hands the shell ONLY the accepted job ids it observed. The shell audits NEW BFF
# log entries BEFORE any abort cleanup, so cleanup can never manufacture the evidence
# it is audited against. Cleanup-success output below is observational only; nothing
# parses it, and no process derives a pass/fail decision from it.
#
# Everything is bounded (`curl --max-time`, Playwright timeouts) so the gate cannot
# hang. A PID-scoped project name AND a collision-safe host port (bounded retry on
# Compose bind failure) keep it isolated. Browser-phase failure or pnpm unavailability
# fails the entire gate. There is no degraded "skip" path.
#
# The production Cloudflare NAMED-TUNNEL streaming validation stays optional/manual
# (it needs external Cloudflare state); its absence does NOT weaken this direct gate.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_VERSION="${APP_VERSION:-$(git describe --tags --always --dirty 2>/dev/null)}"
if [ -z "$APP_VERSION" ]; then
  echo "FAIL: APP_VERSION is empty (git describe failed)" >&2
  exit 1
fi
export APP_VERSION

PROJECT="nsvs-$$"
BASE_COMPOSE="docker compose -p $PROJECT -f docker/compose.yml -f docker/compose.direct.yml"
COMPOSE="docker compose -p $PROJECT -f docker/compose.yml -f docker/compose.direct.yml -f docker/compose.verify-stream.yml"
# Collision-safe port allocation via bounded retry on Compose bind failure.
# Each attempt discovers a kernel-assigned free loopback port and immediately
# asks Compose to bind it. If the bind fails (another process claimed the port
# in the tiny TOCTOU window between discovery and bind), retry with a NEW
# port. Up to MAX_PORT_ATTEMPTS attempts — the probability of collision on 5
# random ephemeral ports is negligible. The alternative (holding a socket FD
# and passing it to Docker) is not supported by Docker's port publishing.
WEB_BIND_ADDRESS="127.0.0.1"
MAX_PORT_ATTEMPTS=5
# Compose names built images `<project>-<service>`; remove them on exit.
PROJECT_IMAGES="${PROJECT}-web ${PROJECT}-backend"

# Deterministic solver inputs (see docker/README.md streaming-gate section):
#   TINY  — 1 nurse / 1 shift / 1 day: feasible, solves ~instantly to optimal.
#           Used for the terminal artifact + download + DELETE path.
#   LARGE — real 87-person ward: with a long client timeout it stays LIVE long
#           enough to observe streaming, cursors, replay, and a mid-flight cancel.
TINY_YAML="core/tests/testcases/basics/01_1nurse_1shift_1day.yaml"
LARGE_YAML="core/tests/testcases/real/large-ward-with-87-people-2025-11.yaml"
LIVE_TIMEOUT=120          # solver native timeout for the LARGE live job (seconds)
STREAM_WINDOW=8           # bounded first-stream window; short so the live cancel below
                          # lands while the job is still running (it stays live >15s)
RECONNECT_WINDOW=6        # bounded replay-reconnect window (runs against retained events)
POLL_MAX=8                # per-request curl deadline for polls/controls

# Shell-side mirror of the Ticket 1 cleanup allocation, in seconds. One id's WHOLE
# lifecycle composes into CLEANUP_LIFECYCLE_MAX: cancel, the bounded terminal proof and
# the safe DELETE all share a single mutation budget, and the final GET keeps a reserve
# no earlier phase can borrow. Per-phase ceilings alone are not enough — 8s cancel plus
# a 37s window whose last poll overruns plus a full delete plus a full final GET would
# exceed the total, so every phase is also capped to the remaining budget.
CLEANUP_LIFECYCLE_MAX=65
CLEANUP_CANCEL_MAX=8
CLEANUP_TERMINAL_MAX=37
CLEANUP_DELETE_MAX=8
CLEANUP_FINAL_MAX=8

WORKDIR="$(mktemp -d)"
ABORT_HANDOFF="$WORKDIR/abort-handoff.json"
TMP_SEQ=0
# $BASHPID keeps concurrent cleanup subshells (which each inherit their own copy of
# TMP_SEQ) from choosing — and deleting — the same scratch file.
tmpfile() { TMP_SEQ=$((TMP_SEQ + 1)); printf '%s/tmp-%s-%04d' "$WORKDIR" "$BASHPID" "$TMP_SEQ"; }

PASS=0
FAIL=0
STAGE_NAME="setup"
STAGE_FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
# Every failure counts against the CURRENT stage as well as the run, so the stage
# boundary below can contain it. The run-wide count is only ever used for reporting.
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); STAGE_FAIL=$((STAGE_FAIL + 1)); }

stage() { STAGE_NAME="$1"; STAGE_FAIL=0; echo "== $1 =="; }

# Clean up stale browser download artifacts from prior runs so the zero-residue
# audit is accurate. Current tests use Playwright's managed temp (download.path()).
rm -f /tmp/ns-test-download-*.xlsx 2>/dev/null || true

cleanup() {
  # -v drops the throwaway redis volume; --rmi local removes this project's built
  # web/backend images (the pinned redis image has a registry name and is kept).
  $COMPOSE down -v --rmi local -t 3 >/dev/null 2>&1 || true
  # Belt-and-suspenders: drop the PID-scoped images by name in case `down` raced.
  docker image rm -f $PROJECT_IMAGES >/dev/null 2>&1 || true
  rm -rf "$WORKDIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------------------
# Known-id registry and the shell-owned cleanup lifecycle
# ---------------------------------------------------------------------------

# Every id this gate creates or is handed is registered the moment it is known, so a
# failure at any boundary can still release it.
KNOWN_IDS=()
register_id() {
  KNOWN_IDS+=("$1")
  echo "  registered job id for cleanup: $1"
}
unregister_id() {
  local keep=() existing
  if [ "${#KNOWN_IDS[@]}" -gt 0 ]; then
    for existing in "${KNOWN_IDS[@]}"; do
      [ "$existing" = "$1" ] || keep+=("$existing")
    done
  fi
  KNOWN_IDS=()
  if [ "${#keep[@]}" -gt 0 ]; then KNOWN_IDS=("${keep[@]}"); fi
  return 0
}

# phase_timeout <deadline_epoch> <ceiling_seconds>
#
# Echo this phase's bounded timeout — the smaller of its own ceiling and whatever is
# left before the deadline — or return 1 when the deadline leaves no time at all.
phase_timeout() {
  local deadline="$1" ceiling="$2" remaining
  remaining=$(( deadline - $(date +%s) ))
  [ "$remaining" -le 0 ] && return 1
  [ "$remaining" -lt "$ceiling" ] && ceiling="$remaining"
  printf '%s' "$ceiling"
  return 0
}

# cleanup_job_lifecycle <job_id>
#
# Cancel (exactly 202 or 404) -> bounded terminal proof -> DELETE only after that
# proof -> the reserved final GET, attempted unconditionally on every branch, which
# must return exactly 404. Returns 0 only when the whole lifecycle held.
cleanup_job_lifecycle() {
  # Separate statements on purpose: a single `local a="$1" b="...$a"` expands the whole
  # command line before assigning anything, so `$a` would still be unset there.
  local id="$1"
  local base="$BASE/api/optimize/$id"
  local code out state timeout terminal=0 absent=0 broken=0
  local final_deadline mutation_deadline terminal_deadline
  final_deadline=$(( $(date +%s) + CLEANUP_LIFECYCLE_MAX ))
  mutation_deadline=$(( final_deadline - CLEANUP_FINAL_MAX ))

  if timeout="$(phase_timeout "$mutation_deadline" "$CLEANUP_CANCEL_MAX")"; then
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$timeout" \
      -X POST "$base/cancel" 2>/dev/null || echo 000)"
    case "$code" in
      202) echo "    cleanup $id: cancel -> 202" ;;
      404) echo "    cleanup $id: cancel -> 404 (already absent)"; absent=1 ;;
      *)   echo "    cleanup $id: cancel -> $code (expected exactly 202 or 404)"; broken=1 ;;
    esac
  else
    echo "    cleanup $id: cancel had no time left before the reserved final GET"
    broken=1
  fi

  if [ "$absent" -eq 0 ] && [ "$broken" -eq 0 ]; then
    terminal_deadline=$(( $(date +%s) + CLEANUP_TERMINAL_MAX ))
    [ "$terminal_deadline" -gt "$mutation_deadline" ] && terminal_deadline="$mutation_deadline"
    while timeout="$(phase_timeout "$terminal_deadline" "$POLL_MAX")"; do
      out="$(tmpfile)"
      code="$(curl -sS -o "$out" -w '%{http_code}' --max-time "$timeout" "$base" 2>/dev/null || echo 000)"
      if [ "$code" = 404 ]; then absent=1; rm -f "$out"; break; fi
      if [ "$code" != 200 ]; then
        echo "    cleanup $id: status -> $code (expected 200 or 404)"; broken=1; rm -f "$out"; break
      fi
      state="$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$out" | head -n1)"
      rm -f "$out"
      case "$state" in
        completed|cancelled|failed) terminal=1; echo "    cleanup $id: terminal state proved ($state)"; break ;;
        queued|running|cancelling) ;;
        *) echo "    cleanup $id: status body malformed (state='$state')"; broken=1; break ;;
      esac
      sleep 1
    done
    if [ "$terminal" -eq 0 ] && [ "$absent" -eq 0 ] && [ "$broken" -eq 0 ]; then
      echo "    cleanup $id: no terminal proof within the ${CLEANUP_TERMINAL_MAX}s window"
      broken=1
    fi
  fi

  # A job is only safe to DELETE once it is proved terminal.
  if [ "$terminal" -eq 1 ]; then
    if timeout="$(phase_timeout "$mutation_deadline" "$CLEANUP_DELETE_MAX")"; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$timeout" \
        -X DELETE "$base" 2>/dev/null || echo 000)"
      case "$code" in
        204|404) echo "    cleanup $id: delete -> $code" ;;
        *) echo "    cleanup $id: delete -> $code (expected 204 or 404)"; broken=1 ;;
      esac
    else
      echo "    cleanup $id: delete had no time left before the reserved final GET"
      broken=1
    fi
  fi

  # Reserved and unconditional. An earlier failure may suppress an unsafe DELETE; it
  # never suppresses the absence proof. The reserve is always at least one second.
  timeout=$(( final_deadline - $(date +%s) ))
  [ "$timeout" -gt "$CLEANUP_FINAL_MAX" ] && timeout="$CLEANUP_FINAL_MAX"
  [ "$timeout" -lt 1 ] && timeout=1
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$timeout" "$base" 2>/dev/null || echo 000)"
  if [ "$code" = 404 ]; then
    echo "    cleanup success $id: final GET 404"
  else
    echo "    cleanup $id: final GET -> $code (expected exact 404)"
    broken=1
  fi

  return "$broken"
}

# Best-effort release of every distinct registered id, used on the containment path.
release_known_ids() {
  local id seen=""
  if [ -z "${BASE:-}" ]; then
    echo "  no published base URL yet — no job id can be released"
    return 0
  fi
  if [ "${#KNOWN_IDS[@]}" -eq 0 ]; then
    echo "  no registered job ids to release"
    return 0
  fi
  echo "  releasing ${#KNOWN_IDS[@]} registered job id(s) before teardown"
  for id in "${KNOWN_IDS[@]}"; do
    case " $seen " in *" $id "*) continue ;; esac
    seen="$seen $id"
    cleanup_job_lifecycle "$id" || true
  done
  KNOWN_IDS=()
  return 0
}

# check_residue <label> <project_pattern> <enumeration command...>
#
# An enumeration that FAILS is not zero residue. Suppressing the error and counting an
# empty stream would print PASS without a completed check, so the command's exit status
# is captured and a failure is reported red as UNKNOWN.
check_residue() {
  local label="$1" pattern="$2"
  shift 2
  local listing status count
  listing="$("$@" 2>/dev/null)"
  status=$?
  if [ "$status" -ne 0 ]; then
    bad "could not enumerate $label for $PROJECT (exit $status) — residue UNKNOWN, not zero"
    return 1
  fi
  count="$(printf '%s\n' "$listing" | grep -c "$pattern" || true)"
  count="${count:-0}"
  if [ "$count" -eq 0 ]; then
    ok "no leftover $label for $PROJECT"
    return 0
  fi
  bad "$count leftover $label for $PROJECT"
  return 1
}

# The five residue checks: containers, images, networks, volumes, browser downloads.
residue_audit() {
  local residue=0 listing status count
  check_residue containers "^${PROJECT}[-_]" docker ps -a --format '{{.Names}}' || residue=1
  check_residue images "^${PROJECT}-" docker image ls --format '{{.Repository}}' || residue=1
  check_residue networks "^${PROJECT}_" docker network ls --format '{{.Name}}' || residue=1
  check_residue volumes "^${PROJECT}_" docker volume ls --format '{{.Name}}' || residue=1

  # Browser download artifact residue: Playwright manages temp downloads, but
  # assert no ns-test-download files leaked from a prior or current run.
  listing="$(find /tmp -maxdepth 1 -name 'ns-test-download-*.xlsx' 2>/dev/null)"
  status=$?
  if [ "$status" -ne 0 ]; then
    bad "could not enumerate browser download artifacts (exit $status) — residue UNKNOWN, not zero"
    residue=1
  else
    count="$(printf '%s' "$listing" | grep -c . || true)"
    count="${count:-0}"
    if [ "$count" -eq 0 ]; then
      ok "no leftover browser download artifacts"
    else
      bad "$count leftover browser download artifact(s) in /tmp"
      residue=1
    fi
  fi
  return "$residue"
}

# Set immediately before a boundary that is reached through LOST AUTHORITY, where the
# job set itself is untrustworthy. Such a boundary must NOT run the normal per-id
# lifecycle: that is exactly the "normal cleanup" lost authority excludes, and its cost
# would scale with the bogus cardinality. Compose teardown below destroys the stack and
# every job inside it, so nothing outlives the run either way.
LOST_AUTHORITY=0

# The fail-fast stage boundary. A failed stage can never hand work to a later one.
boundary() {
  [ "$STAGE_FAIL" -eq 0 ] && return 0
  echo "== CONTAINED: stage '$STAGE_NAME' failed ($STAGE_FAIL failure(s)); no later job-owning stage will start =="
  if [ "$LOST_AUTHORITY" -eq 1 ]; then
    echo "  lost authority: normal known-id cleanup is skipped; teardown reclaims every job"
  else
    release_known_ids
  fi
  echo "== teardown + zero residue (contained) =="
  cleanup
  residue_audit || echo "  (residue detected — inspect \`docker ... | grep $PROJECT\`)"
  echo "== $PASS passed, $FAIL failed =="
  exit 1
}

# ---------------------------------------------------------------------------
# Product helpers
# ---------------------------------------------------------------------------

wait_healthy() {
  local svc="$1" cid st=none
  cid="$($COMPOSE ps -q "$svc" 2>/dev/null)"
  [ -n "$cid" ] || { echo none; return; }
  for _ in $(seq 1 30); do
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)"
    [ "$st" = healthy ] && break
    sleep 2
  done
  echo "$st"
}

# Submit one YAML via the published BFF. Echoes the minted job id on success
# (HTTP 202 + a JSON body containing a non-empty `id`). Returns empty on any
# failure: a non-202 status, a body that is not valid JSON, or a missing id.
# All three conditions fail the gate rather than silently accepting a partial
# response (e.g. an HTML error page that happens to contain `"id"`).
submit_job() {
  local yaml="$1" timeout="$2" hdr body status id
  hdr="$WORKDIR/submit_$$.hdr"; body="$WORKDIR/submit_$$.json"
  curl -sS --max-time "$POLL_MAX" -D "$hdr" -o "$body" \
    -X POST "$BASE/api/optimize" \
    -F "yaml_content=<$yaml" -F "prettify=false" -F "timeout=$timeout" 2>/dev/null || true
  status="$(sed -n 's/^HTTP\/[^ ]* \([0-9][0-9][0-9]\).*/\1/p' "$hdr" | tail -n1)"
  if [ "$status" != "202" ]; then
    rm -f "$hdr" "$body"
    return 1
  fi
  id="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or "")' \
    < "$body" 2>/dev/null || true)"
  rm -f "$hdr" "$body"
  [ -n "$id" ] || return 1
  printf '%s' "$id"
}

# Echo the job's current state (empty on failure).
job_state() {
  curl -sS --max-time "$POLL_MAX" "$BASE/api/optimize/$1" 2>/dev/null \
    | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' | head -n1
}

# Poll until the job reaches one of the given states (space-separated) or timeout.
poll_until() {
  local id="$1" wants="$2" deadline="$3" st
  for _ in $(seq 1 "$deadline"); do
    st="$(job_state "$id")"
    for w in $wants; do [ "$st" = "$w" ] && { echo "$st"; return; }; done
    sleep 1
  done
  echo "$st"
}

# Read the browser's ids-only abort handoff as a TOTAL function over the file.
#
# Prints `ok <slots> <distinct>` followed by one distinct id per line, or a single
# `lost <reason>` line. Missing, unreadable, malformed, non-array, empty, or
# non-string/empty/unsafe id evidence is lost authority — never a guessed id.
read_abort_handoff() {
  python3 - "$1" <<'PY'
import json
import re
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
except FileNotFoundError:
    print("lost the handoff file was missing")
    raise SystemExit(0)
except (OSError, ValueError, UnicodeDecodeError):
    print("lost the handoff file was unreadable or not valid JSON")
    raise SystemExit(0)

if not isinstance(payload, list):
    print("lost the handoff payload was not a JSON array")
    raise SystemExit(0)
if not payload:
    print("lost the handoff array carried no accepted slot")
    raise SystemExit(0)

unsafe = re.compile(r"[\s\x00-\x1f\x7f]")
for slot in payload:
    if not isinstance(slot, str) or not slot or unsafe.search(slot):
        print("lost the handoff array carried a non-string, empty or unsafe id")
        raise SystemExit(0)

distinct = list(dict.fromkeys(payload))
print("ok %d %d" % (len(payload), len(distinct)))
for value in distinct:
    print(value)
PY
}

# ---------------------------------------------------------------------------
# Stage: setup — build, publish, health, and the base-topology keepalive default
# ---------------------------------------------------------------------------

stage "build + up direct overlay (project=$PROJECT, APP_VERSION=$APP_VERSION)"
$COMPOSE build web backend >/dev/null || bad "build"
boundary

# Bounded retry: discover a kernel-free port + immediately bind via Compose.
# If the port was claimed in the TOCTOU window, retry with a new port.
UP_OK=0
for ATTEMPT in $(seq 1 "$MAX_PORT_ATTEMPTS"); do
  WEB_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')"
  [ -z "$WEB_PORT" ] && { echo "  attempt $ATTEMPT: port discovery failed"; continue; }
  BASE="http://localhost:${WEB_PORT}"
  PUBLIC_ORIGIN="$BASE"
  # NS_ENABLE_DEV_FIXTURES=1 exposes `/optimize-durable-fixture` for the browser phase.
  # JOB_SSE_KEEPALIVE_SECONDS=2 comes from the gate overlay (compose.verify-stream.yml),
  # NOT from the base topology — normal Compose starts with the backend's default.
  if PUBLIC_ORIGIN="$PUBLIC_ORIGIN" WEB_PORT="$WEB_PORT" WEB_BIND_ADDRESS="$WEB_BIND_ADDRESS" \
    NS_ENABLE_DEV_FIXTURES=1 \
    $COMPOSE up -d >/dev/null 2>&1; then
    UP_OK=1
    echo "  direct overlay up on port $WEB_PORT (attempt $ATTEMPT)"
    break
  fi
  echo "  port $WEB_PORT bind failed (attempt $ATTEMPT/$MAX_PORT_ATTEMPTS), retrying..."
  $COMPOSE down -v -t 3 >/dev/null 2>&1 || true
done
[ "$UP_OK" = 1 ] || bad "could not start after $MAX_PORT_ATTEMPTS port attempts"
boundary

st="$(wait_healthy web)"
[ "$st" = healthy ] && ok "web healthy on published $BASE" || bad "web never became healthy (status=$st)"

# No-override proof: render the base topology without suppressing config errors,
# verify it omits JOB_SSE_KEEPALIVE_SECONDS, then construct ServerSettings in a
# one-off container from that exact base service. This proves both Compose
# interpolation and backend startup/config parsing retain the validated 10s
# default; an empty injected value would make the command fail at float("").
if BASE_CFG="$($BASE_COMPOSE config 2>&1)"; then
  ok "base Compose (no gate overlay) renders successfully"
else
  BASE_CFG=""
  bad "base Compose (no gate overlay) failed to render"
fi
if [ -n "$BASE_CFG" ] && ! echo "$BASE_CFG" | grep -q 'JOB_SSE_KEEPALIVE_SECONDS'; then
  ok "base Compose omits JOB_SSE_KEEPALIVE_SECONDS"
else
  bad "base Compose injects JOB_SSE_KEEPALIVE_SECONDS or did not render"
fi
DEFAULT_KEEPALIVE="$($BASE_COMPOSE run --rm --no-deps backend \
  python -c 'from nurse_scheduling.server.config import ServerSettings; print(ServerSettings.from_env().sse_keepalive_seconds)' \
  2>/dev/null || true)"
if [ "$DEFAULT_KEEPALIVE" = "10.0" ]; then
  ok "base backend settings start without override and retain 10.0s keepalive"
else
  bad "base backend settings did not retain 10.0s keepalive (got '$DEFAULT_KEEPALIVE')"
fi

# The published port must actually answer (assembled Browser→Next path is live).
health_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$POLL_MAX" "$BASE/api/health" 2>/dev/null || echo 000)"
[ "$health_code" = 200 ] && ok "GET /api/health via published port → 200" \
  || bad "GET /api/health via published port → $health_code"

# Setup/health failure stops here, BEFORE the first submission.
boundary

# ---------------------------------------------------------------------------
# Stage: curl live — streaming, disconnect, nonterminal cancel, replay, cleanup
# ---------------------------------------------------------------------------

stage "curl live job: streaming, disconnect, nonterminal cancel, replay, cleanup (timeout=${LIVE_TIMEOUT}s)"
LIVE_ID="$(submit_job "$LARGE_YAML" "$LIVE_TIMEOUT")"
if [ -z "$LIVE_ID" ]; then
  bad "POST /api/optimize did not return a job id (live)"
else
  register_id "$LIVE_ID"
  ok "POST /api/optimize accepted live job id=$LIVE_ID"

  echo "  -- observable first response + live streaming"
  hdr="$WORKDIR/live.hdr"; body="$WORKDIR/live.sse"
  curl -sS --no-buffer --max-time "$STREAM_WINDOW" -D "$hdr" -o "$body" \
    -H "Accept: text/event-stream" "$BASE/api/optimize/$LIVE_ID/events" >/dev/null 2>&1 || true

  ctype="$(sed -n 's/^[Cc]ontent-[Tt]ype: *//p' "$hdr" | tr -d '\r' | head -n1)"
  case "$ctype" in
    text/event-stream*) ok "events content-type is text/event-stream ($ctype)" ;;
    *) bad "events content-type was '$ctype' (expected text/event-stream)" ;;
  esac
  # Passthrough streaming headers (no-cache + disabled proxy buffering).
  grep -qi '^x-accel-buffering: *no' "$hdr" && ok "x-accel-buffering: no preserved" \
    || bad "x-accel-buffering: no header missing"
  grep -qi '^cache-control: *no-cache' "$hdr" && ok "cache-control: no-cache preserved" \
    || bad "cache-control: no-cache header missing"

  # Real SSE frames: at least one `id:` cursor AND at least one `job.*` event.
  mapfile -t CURSORS < <(sed -n 's/^id: *//p' "$body" | tr -d '\r')
  n_cursors="${#CURSORS[@]}"
  # `grep -c` already prints 0 and exits 1 on no match; `|| true` keeps the count
  # clean (a `|| echo 0` would double it to "0\n0" and break the integer test).
  n_jobevents="$(grep -c '^event: job\.' "$body" 2>/dev/null || true)"; n_jobevents="${n_jobevents:-0}"
  [ "$n_cursors" -ge 1 ] && ok "captured $n_cursors SSE id: cursor(s)" \
    || bad "no SSE id: cursors observed"
  [ "$n_jobevents" -ge 1 ] && ok "observed $n_jobevents job.* event frame(s)" \
    || bad "no job.* event frames observed"

  # Genuine keepalive: the backend emits a `: keepalive` comment when no new
  # event arrives within the configured keepalive interval. The gate sets
  # JOB_SSE_KEEPALIVE_SECONDS=2 so at least one arrives in the bounded window.
  # Repeated job frames do NOT substitute — the ticket requires a real comment
  # keepalive independently from event traffic.
  n_keepalive="$(grep -c '^: keepalive' "$body" 2>/dev/null || true)"; n_keepalive="${n_keepalive:-0}"
  if [ "$n_keepalive" -ge 1 ]; then
    ok "genuine SSE keepalive comment observed ($n_keepalive frame(s))"
  else
    bad "no genuine ': keepalive' comment over ${STREAM_WINDOW}s window ($n_jobevents job frames, $n_cursors cursors, 0 keepalives)"
  fi

  echo "  -- downstream disconnect leaves backend responsive"
  # The stream curl above already disconnected at its --max-time deadline. Assert
  # the backend did not wedge on the abandoned SSE body: a fresh bounded poll
  # returns a valid live state promptly (no orphaned stream holding the worker).
  pre_cancel_state="$(job_state "$LIVE_ID")"
  case "$pre_cancel_state" in
    queued|running|cancelling|completed|cancelled|failed)
      ok "job still pollable after SSE client disconnect (state=$pre_cancel_state)" ;;
    *) bad "job not pollable after SSE disconnect (state='$pre_cancel_state')" ;;
  esac

  echo "  -- cancel a LIVE job to terminal"
  # The cold-review hardening: confirm a NONTERMINAL state immediately before
  # sending the cancel. A job that already self-terminated (completed/failed/
  # cancelled) means the cancel was never exercised — that is a FAIL, not a
  # degraded pass. The 87-person CP-SAT solve with a 120s timeout stays live
  # well past the short streaming window above, so this assertion is reachable
  # on any host that can run the solver.
  case "$pre_cancel_state" in
    queued|running|cancelling)
      ok "job confirmed nonterminal immediately before cancel (state=$pre_cancel_state)" ;;
    *)
      bad "job was already terminal before cancel (state=$pre_cancel_state) — live cancel NOT exercised" ;;
  esac

  if [ "$pre_cancel_state" = queued ] || [ "$pre_cancel_state" = running ] || [ "$pre_cancel_state" = cancelling ]; then
    cancel_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$POLL_MAX" \
      -X POST "$BASE/api/optimize/$LIVE_ID/cancel" 2>/dev/null || echo 000)"
    case "$cancel_code" in
      202) ok "POST /api/optimize/$LIVE_ID/cancel accepted on a live job (202)" ;;
      *) bad "cancel of a live job returned $cancel_code (expected exactly 202)" ;;
    esac
    final="$(poll_until "$LIVE_ID" "cancelled completed failed" 30)"
    case "$final" in
      cancelled) ok "cancelled live job reached terminal state cancelled" ;;
      completed|failed) ok "live job reached terminal state $final before cancel settled (worker freed)" ;;
      *) bad "cancelled live job did not reach a terminal state (last=$final)" ;;
    esac
  fi

  echo "  -- opaque replay cursor (Last-Event-ID)"
  # Events are retained after the job settles, so the replay-after-cursor invariant
  # is asserted against the retained history: reconnect after the LATEST cursor we
  # already saw and require (1) AT LEAST ONE strictly-after frame and (2) NONE of
  # the already-seen cursors re-sent. An empty replay would satisfy the old
  # "no old cursor re-sent" check — this stricter assertion fails on an empty
  # replay, closing the false-green seam.
  if [ "$n_cursors" -ge 1 ]; then
    resume="${CURSORS[$((n_cursors - 1))]}"
    rbody="$WORKDIR/replay.sse"
    curl -sS --no-buffer --max-time "$RECONNECT_WINDOW" -o "$rbody" \
      -H "Accept: text/event-stream" -H "Last-Event-ID: $resume" \
      "$BASE/api/optimize/$LIVE_ID/events" >/dev/null 2>&1 || true
    mapfile -t RCURS < <(sed -n 's/^id: *//p' "$rbody" | tr -d '\r')
    replayed_seen=0
    for rc in "${RCURS[@]}"; do
      for old in "${CURSORS[@]}"; do
        [ "$rc" = "$old" ] && { replayed_seen=1; break; }
      done
      [ "$replayed_seen" -eq 1 ] && break
    done
    if [ "${#RCURS[@]}" -ge 1 ] && [ "$replayed_seen" -eq 0 ]; then
      ok "replay after cursor delivered ${#RCURS[@]} strictly-after frame(s), none of the ${n_cursors} already-seen re-sent"
    elif [ "${#RCURS[@]}" -lt 1 ]; then
      bad "replay returned ZERO strictly-after frames (expected ≥1 post-cursor event)"
    else
      bad "replay after Last-Event-ID re-sent an already-seen cursor (replay not strictly-after)"
    fi
  else
    bad "cannot exercise replay: no cursor was captured from the live stream"
  fi

  echo "  -- known-id cleanup to final GET 404"
  if cleanup_job_lifecycle "$LIVE_ID"; then
    ok "curl live job cleaned up to exact final GET 404"
    unregister_id "$LIVE_ID"
  else
    bad "curl live job cleanup did not reach exact final GET 404"
  fi
fi
boundary

# ---------------------------------------------------------------------------
# Stage: curl tiny — completion, XLSX, content-disposition, DELETE, final 404
# ---------------------------------------------------------------------------

stage "curl tiny feasible job: terminal artifact + download + DELETE + final 404"
TINY_ID="$(submit_job "$TINY_YAML" 30)"
if [ -z "$TINY_ID" ]; then
  bad "POST /api/optimize did not return a job id (tiny)"
else
  register_id "$TINY_ID"
  ok "POST /api/optimize accepted tiny job id=$TINY_ID"

  tstate="$(poll_until "$TINY_ID" "completed failed cancelled" 40)"
  [ "$tstate" = completed ] && ok "tiny feasible job reached completed" \
    || bad "tiny job did not complete (last=$tstate)"

  if [ "$tstate" = completed ]; then
    xhdr="$WORKDIR/xlsx.hdr"; xbin="$WORKDIR/schedule.xlsx"
    curl -sS --max-time "$POLL_MAX" -D "$xhdr" -o "$xbin" \
      "$BASE/api/optimize/$TINY_ID/xlsx" >/dev/null 2>&1 || true
    # XLSX is a zip: first four bytes must be the PK\x03\x04 local-file-header magic.
    magic="$(head -c 4 "$xbin" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    if [ "$magic" = "504b0304" ] && [ -s "$xbin" ]; then
      ok "GET .../xlsx returned a non-empty XLSX (PK zip magic, $(wc -c < "$xbin") bytes)"
    else
      bad "xlsx artifact missing PK zip magic (got magic='$magic')"
    fi
    grep -qi '^content-disposition: *attachment' "$xhdr" \
      && ok "xlsx response preserved Content-Disposition" \
      || bad "xlsx response missing Content-Disposition"
  fi

  del_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$POLL_MAX" \
    -X DELETE "$BASE/api/optimize/$TINY_ID" 2>/dev/null || echo 000)"
  [ "$del_code" = 204 ] && ok "DELETE /api/optimize/$TINY_ID → 204" \
    || bad "DELETE returned $del_code (expected 204)"

  after_hdr="$WORKDIR/after.hdr"; after_body="$WORKDIR/after.json"
  after_code="$(curl -sS -o "$after_body" -D "$after_hdr" -w '%{http_code}' \
    --max-time "$POLL_MAX" "$BASE/api/optimize/$TINY_ID" 2>/dev/null || echo 000)"
  if [ "$after_code" = 404 ] && grep -q 'job_not_found' "$after_body"; then
    ok "GET after DELETE → 404 job_not_found"
    # The product's own DELETE + 404 IS this stage's final-404 cleanup.
    echo "    cleanup success $TINY_ID: final GET 404"
    unregister_id "$TINY_ID"
  else
    bad "GET after DELETE → $after_code (body: $(tr -d '\n' < "$after_body" | head -c 120))"
  fi
fi
boundary

# ---------------------------------------------------------------------------
# Stage: browser tiny + replay — the assembled Browser → Next → FastAPI gate
# ---------------------------------------------------------------------------
# The curl stages above are SUPPORTING protocol diagnostics. The ticket's required
# release gate drives a REAL browser (Playwright/Chromium) against the published
# direct port with ZERO `/api/**` route interception, so the genuine Optimize
# controller talks through the real BFF to the real FastAPI backend. The spec
# observes the actual SSE response/first byte, a genuine `: keepalive` comment,
# opaque cursor persistence with strictly-after replay on reload, and the real
# download/auto-delete/slot-release chain. Each browser test owns its own accepted
# ids and proves final GET 404 in its own hook.
#
# The browser phase is REQUIRED — if pnpm/Playwright are unavailable, or any
# browser test fails, the ENTIRE gate fails. There is no degraded "skip" path.

stage "assembled browser gate: tiny + replay (real Browser → Next → FastAPI, no interception)"
if ! command -v pnpm >/dev/null 2>&1; then
  bad "pnpm not found — browser phase is REQUIRED (not optional). Gate fails."
else
  if (cd "$ROOT/web" && \
      ASSEMBLED_BASE_URL="$BASE" \
      CI=1 \
      pnpm exec playwright test --config playwright.assembled.config.ts \
        --reporter=line --grep "tiny feasible|live job" 2>&1); then
    ok "assembled browser gate: SSE first byte + genuine keepalive + cursor replay"
  else
    bad "assembled browser gate FAILED — gate cannot pass without browser evidence"
  fi
fi
boundary

# ---------------------------------------------------------------------------
# Stage: browser abort — direct navigation, baselined BFF audit, handoff cleanup
# ---------------------------------------------------------------------------
# The abort test is the ONLY navigate-away in the suite and proves its own outcome
# directly. This stage's causal order is fixed and load-bearing:
#
#   baseline BFF log -> run abort -> audit ONLY new BFF entries -> read handoff
#   authority -> post-audit lifecycle cleanup
#
# The audit runs BEFORE any abort cancel or cleanup, so cleanup cannot manufacture
# the log line it is audited against. A valid one/two-slot handoff is still cleaned
# up even when Playwright failed or the audit failed — containment must not leak a
# live job. Lost authority takes teardown instead, never a guessed id.

stage "assembled browser abort: direct /about navigation + baselined BFF audit + ids-only handoff"
rm -f "$ABORT_HANDOFF"
# Baseline IMMEDIATELY before the isolated abort run: curl disconnects and the
# tiny/replay teardown cancels are all before this line and cannot satisfy the audit.
#
# The baseline's exit status is checked, not just its output. A failed `compose logs`
# would otherwise leave a small line count (or a count of its own error text), and the
# later read would then tail from a bogus offset and re-include a PRE-baseline
# cancellation line — false-greening the audit off evidence it must not see. A baseline
# that cannot be taken stops the stage before any job is submitted.
BFF_BASELINE_LOG="$WORKDIR/bff-baseline.log"
if ! $COMPOSE logs web >"$BFF_BASELINE_LOG" 2>&1; then
  bad "could not baseline the BFF log before the abort run — audit-only-new cannot be honoured"
  boundary
fi
BFF_LOG_BASELINE="$(wc -l < "$BFF_BASELINE_LOG" | tr -d ' ')"

if (cd "$ROOT/web" && \
    ASSEMBLED_BASE_URL="$BASE" \
    ASSEMBLED_ABORT_HANDOFF="$ABORT_HANDOFF" \
    CI=1 \
    pnpm exec playwright test --config playwright.assembled.config.ts \
      --reporter=line --grep "abort propagation" 2>&1); then
  ok "abort test proved a committed same-origin /about navigation with the fixture gone"
else
  bad "abort test FAILED — the real navigation/abort outcome was not proved"
fi

# Audit BEFORE any abort cleanup. Only NEW entries after the baseline count.
echo "  -- BFF abort-propagation audit (new entries only, before any abort cleanup)"
sleep 2
BFF_AFTER_LOG="$WORKDIR/bff-after.log"
if ! $COMPOSE logs web >"$BFF_AFTER_LOG" 2>&1; then
  # A failed read is a failed audit, never a pass. Cleanup below still runs, because a
  # valid handoff must be released even when the audit itself failed.
  bad "could not read the BFF log after the abort run — abort audit failed"
else
  BFF_NEW_LOGS="$(tail -n +$((BFF_LOG_BASELINE + 1)) "$BFF_AFTER_LOG")"
  if echo "$BFF_NEW_LOGS" | grep -q 'downstream cancelled; propagating to upstream body'; then
    ok "BFF observed browser downstream cancel → upstream-body abort (NEW log after baseline)"
  else
    bad "BFF abort not correlated to the isolated abort navigation (new 'downstream cancelled' matches: $(
      echo "$BFF_NEW_LOGS" | grep -c 'downstream cancelled' || true))"
  fi
fi

echo "  -- accepted-slot handoff authority"
mapfile -t HANDOFF_LINES < <(read_abort_handoff "$ABORT_HANDOFF")
HANDOFF_HEAD="${HANDOFF_LINES[0]:-lost the handoff reader produced no output}"
case "$HANDOFF_HEAD" in
  "ok "*)
    ABORT_SLOTS="$(echo "$HANDOFF_HEAD" | awk '{print $2}')"
    ABORT_IDS=()
    for ((line_index = 1; line_index < ${#HANDOFF_LINES[@]}; line_index += 1)); do
      ABORT_IDS+=("${HANDOFF_LINES[$line_index]}")
    done
    # Register before judging: even a lost-authority teardown releases what it knows.
    for abort_id in "${ABORT_IDS[@]}"; do register_id "$abort_id"; done

    if [ "$ABORT_SLOTS" -gt 2 ]; then
      # Handed off only so cardinality is detectable; this takes teardown, not cleanup.
      bad "abort handoff carried $ABORT_SLOTS accepted slots (>2) — lost authority, no normal cleanup"
      LOST_AUTHORITY=1
      boundary
    fi

    if [ "$ABORT_SLOTS" -eq 1 ]; then
      ok "abort handoff carried exactly one accepted slot id"
    else
      # Red on cardinality alone, independently of whether the physical ids clean up.
      bad "abort handoff carried $ABORT_SLOTS accepted slots (expected exactly 1)"
    fi

    # Post-audit lifecycle cleanup of every DISTINCT id, at max concurrency two.
    # Slots are capped at 2 above and distinct ids cannot exceed slots, so launching
    # them together is exactly a concurrency-2 fan-out.
    ABORT_CLEANUP_FAIL=0
    cleanup_pids=(); cleanup_logs=(); cleanup_index=0
    for abort_id in "${ABORT_IDS[@]}"; do
      cleanup_index=$((cleanup_index + 1))
      cleanup_logs+=("$WORKDIR/abort-cleanup-$cleanup_index.log")
      cleanup_job_lifecycle "$abort_id" >"$WORKDIR/abort-cleanup-$cleanup_index.log" 2>&1 &
      cleanup_pids+=($!)
    done
    for cleanup_pid in "${cleanup_pids[@]}"; do
      wait "$cleanup_pid" || ABORT_CLEANUP_FAIL=1
    done
    for cleanup_log in "${cleanup_logs[@]}"; do cat "$cleanup_log"; done
    if [ "$ABORT_CLEANUP_FAIL" -eq 0 ]; then
      ok "abort job cleanup reached exact final GET 404 for ${#ABORT_IDS[@]} distinct id(s)"
      for abort_id in "${ABORT_IDS[@]}"; do unregister_id "$abort_id"; done
    else
      bad "abort job cleanup did not reach exact final GET 404 for every distinct id"
    fi
    ;;
  *)
    bad "abort authority lost: ${HANDOFF_HEAD#lost } (no guessed id, no later job-owning stage)"
    LOST_AUTHORITY=1
    boundary
    ;;
esac
boundary

# ---------------------------------------------------------------------------
# Successful teardown + the same five residue checks
# ---------------------------------------------------------------------------

stage "teardown + zero residue"
cleanup
# cleanup() removed the WORKDIR too; nothing below needs it. Re-assert an empty
# footprint for this run's PID-scoped project across every Docker namespace.
residue_audit || echo "  (residue detected — inspect \`docker ... | grep $PROJECT\`)"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
