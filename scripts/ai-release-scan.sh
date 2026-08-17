#!/usr/bin/env bash
# Bounded secret / content scan for the Phase-1 AI release gate (T11).
#
# WHAT THIS IS FOR. The privacy contract says the OpenRouter credential lives in
# exactly ONE place -- the browser's `assistantSettings` row -- and that the
# same-origin runtime never persists or logs credentials, prompts, complete
# scheduling documents, model output, tool arguments or roster contents. The unit and
# browser suites prove that from the inside. This proves it from the OUTSIDE, over
# the artefacts a release actually produces: the built bundle, the e2e artefacts, the
# repository tree, and (when a stack is up) the container logs.
#
# WHY PATTERNS AND NOT A SECRET LIST. There is no real credential to look for -- and
# there must not be. So the scan looks for the SHAPE of an OpenRouter key, and for
# the header names that carry one, in places neither may appear. The test sentinels
# are allowlisted by exact value: they are deliberately obvious non-secrets, and
# removing them from the allowlist would make the gate fail on its own fixtures
# rather than on a leak.
#
# Exits non-zero on any hit. Safe to run on a clean checkout; sections whose inputs
# are absent are SKIPPED and reported as skipped, never silently passed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
SKIP=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }

# An OpenRouter key: `sk-or-` then a version segment then a long opaque tail. Loose
# enough to catch a real one pasted anywhere, specific enough not to fire on prose.
KEY_SHAPE='sk-or-[A-Za-z0-9]+-[A-Za-z0-9_-]{24,}'

# Deliberately obvious non-secrets used by the suites. Exact strings, so a real key
# that merely resembles one is still caught.
SENTINELS=(
  'sk-or-v1-TEST-SENTINEL-DO-NOT-LEAK-0000000000'
  'sk-or-v1-E2E-SENTINEL-DO-NOT-LEAK-000000000000'
)

# Build one `grep -v` filter chain from the allowlist.
filter_sentinels() {
  local out="$1"
  for sentinel in "${SENTINELS[@]}"; do
    out="$(printf '%s' "$out" | grep -Fv -- "$sentinel")"
  done
  printf '%s' "$out"
}

# Report every line matching $2 under the paths in $3.. , after allowlisting.
scan() {
  local label="$1" pattern="$2"
  shift 2
  local present=()
  for path in "$@"; do
    [ -e "$path" ] && present+=("$path")
  done
  if [ "${#present[@]}" -eq 0 ]; then
    skip "$label (no such artefact in this checkout)"
    return
  fi
  local hits
  hits="$(grep -rIEn -- "$pattern" "${present[@]}" 2>/dev/null || true)"
  hits="$(filter_sentinels "$hits")"
  if [ -n "$hits" ]; then
    bad "$label"
    printf '%s\n' "$hits" | head -n 20 | sed 's/^/        /'
  else
    ok "$label"
  fi
}

echo "== sensitivity: the scan can actually see a key-shaped string =="
# Without this, an empty result would be indistinguishable from a broken regex, a
# moved directory, or a `grep` that skipped everything as binary. The suites' own
# sentinels are known to be present in the tree and known to match the shape, so the
# RAW pattern must find them before any allowlisted scan below is worth trusting.
raw_sentinels="$(grep -rIEo -- "$KEY_SHAPE" web/lib web/e2e 2>/dev/null | wc -l | tr -d ' ')"
if [ "$raw_sentinels" -eq 0 ]; then
  bad "the key-shape pattern matched nothing at all -- the scans below prove nothing"
else
  ok "the key-shape pattern finds the suites' sentinels ($raw_sentinels occurrences)"
fi

echo "== credential shape must not appear in shipped or recorded artefacts =="
scan "no OpenRouter key shape in the repository tree" "$KEY_SHAPE" \
  web/app web/lib web/components web/e2e core docker scripts docs
scan "no OpenRouter key shape in the production bundle" "$KEY_SHAPE" web/.next
scan "no OpenRouter key shape in e2e artefacts" "$KEY_SHAPE" \
  web/test-results web/playwright-report

echo "== the credential header must not be persisted or logged =="
# The header NAME is fine in the protocol modules that define it and the tests that
# exercise it. It must never appear in a log line or a persisted record shape.
header_hits="$(grep -rIn 'x-nurse-ai-key' web/lib web/components web/app 2>/dev/null \
  | grep -E 'console\.|logger|JSON\.stringify' || true)"
if [ -n "$header_hits" ]; then
  bad "the credential header reaches a log or serialization site"
  printf '%s\n' "$header_hits" | sed 's/^/        /'
else
  ok "the credential header reaches no log or serialization site"
fi

echo "== the AI surfaces log nothing at all =="
# Bounded observability is the contract; the implementation went further and logs
# NOTHING from any AI module. Pinning that here means a future `console.log(prompt)`
# is a failed release gate rather than a code-review miss.
log_hits="$(grep -rIn 'console\.\(log\|info\|warn\|error\|debug\|trace\)' \
  web/lib/ai web/components/ai web/components/settings web/app/api/ai web/app/api/copilotkit \
  2>/dev/null || true)"
if [ -n "$log_hits" ]; then
  bad "an AI module writes to the console"
  printf '%s\n' "$log_hits" | sed 's/^/        /'
else
  ok "no AI module writes to the console"
fi

echo "== container logs (only when a stack is up) =="
# APP_VERSION must be set for ANY compose invocation, including `ps` and `logs`:
# compose.yml interpolates it into the build args, and an unset value makes the file
# fail to parse. Without this the lane reported SKIP while a stack was in fact up --
# a scan that silently does not run is worse than one that fails. The value is
# irrelevant here (nothing is built), so it is fixed rather than computed.
COMPOSE_SCAN="env APP_VERSION=scan docker compose -f docker/compose.yml"
if command -v docker >/dev/null 2>&1 && [ -n "$($COMPOSE_SCAN ps -q 2>/dev/null)" ]; then
  logs="$($COMPOSE_SCAN logs --no-color 2>/dev/null || true)"
  leaked="$(printf '%s' "$logs" | grep -EIn -- "$KEY_SHAPE" || true)"
  leaked="$(filter_sentinels "$leaked")"
  if [ -n "$leaked" ]; then
    bad "a container log line carries an OpenRouter key shape"
    printf '%s\n' "$leaked" | head -n 20 | sed 's/^/        /'
  else
    ok "no container log line carries an OpenRouter key shape"
  fi
else
  skip "container logs (no running compose stack)"
fi

echo "== $PASS passed, $FAIL failed, $SKIP skipped =="
[ "$FAIL" -eq 0 ]
