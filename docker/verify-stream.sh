#!/usr/bin/env bash
# Release-blocking ASSEMBLED streaming gate (T16). Unlike `verify-deploy.sh` (which
# probes the PRIVATE base over the internal network and never streams), this gate
# brings up the DIRECT overlay — base `compose.yml` + `compose.direct.yml` — so the
# Next BFF is published on a real host port, and drives the durable Optimize &
# Export SSE run protocol end to end through the assembled Browser→Next→FastAPI
# path. It has two phases:
#
#   1. BROWSER (primary): Playwright/Chromium drives the real Optimize screen
#      against the published port with ZERO `/api/**` route interception. The
#      spec observes the actual SSE response/first byte, a genuine `: keepalive`
#      comment, opaque cursor persistence with strictly-after replay on reload,
#      and browser-disconnect → BFF upstream-body abort.
#
#   2. CURL (supporting diagnostics): protocol-level checks that submit returns
#      HTTP 202 + JSON, the stream delivers `text/event-stream` with `id:`
#      cursors + `job.*` events + a genuine `: keepalive` comment, a confirmed
#      nonterminal job is cancelled with exactly HTTP 202, `Last-Event-ID` replay
#      delivers ≥1 strictly-after frame, the tiny job reaches `completed` with a
#      valid XLSX (PK zip magic), DELETE → 204, subsequent GET → 404.
#
# Everything is bounded (`curl --max-time`, Playwright timeouts) so the gate
# cannot hang. A PID-scoped project name AND a collision-safe host port (bounded
# retry on Compose bind failure) keep it isolated. The BFF abort audit is
# baselined around the browser phase so curl/prior logs cannot satisfy it.
# Browser-phase failure or pnpm unavailability fails the entire gate. Exits
# non-zero on any failed assertion.
#
# The production Cloudflare NAMED-TUNNEL streaming validation stays optional/manual
# (it needs external Cloudflare state); its absence does NOT weaken this direct gate.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_VERSION="${APP_VERSION:-$(tr -d '[:space:]' < VERSION 2>/dev/null)}"
if [ -z "$APP_VERSION" ]; then
  echo "FAIL: APP_VERSION/VERSION is empty" >&2
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

WORKDIR="$(mktemp -d)"

PASS=0
FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

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

echo "== build + up direct overlay (project=$PROJECT, APP_VERSION=$APP_VERSION) =="
$COMPOSE build web backend >/dev/null || { echo "FAIL: build"; exit 1; }

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
[ "$UP_OK" = 1 ] || { echo "FAIL: could not start after $MAX_PORT_ATTEMPTS port attempts"; exit 1; }

st="$(wait_healthy web)"
[ "$st" = healthy ] && ok "web healthy on published $BASE" || { bad "web never became healthy (status=$st)"; }

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

echo "== submit LARGE live job (timeout=${LIVE_TIMEOUT}s) =="
LIVE_ID="$(submit_job "$LARGE_YAML" "$LIVE_TIMEOUT")"
[ -n "$LIVE_ID" ] && ok "POST /api/optimize accepted live job id=$LIVE_ID" \
  || bad "POST /api/optimize did not return a job id (live)"

if [ -n "$LIVE_ID" ]; then
  echo "== observable first response + live streaming =="
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

  echo "== downstream disconnect leaves backend responsive =="
  # The stream curl above already disconnected at its --max-time deadline. Assert
  # the backend did not wedge on the abandoned SSE body: a fresh bounded poll
  # returns a valid live state promptly (no orphaned stream holding the worker).
  pre_cancel_state="$(job_state "$LIVE_ID")"
  case "$pre_cancel_state" in
    queued|running|cancelling|completed|cancelled|failed)
      ok "job still pollable after SSE client disconnect (state=$pre_cancel_state)" ;;
    *) bad "job not pollable after SSE disconnect (state='$pre_cancel_state')" ;;
  esac

  echo "== cancel a LIVE job to terminal =="
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
      bad "job was already terminal before cancel (state=$pre_cancel_state) — live cancel NOT exercised"
      final="$pre_cancel_state"
      ;;
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

  echo "== opaque replay cursor (Last-Event-ID) =="
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
fi

echo "== submit TINY feasible job → terminal artifact + download + DELETE =="
TINY_ID="$(submit_job "$TINY_YAML" 30)"
[ -n "$TINY_ID" ] && ok "POST /api/optimize accepted tiny job id=$TINY_ID" \
  || bad "POST /api/optimize did not return a job id (tiny)"

if [ -n "$TINY_ID" ]; then
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
  else
    bad "GET after DELETE → $after_code (body: $(tr -d '\n' < "$after_body" | head -c 120))"
  fi
fi

