#!/usr/bin/env bash
# Sensitive version-stamp gate for the diagnostic image (U30b fixup P0).
#
# Proves the diagnostic image stamps the version through the SAME settled boundary as
# the backend — APP_VERSION (build arg → env) and /app/VERSION (root VERSION file) —
# so `get_app_version()` returns the root VERSION and NEVER the `v0.0.0-unknown`
# fallback. It also proves the gate is SENSITIVE: with the stamp removed (the pre-fix
# behavior), the same image would return `v0.0.0-unknown`. No Git is used at build or
# runtime. Builds a throwaway-tagged image and removes it on exit (residue-free).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_VERSION="${APP_VERSION:-$(tr -d '[:space:]' < VERSION 2>/dev/null)}"
if [ -z "$APP_VERSION" ]; then
  echo "FAIL: APP_VERSION/VERSION is empty" >&2
  exit 1
fi

IMAGE="nurse-scheduling-diagnostic-versiontest-$$:local"
GET_VERSION='import nurse_scheduling.server.app as a; print(a.get_app_version())'

PASS=0
FAIL=0
ok() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

cleanup() { docker image rm -f "$IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== build diagnostic image (APP_VERSION=$APP_VERSION) =="
docker build -f docker/Dockerfile.diagnostic --build-arg APP_VERSION="$APP_VERSION" \
  -t "$IMAGE" . >/dev/null 2>&1 || { echo "FAIL: diagnostic image build"; exit 1; }

echo "== stamped image reports the root VERSION =="
env_ver="$(docker run --rm --entrypoint sh "$IMAGE" -c 'printf %s "$APP_VERSION"' 2>/dev/null | tr -d '\r')"
file_ver="$(docker run --rm --entrypoint sh "$IMAGE" -c 'cat /app/VERSION' 2>/dev/null | tr -d '[:space:]')"
got_ver="$(docker run --rm --entrypoint python "$IMAGE" -c "$GET_VERSION" 2>/dev/null | tr -d '[:space:]')"
[ "$env_ver" = "$APP_VERSION" ] && ok "APP_VERSION env == root VERSION ($env_ver)" || bad "APP_VERSION env='$env_ver' != '$APP_VERSION'"
[ "$file_ver" = "$APP_VERSION" ] && ok "/app/VERSION == root VERSION ($file_ver)" || bad "/app/VERSION='$file_ver' != '$APP_VERSION'"
[ "$got_ver" = "$APP_VERSION" ] && ok "get_app_version() == root VERSION ($got_ver)" || bad "get_app_version()='$got_ver' != '$APP_VERSION'"
[ "$got_ver" != "v0.0.0-unknown" ] && ok "get_app_version() is not the unknown fallback" || bad "get_app_version() returned the unknown fallback"

echo "== sensitivity: an unstamped run falls back to v0.0.0-unknown =="
# Clear the env stamp AND remove the baked file — exactly the pre-fix image (no
# APP_VERSION arg, no /app/VERSION). If this did NOT return the unknown fallback, the
# assertions above would be meaningless.
unknown="$(docker run --rm -e APP_VERSION= --entrypoint sh "$IMAGE" \
  -c 'rm -f /app/VERSION && python -c "import nurse_scheduling.server.app as a; print(a.get_app_version())"' \
  2>/dev/null | tr -d '[:space:]')"
[ "$unknown" = "v0.0.0-unknown" ] && ok "unstamped fallback is v0.0.0-unknown (gate is sensitive)" \
  || bad "unstamped fallback='$unknown' (expected v0.0.0-unknown)"

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
