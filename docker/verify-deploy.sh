#!/usr/bin/env bash
# Reproducible non-streaming deploy gates (tech-plan §6 item 8, T02 acceptance).
# Builds + starts backend+web via compose and ASSERTS:
#   - /api/health returns backend JSON incl. appVersion
#   - NEXT_PUBLIC_APP_VERSION (client bundle) == /api/health.appVersion == stamped VERSION
#   - backend has no host port (internal-only)
#   - both images run as uid 1000
#   - backend CMD retains --workers 1
#   - a deliberate mismatch (web stamped differently) makes equality FAIL as expected
# Exits non-zero on any failed assertion. The production named-tunnel streaming
# smoke stays manual (T16) — it needs external Cloudflare state.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_VERSION="${APP_VERSION:-$(tr -d '[:space:]' < VERSION 2>/dev/null)}"
if [ -z "$APP_VERSION" ]; then
  echo "FAIL: APP_VERSION/VERSION is empty" >&2
  exit 1
fi

COMPOSE="docker compose -f docker/compose.yml"
WEB_PORT=3000
MIS_PORT=3001
MIS_VER="9.9.9-mismatch"
PASS=0
FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  docker rm -f vd-web-mismatch >/dev/null 2>&1 || true
  docker image rm -f vd-web-mismatch:test >/dev/null 2>&1 || true
  APP_VERSION="$APP_VERSION" $COMPOSE down -t 3 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== build backend+web (APP_VERSION=$APP_VERSION) =="
APP_VERSION="$APP_VERSION" $COMPOSE build backend web >/dev/null || { echo "FAIL: build"; exit 1; }

echo "== up backend+web =="
APP_VERSION="$APP_VERSION" $COMPOSE up -d backend web >/dev/null || { echo "FAIL: up"; exit 1; }

echo "== wait for web health =="
st=none
for _ in $(seq 1 30); do
  st="$(docker inspect -f '{{.State.Health.Status}}' docker-web-1 2>/dev/null || echo none)"
  [ "$st" = healthy ] && break
  sleep 2
done
[ "$st" = healthy ] && ok "web container healthy" || bad "web never became healthy (status=$st)"

echo "== assertions =="
# 1. health passthrough returns appVersion
health="$(curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" 2>/dev/null || true)"
be_ver="$(printf '%s' "$health" | sed -n 's/.*"appVersion":"\([^"]*\)".*/\1/p')"
[ -n "$be_ver" ] && ok "/api/health returned appVersion=$be_ver" || bad "/api/health missing appVersion (body: $health)"

# 2. version equality on raw stamped values
[ "$be_ver" = "$APP_VERSION" ] && ok "backend appVersion == stamped VERSION" \
  || bad "backend appVersion ($be_ver) != stamped VERSION ($APP_VERSION)"
if docker exec docker-web-1 sh -c "grep -rq \"$APP_VERSION\" .next/static 2>/dev/null"; then
  ok "client bundle contains NEXT_PUBLIC_APP_VERSION=$APP_VERSION"
else
  bad "client bundle does not contain the stamped version"
fi

# 3. backend has no host port
beports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' docker-backend-1 2>/dev/null || echo '{}')"
printf '%s' "$beports" | grep -q '"HostPort"' \
  && bad "backend published a host port: $beports" \
  || ok "backend has no host port (internal-only)"

# 4. both run as uid 1000
web_uid="$(docker exec docker-web-1 id -u 2>/dev/null || echo '?')"
be_uid="$(docker exec docker-backend-1 id -u 2>/dev/null || echo '?')"
[ "$web_uid" = 1000 ] && ok "web runs as uid 1000" || bad "web uid=$web_uid"
[ "$be_uid" = 1000 ] && ok "backend runs as uid 1000" || bad "backend uid=$be_uid"

# 5. backend CMD retains --workers 1
becmd="$(docker inspect -f '{{json .Config.Cmd}}' docker-backend-1 2>/dev/null || echo '[]')"
printf '%s' "$becmd" | grep -q '"--workers","1"' \
  && ok "backend CMD has --workers 1" \
  || bad "backend CMD missing --workers 1: $becmd"

# 6. deliberate mismatch: web stamped MIS_VER against the same APP_VERSION backend.
echo "== deliberate-mismatch check =="
net="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' docker-backend-1 2>/dev/null)"
if [ -z "$net" ]; then
  bad "could not resolve backend network for mismatch check"
else
  docker build -f docker/Dockerfile.web --target runner --build-arg APP_VERSION="$MIS_VER" \
    -t vd-web-mismatch:test . >/dev/null 2>&1 || bad "mismatch web build failed"
  docker run -d --rm --name vd-web-mismatch --network "$net" \
    -e BACKEND_API_URL=http://backend:8000 -p "${MIS_PORT}:3000" vd-web-mismatch:test >/dev/null 2>&1
  for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:${MIS_PORT}/" >/dev/null 2>&1 && break; sleep 1; done
  mis_health="$(curl -fsS "http://127.0.0.1:${MIS_PORT}/api/health" 2>/dev/null | sed -n 's/.*"appVersion":"\([^"]*\)".*/\1/p')"
  if docker exec vd-web-mismatch sh -c "grep -rq \"$MIS_VER\" .next/static 2>/dev/null"; then
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
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
