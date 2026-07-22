#!/usr/bin/env bash
# Reproducible non-streaming deploy gates (tech-plan §3/§6/§7, T02r acceptance).
# Brings the PRIVATE BASE stack up (web + backend + redis, NO ingress overlay) and
# asserts:
#   - base publishes NO host ports (web, backend, redis all internal)
#   - redis answers PING and runs non-root; backend `/ready` is ready; web `/api/health` works
#   - NEXT_PUBLIC_APP_VERSION (client bundle) == /api/health.appVersion == APP_VERSION
#   - web and backend run as uid 1000; backend CMD keeps `--workers 1`
#   - segmented networks: web↔backend reachable; web✗redis, an ingress-only peer✗backend/redis
#   - a queued job survives a backend restart AND a Redis CONTAINER REPLACEMENT (named volume)
#   - Last-Event-ID replay returns only events after the cursor
#   - a SIGKILLed claim-holding worker becomes retained `worker_lost` (test-only lease)
#   - a Redis outage makes backend /ready, /health and the BFF /api/health fail closed (bounded)
#   - a deliberately mismatched web stamp makes the equality assertion FAIL as expected
#   - the PUBLIC_ORIGIN validator's fixture matrix is correct
# Exits non-zero on any failed assertion. The production named-tunnel streaming
# smoke stays manual (T16) — it needs external Cloudflare state.
#
# All reachability checks run via `docker compose exec` / the internal network, so
# the gate publishes no host port and cannot clash with other stacks. A unique,
# PID-scoped project name isolates it from any concurrently running deploy, and
# cleanup removes that project's built images so runs do not accumulate.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_VERSION="${APP_VERSION:-$(git describe --tags --always --dirty 2>/dev/null)}"
if [ -z "$APP_VERSION" ]; then
  echo "FAIL: APP_VERSION is empty (git describe failed)" >&2
  exit 1
fi

PROJECT="nsvd-$$"
COMPOSE="docker compose -p $PROJECT -f docker/compose.yml"
DRIVER="docker/deploy_gate_driver.py"
# Each gate gets its own key namespace under this base so one gate's queued job is
# never claimed by another's `claim_next_job`. `cleanup` scans the shared base.
GATE_PREFIX_BASE="nurse_test:vd:$$"
MIS_VER="9.9.9-mismatch"
MIS_IMAGE="nsvd-web-mismatch-$$:test"
MIS_NAME="nsvd-web-mismatch-$$"
# After segmentation there is no default network. The mismatch probe needs only to
# reach backend, so it joins ONLY the application network.
APP_NETWORK="${PROJECT}_app"
REDIS_VOLUME="${PROJECT}_redis-data"
# Compose names built images `<project>-<service>`; remove them on exit (F4).
PROJECT_IMAGES="${PROJECT}-backend ${PROJECT}-web"
PROBE_TIMEOUT_SECONDS="${PROBE_TIMEOUT_SECONDS:-8}"
PROBE_KILL_GRACE_SECONDS=2
# Throwaway origin for the gated stack only; real deploys set PUBLIC_ORIGIN via
# docker/.env. Blank here would trip the web runtime's fail-closed check, so it is
# bound inline to the `up` command that actually starts web (see below).
PUBLIC_ORIGIN="http://localhost:3000"
export APP_VERSION

PASS=0
FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup_probes() {
  local ids
  ids="$(docker ps -aq --filter "name=${PROJECT}-probe-" 2>/dev/null)"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
}