# ---------------------------------------------------------------------------
# Browser phase: the assembled Browser → Next → FastAPI release gate.
# ---------------------------------------------------------------------------
# The curl phase above is SUPPORTING protocol diagnostics. The ticket's required
# release gate drives a REAL browser (Playwright/Chromium) against the published
# direct port with ZERO `/api/**` route interception, so the genuine Optimize
# controller talks through the real BFF to the real FastAPI backend. The spec
# observes the actual SSE response/first byte, a genuine `: keepalive` comment,
# opaque cursor persistence with strictly-after replay on reload, and
# browser-disconnect → BFF upstream-body abort propagation.
#
# The browser phase is REQUIRED — if pnpm/Playwright are unavailable, or any
# browser test fails, the ENTIRE gate fails. There is no degraded "skip" path.
echo "== assembled browser gate (real Browser → Next → FastAPI, no interception) =="
BROWSER_OK=0
ABORT_OK=0
BFF_LOG_BASELINE=0
if ! command -v pnpm >/dev/null 2>&1; then
  bad "pnpm not found — browser phase is REQUIRED (not optional). Gate fails."
else
  # Phase 1: replay tests (tiny + live replay). These do NOT navigate away.
  if (cd "$ROOT/web" && \
      ASSEMBLED_BASE_URL="$BASE" \
      CI=1 \
      pnpm exec playwright test --config playwright.assembled.config.ts \
        --reporter=line --grep "tiny feasible|live job" 2>&1); then
    BROWSER_OK=1
  fi

  # Adversarial control: suppress the explicit navigation while retaining the
  # URL assertion. This MUST fail even though Playwright context teardown may
  # still close the SSE request and emit an abort log. A passing control would
  # prove the browser assertion can false-green without the intended action.
  if (cd "$ROOT/web" && \
      ASSEMBLED_BASE_URL="$BASE" \
      ASSEMBLED_SKIP_ABORT_NAVIGATION=1 \
      CI=1 \
      pnpm exec playwright test --config playwright.assembled.config.ts \
        --reporter=line --trace=off --grep "abort propagation" 2>&1); then
    bad "abort negative control unexpectedly passed without navigation"
  else
    ok "abort negative control fails when the final navigation is removed"
  fi

  # Baseline the BFF log count IMMEDIATELY after the negative control and before
  # the real isolated abort test. Replay, curl, and negative-control teardown
  # cancels are all before this boundary and cannot satisfy the audit below.
  BFF_LOG_BASELINE="$($COMPOSE logs web 2>&1 | wc -l)"

  # Phase 2: isolated abort test. The ONLY navigate-away in the suite.
  if (cd "$ROOT/web" && \
      ASSEMBLED_BASE_URL="$BASE" \
      CI=1 \
      pnpm exec playwright test --config playwright.assembled.config.ts \
        --reporter=line --grep "abort propagation" 2>&1); then
    ABORT_OK=1
  fi
fi

if [ "$BROWSER_OK" = 1 ]; then
  ok "assembled browser gate: SSE first byte + genuine keepalive + cursor replay"
else
  bad "assembled browser gate FAILED — gate cannot pass without browser evidence"
fi

# Abort-propagation audit: BASELINED immediately before the isolated abort test.
# Only NEW log entries (after the baseline) count — reload, prior tests, and
# curl disconnects all produced cancel logs BEFORE the baseline.
echo "== BFF abort-propagation audit (baselined immediately before abort test) =="
sleep 2
BFF_NEW_LOGS="$($COMPOSE logs web 2>&1 | tail -n +$((BFF_LOG_BASELINE + 1)))"
if [ "$ABORT_OK" = 1 ] && echo "$BFF_NEW_LOGS" | grep -q 'downstream cancelled; propagating to upstream body'; then
  ok "BFF observed browser downstream cancel → upstream-body abort (NEW log, correlated to abort test)"
else
  bad "BFF abort not correlated to the isolated abort navigation (abort_ok=$ABORT_OK, new_log_match=$(
    echo "$BFF_NEW_LOGS" | grep -c 'downstream cancelled' || true))"
fi

echo "== teardown + zero residue =="
cleanup
# cleanup() removed the WORKDIR too; nothing below needs it. Re-assert an empty
# footprint for this run's PID-scoped project across every Docker namespace.
residue=0
for kind in \
  "containers:$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -c "^${PROJECT}[-_]" || true)" \
  "images:$(docker image ls --format '{{.Repository}}' 2>/dev/null | grep -c "^${PROJECT}-" || true)" \
  "networks:$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -c "^${PROJECT}_" || true)" \
  "volumes:$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -c "^${PROJECT}_" || true)"; do
  name="${kind%%:*}"; count="${kind##*:}"
  if [ "${count:-0}" -eq 0 ]; then
    ok "no leftover $name for $PROJECT"
  else
    bad "$count leftover $name for $PROJECT"
    residue=1
  fi
done

# Browser download artifact residue: Playwright manages temp downloads, but
# assert no ns-test-download files leaked from a prior or current run.
leftover_downloads="$(find /tmp -maxdepth 1 -name 'ns-test-download-*.xlsx' 2>/dev/null | wc -l | tr -d ' ')"
if [ "$leftover_downloads" = "0" ]; then
  ok "no leftover browser download artifacts"
else
  bad "$leftover_downloads leftover browser download artifact(s) in /tmp"
  residue=1
fi

[ "$residue" -eq 0 ] || echo "  (residue detected — inspect \`docker ... | grep $PROJECT\`)"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
