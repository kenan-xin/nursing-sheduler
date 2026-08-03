#!/usr/bin/env bash
# Truth table for the abort negative-control classifier, including the two spoofs the
# keyword version accepted. Runs in milliseconds and needs no Docker, no Compose and
# no browser — so the classifier is proved on every change instead of being exercised
# once per (multi-minute) gate run.
#
#   bash docker/lib/negative-control.test.sh
#
# The `at-assertion` fixture below is REAL Playwright 1.61.1 output, captured from an
# actual failing `expect(page).toHaveURL()` rather than written from memory. The
# `KEYWORD_CLASSIFIER` at the bottom is the exact predecessor, kept as a committed
# adversarial baseline and asserted to accept what the current one rejects.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=negative-control.sh
. "$HERE/negative-control.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# expect_verdict <name> <expected> <exit_code> <log_contents>
expect_verdict() {
  local name="$1" want="$2" code="$3" body="$4" log got
  log="$WORK/$(echo "$name" | tr ' /' '__').log"
  printf '%s\n' "$body" >"$log"
  got="$(classify_abort_negative_control "$code" "$log")"
  if [ "$got" = "$want" ]; then
    echo "  PASS: $name -> $got"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name -> got '$got', want '$want'"
    FAIL=$((FAIL + 1))
  fi
}

# The genuine intended failure: the navigation was suppressed, the sentinel printed on
# the line before the assertion, and the page is still on the fixture route.
REAL_AT_ASSERTION="Running 1 test using 1 worker

[1/1] e2e/optimize-assembled-stream.spec.ts:812:7 › abort propagation
R6_ABORT_CONTROL_AT_URL_ASSERTION

  1) e2e/optimize-assembled-stream.spec.ts:812:7 › abort propagation ──────────────────

    Error: expect(page).toHaveURL(expected) failed

    Expected pattern: /\\/about\$/
    Received string:  \"http://localhost:51236/optimize-durable-fixture\"
    Timeout: 30000ms

    Call log:
      - Expect \"toHaveURL\" with timeout 30000ms

  1 failed"

expect_verdict "the genuine intended failure" at-assertion 1 "$REAL_AT_ASSERTION"

# A control that PASSES means the assertion can false-green without the navigation.
expect_verdict "a control that passed" passed-without-navigation 0 "$REAL_AT_ASSERTION"

# The original weakness: red via the lane's global cap. Rejected even though every
# other marker is present, because a lane out of total time proves nothing about the
# assertion.
expect_verdict "red via the global test timeout" global-timeout 1 "$REAL_AT_ASSERTION
    Test timeout of 155000ms exceeded."

# SPOOF 1 — a failure BEFORE the assertion. Playwright prints a code frame on any
# failure in that function, and the spec's own source contains both `toHaveURL` and
# `/about`, so the keyword classifier called this the intended failure.
SPOOF_BEFORE="Running 1 test using 1 worker

  1) e2e/optimize-assembled-stream.spec.ts:812:7 › abort propagation ──────────────────

    Error: locator.click: Target page closed

      920 |     await expect(page).toHaveURL(/\\/about\$/, { timeout: 30000 });

  1 failed"

expect_verdict "a failure before the assertion, with the code frame" before-assertion 1 "$SPOOF_BEFORE"

# SPOOF 2 — an unrelated error thrown AFTER the sentinel printed, carrying both
# keywords in its own message. The sentinel cannot rule this out; the MATCHER SHAPE is
# what does, because a hand-thrown Error has no `Expected pattern:`/`Received string:`.
SPOOF_AFTER="Running 1 test using 1 worker

[1/1] e2e/optimize-assembled-stream.spec.ts:812:7 › abort propagation
R6_ABORT_CONTROL_AT_URL_ASSERTION

  1) e2e/optimize-assembled-stream.spec.ts:812:7 › abort propagation ──────────────────

    Error: toHaveURL bookkeeping for /about could not be recorded

  1 failed"

expect_verdict "an unrelated error after the sentinel" not-that-assertion 1 "$SPOOF_AFTER"

# A REAL toHaveURL failure, but on some other page state — the received URL is already
# /about, so the suppressed navigation is not what failed.
expect_verdict "a toHaveURL failure not on the fixture route" not-that-assertion 1 "R6_ABORT_CONTROL_AT_URL_ASSERTION
    Error: expect(page).toHaveURL(expected) failed

    Expected pattern: /\\/about\$/
    Received string:  \"http://localhost:51236/about-us\""

# A DIFFERENT URL assertion must not stand in for this one.
expect_verdict "a toHaveURL failure on a different pattern" not-that-assertion 1 "R6_ABORT_CONTROL_AT_URL_ASSERTION
    Error: expect(page).toHaveURL(expected) failed

    Expected pattern: /\\/optimize-and-export\$/
    Received string:  \"http://localhost:51236/optimize-durable-fixture\""

# An empty log is not evidence of anything.
expect_verdict "an empty log" before-assertion 1 ""

# An unreadable log fails closed rather than being treated as the intended failure.
if [ "$(classify_abort_negative_control 1 "$WORK/does-not-exist.log")" = before-assertion ]; then
  echo "  PASS: a missing log -> before-assertion"
  PASS=$((PASS + 1))
else
  echo "  FAIL: a missing log did not classify as before-assertion"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# MUTATION PROOF. The exact keyword classifier this replaces, asserted to ACCEPT both
# spoofs. If someone ever weakens the classifier back toward it, this goes red.
# ---------------------------------------------------------------------------
KEYWORD_CLASSIFIER() {
  local log="$1"
  grep -q 'toHaveURL' "$log" || return 1
  grep -qE '/about' "$log" || return 1
  grep -qE 'Test timeout of [0-9]+ms exceeded' "$log" && return 1
  return 0
}

for spoof in BEFORE AFTER; do
  log="$WORK/spoof_$spoof.log"
  [ "$spoof" = BEFORE ] && printf '%s\n' "$SPOOF_BEFORE" >"$log" || printf '%s\n' "$SPOOF_AFTER" >"$log"
  if KEYWORD_CLASSIFIER "$log"; then
    echo "  PASS: the keyword classifier ACCEPTED spoof $spoof (the false green it was)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: spoof $spoof no longer reproduces the keyword classifier's false green"
    FAIL=$((FAIL + 1))
  fi
done

# ...and that it still accepted the genuine failure, so it is a faithful replica of the
# predecessor rather than a straw man.
printf '%s\n' "$REAL_AT_ASSERTION" >"$WORK/real.log"
if KEYWORD_CLASSIFIER "$WORK/real.log"; then
  echo "  PASS: the keyword classifier also accepted the genuine failure (faithful replica)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: the keyword baseline rejects the genuine failure; it is not a faithful replica"
  FAIL=$((FAIL + 1))
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