cleanup() {
  cleanup_probes
  driver "$GATE_PREFIX_BASE" cleanup >/dev/null 2>&1 || true
  docker rm -f "$MIS_NAME" >/dev/null 2>&1 || true
  docker image rm -f "$MIS_IMAGE" >/dev/null 2>&1 || true
  # -v removes the throwaway redis volume; --rmi local removes this project's built
  # web/backend images (pinned redis/cloudflared have registry names and are kept).
  $COMPOSE down -v --rmi local -t 3 >/dev/null 2>&1 || true
  # Belt-and-suspenders: drop the PID-scoped images by name in case `down` raced.
  docker image rm -f $PROJECT_IMAGES >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Run the in-container driver: stream the script into a throwaway backend-image
# container on the project network. Prints the driver's stdout (GATE_RESULT:...).
driver() {
  local prefix="$1" mode="$2"; shift 2
  $COMPOSE run --rm --no-deps -T \
    -e GATE_PREFIX="$prefix" \
    -e JOB_REDIS_URL="redis://redis:6379/0" \
    --entrypoint python backend - "$mode" "$@" < "$DRIVER" 2>/dev/null
}

driver_result() { sed -n 's/^GATE_RESULT://p' | tail -n1; }

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

has_no_host_port() {
  local svc="$1" cid ports
  cid="$($COMPOSE ps -q "$svc" 2>/dev/null)"
  [ -n "$cid" ] || { echo "missing"; return; }
  ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$cid" 2>/dev/null || echo '{}')"
  printf '%s' "$ports" | grep -q '"HostPort"' && echo yes || echo no
}

# Run one named probe under a host-side deadline, then remove that exact container
# even when the Docker client times out or fails. stdout is returned to the caller.
bounded_probe() {
  local name="$1" deadline="$2" net="$3" code="$4" output rc
  docker rm -f "$name" >/dev/null 2>&1 || true
  output="$(timeout --foreground --kill-after="${PROBE_KILL_GRACE_SECONDS}s" \
    "${deadline}s" docker run --rm --name "$name" --network "$net" \
    --entrypoint python "${PROJECT}-backend" -c "$code" 2>/dev/null)"
  rc=$?
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ "$rc" -eq 0 ]; then
    printf '%s' "$output" | tr -d '\r' | tail -n1
  elif [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo probe-timeout
  else
    echo probe-error
  fi
}

# TCP reachability probe: the outer deadline bounds Docker/container lifecycle;
# the socket timeout remains the second bound. Echoes yes, no, or an error class.
probe() {
  local id="$1" net="$2" host="$3" port="$4" name
  name="${PROJECT}-probe-${id}"
  bounded_probe "$name" "$PROBE_TIMEOUT_SECONDS" "$net" \
"import socket
try:
    socket.create_connection(('$host', $port), timeout=3).close(); print('yes')
except Exception:
    print('no')"
}

expect_reach() {  # id net host port want-yes/no label
  local got; got="$(probe "$1" "$2" "$3" "$4")"
  [ "$got" = "$5" ] && ok "$6" || bad "$6 (network reachability = '$got', expected '$5')"
}

echo "== PUBLIC_ORIGIN validator fixture matrix =="
if python3 docker/validate_origin.py selftest; then
  ok "origin validator fixture matrix correct"
else
  bad "origin validator fixture matrix failed"
fi

echo "== build backend+web (APP_VERSION=$APP_VERSION) =="
$COMPOSE build backend web >/dev/null || { echo "FAIL: build"; exit 1; }

echo "== up private base (web + backend + redis, no overlay) =="
PUBLIC_ORIGIN="$PUBLIC_ORIGIN" $COMPOSE up -d >/dev/null || { echo "FAIL: up"; exit 1; }

echo "== wait for health =="
for svc in redis backend web; do
  st="$(wait_healthy "$svc")"
  [ "$st" = healthy ] && ok "$svc healthy" || bad "$svc never became healthy (status=$st)"
done

echo "== privacy: base publishes no host ports =="
for svc in web backend redis; do
  [ "$(has_no_host_port "$svc")" = no ] && ok "$svc has no host port" || bad "$svc published a host port"
done

echo "== network segmentation reachability matrix =="
# Sensitivity: a hung program must hit the outer deadline, and an ordinary
# nonzero exit must remain distinguishable. Both named containers must be gone.
probe_started=$SECONDS
timeout_probe="${PROJECT}-probe-timeout-sensitivity"
timeout_result="$(bounded_probe "$timeout_probe" 1 "${PROJECT}_app" 'import time; time.sleep(60)')"
probe_elapsed=$((SECONDS - probe_started))
if [ "$timeout_result" = probe-timeout ] && [ "$probe_elapsed" -le 5 ] \
  && ! docker inspect "$timeout_probe" >/dev/null 2>&1; then
  ok "non-terminating network probe is bounded and residue-free"
else
  bad "non-terminating probe result=$timeout_result elapsed=${probe_elapsed}s or left residue"
fi
failure_probe="${PROJECT}-probe-failure-sensitivity"
failure_result="$(bounded_probe "$failure_probe" 3 "${PROJECT}_app" 'raise SystemExit(7)')"
if [ "$failure_result" = probe-error ] && ! docker inspect "$failure_probe" >/dev/null 2>&1; then
  ok "failed network probe is classified and residue-free"
else
  bad "failed probe result=$failure_result or left residue"
fi

# Only permitted edges: ingress→web, app(web)→backend, data(backend)→redis.
expect_reach app-backend     "${PROJECT}_app"     backend 8000 yes "app peer (web) reaches backend"
expect_reach data-redis      "${PROJECT}_data"    redis   6379 yes "data peer (backend) reaches redis"
expect_reach ingress-web     "${PROJECT}_ingress" web     3000 yes "ingress peer (cloudflared) reaches web"
expect_reach app-redis       "${PROJECT}_app"     redis   6379 no  "app peer (web) CANNOT reach redis"
expect_reach ingress-backend "${PROJECT}_ingress" backend 8000 no  "ingress peer CANNOT reach backend"
expect_reach ingress-redis   "${PROJECT}_ingress" redis   6379 no  "ingress peer CANNOT reach redis"

echo "== redis health + non-root =="
$COMPOSE exec -T redis redis-cli ping 2>/dev/null | grep -q PONG \
  && ok "redis answers PING" || bad "redis did not answer PING"
redis_uid="$($COMPOSE exec -T redis sh -c 'sed -n "s/^Uid:\t*\([0-9]*\).*/\1/p" /proc/1/status' 2>/dev/null | tr -d '\r')"
[ -n "$redis_uid" ] && [ "$redis_uid" != 0 ] && ok "redis runs non-root (uid $redis_uid)" \
  || bad "redis runs as root or uid unknown (uid=$redis_uid)"

echo "== backend readiness =="
ready="$($COMPOSE exec -T backend curl -fsS http://127.0.0.1:8000/ready 2>/dev/null || true)"
printf '%s' "$ready" | grep -q '"status":"ready"' \
  && ok "backend /ready is ready" || bad "backend /ready not ready (body: $ready)"

echo "== web health + version equality =="
health="$($COMPOSE exec -T web wget -q -O - http://127.0.0.1:3000/api/health 2>/dev/null || true)"
be_ver="$(printf '%s' "$health" | sed -n 's/.*"appVersion":"\([^"]*\)".*/\1/p')"
[ -n "$be_ver" ] && ok "/api/health returned appVersion=$be_ver" || bad "/api/health missing appVersion (body: $health)"
[ "$be_ver" = "$APP_VERSION" ] && ok "backend appVersion == APP_VERSION" \
  || bad "backend appVersion ($be_ver) != APP_VERSION ($APP_VERSION)"
if $COMPOSE exec -T web sh -c "grep -rq \"$APP_VERSION\" .next/static 2>/dev/null"; then
  ok "client bundle contains NEXT_PUBLIC_APP_VERSION=$APP_VERSION"
else
  bad "client bundle does not contain the stamped version"
fi

echo "== non-root images + one worker =="
web_uid="$($COMPOSE exec -T web id -u 2>/dev/null | tr -d '\r' || echo '?')"
be_uid="$($COMPOSE exec -T backend id -u 2>/dev/null | tr -d '\r' || echo '?')"
[ "$web_uid" = 1000 ] && ok "web runs as uid 1000" || bad "web uid=$web_uid"
[ "$be_uid" = 1000 ] && ok "backend runs as uid 1000" || bad "backend uid=$be_uid"
becmd="$(docker inspect -f '{{json .Config.Cmd}}' "$($COMPOSE ps -q backend)" 2>/dev/null || echo '[]')"
printf '%s' "$becmd" | grep -q '"--workers","1"' \
  && ok "backend CMD has --workers 1" || bad "backend CMD missing --workers 1: $becmd"

echo "== persistence: queued job survives backend restart + redis container replacement =="
jobid="$(driver "$GATE_PREFIX_BASE:persist" seed | driver_result)"
if [ -z "$jobid" ]; then
  bad "could not seed a job for the persistence gate"
else
  $COMPOSE restart backend >/dev/null 2>&1
  [ "$(wait_healthy backend)" = healthy ] || bad "backend did not recover after restart"
  [ "$(driver "$GATE_PREFIX_BASE:persist" check "$jobid" | driver_result)" = OK ] \
    && ok "job survived backend restart" || bad "job lost across backend restart"

  # True container REPLACEMENT (not `restart`): remove the Redis container +
  # its anonymous volumes, then start a fresh one. Only the named `redis-data`
  # volume carries the data across, so this proves the volume, not a warm layer.
  old_redis="$($COMPOSE ps -q redis)"
  $COMPOSE stop redis >/dev/null 2>&1
  $COMPOSE rm -f -v redis >/dev/null 2>&1
  PUBLIC_ORIGIN="$PUBLIC_ORIGIN" $COMPOSE up -d redis >/dev/null 2>&1
  [ "$(wait_healthy redis)" = healthy ] || bad "redis did not recover after container replacement"
  new_redis="$($COMPOSE ps -q redis)"
  [ -n "$new_redis" ] && [ "$new_redis" != "$old_redis" ] \
    && ok "redis container was replaced (id ${old_redis:0:12} → ${new_redis:0:12})" \
    || bad "redis container id did not change (old=$old_redis new=$new_redis)"
  attached="$(docker inspect -f "{{range .Mounts}}{{if eq .Name \"$REDIS_VOLUME\"}}{{.Name}}{{end}}{{end}}" "$new_redis" 2>/dev/null | tr -d '\r')"
  [ "$attached" = "$REDIS_VOLUME" ] \
    && ok "named volume $REDIS_VOLUME reattached to the new redis container" \
    || bad "named volume not attached to new redis container (got '$attached')"
  [ "$(driver "$GATE_PREFIX_BASE:persist" check "$jobid" | driver_result)" = OK ] \
    && ok "job survived redis container replacement (named volume)" \
    || bad "job lost across redis container replacement"
fi

echo "== replay after reconnect (Last-Event-ID) =="
[ "$(driver "$GATE_PREFIX_BASE:replay" replay | driver_result)" = OK ] \
  && ok "replay returns only events after the cursor" || bad "replay-after-cursor gate failed"

echo "== forced worker loss (test-only lease) =="
[ "$(driver "$GATE_PREFIX_BASE:wl" workerlost | driver_result)" = OK ] \
  && ok "SIGKILLed worker becomes retained worker_lost" || bad "worker_lost gate failed"

echo "== Redis outage fails closed (bounded) — F3 =="
# depends_on gates STARTUP only; it is not a runtime circuit breaker. Prove that
# once Redis is gone, the backend readiness/health probes and the current BFF
# /api/health passthrough return a bounded failure rather than hanging or 2xx.
# (The ultimate "don't forward business requests to an unready backend" guarantee
# is a BFF runtime-readiness check owned by the revised T06 ticket.)
$COMPOSE stop redis >/dev/null 2>&1
be_ready_code="$($COMPOSE exec -T backend sh -c 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:8000/ready' 2>/dev/null | tr -d '\r')"
be_health_code="$($COMPOSE exec -T backend sh -c 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://127.0.0.1:8000/health' 2>/dev/null | tr -d '\r')"
[ "$be_ready_code" = 503 ] && ok "backend /ready fails closed with 503 during outage" || bad "backend /ready code=$be_ready_code (expected 503)"
[ "$be_health_code" = 503 ] && ok "backend /health fails closed with 503 during outage" || bad "backend /health code=$be_health_code (expected 503)"
# busybox wget on web: -S prints the status line to stderr; a bounded 5xx is the
# pass condition (BFF forwards backend 503, or 502 if backend is unreachable).
bff_out="$($COMPOSE exec -T web sh -c 'wget -S -q -T 10 -O /dev/null http://127.0.0.1:3000/api/health 2>&1' || true)"
bff_code="$(printf '%s' "$bff_out" | sed -n 's#.*HTTP/[0-9.]* \([0-9]\{3\}\).*#\1#p' | tail -n1)"
case "$bff_code" in
  502|503) ok "BFF /api/health returns bounded $bff_code during outage" ;;
  *) bad "BFF /api/health returned '$bff_code' during outage (expected 502/503)" ;;
esac
# Restore Redis so the remaining gate has a healthy backend again.
PUBLIC_ORIGIN="$PUBLIC_ORIGIN" $COMPOSE up -d redis >/dev/null 2>&1
[ "$(wait_healthy redis)" = healthy ] || bad "redis did not recover after outage gate"
[ "$(wait_healthy backend)" = healthy ] || bad "backend did not recover after outage gate"

echo "== deliberate-mismatch check =="
if docker build -f docker/Dockerfile.web --target runner --build-arg APP_VERSION="$MIS_VER" \
  -t "$MIS_IMAGE" . >/dev/null 2>&1; then
  # Join ONLY the application network — the mismatch probe needs backend, nothing else.
  docker run -d --rm --name "$MIS_NAME" --network "$APP_NETWORK" \
    -e BACKEND_API_URL=http://backend:8000 -e PUBLIC_ORIGIN="http://localhost:3000" \
    "$MIS_IMAGE" >/dev/null 2>&1
  for _ in $(seq 1 20); do
    docker exec "$MIS_NAME" wget -q -O - http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
    sleep 1
  done
  mis_health="$(docker exec "$MIS_NAME" wget -q -O - http://127.0.0.1:3000/api/health 2>/dev/null | sed -n 's/.*"appVersion":"\([^"]*\)".*/\1/p')"
  if docker exec "$MIS_NAME" sh -c "grep -rq \"$MIS_VER\" .next/static 2>/dev/null"; then
    mis_client="$MIS_VER"
  else
    mis_client=""
  fi
  # The equality assertion MUST fail: client stamp != backend appVersion.
  if [ "$mis_client" = "$MIS_VER" ] && [ "$mis_health" = "$APP_VERSION" ] && [ "$mis_client" != "$mis_health" ]; then
    ok "deliberate mismatch observed: client=$mis_client != backend=$mis_health (equality correctly fails)"
  else
    bad "mismatch check unexpected: client=$mis_client backend=$mis_health"
  fi
else
  bad "mismatch web build failed"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
