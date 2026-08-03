#!/usr/bin/env bash
# The abort negative control's CLASSIFIER, extracted so it is a total function over
# (exit code, log) and can be adversarially tested without bringing up the Compose
# stack. See `negative-control.test.sh` beside it for the truth table, including the
# spoof attempts this shape exists to reject.
#
# Sourced by `docker/verify-stream.sh`; defines functions only, runs nothing.

# Printed by the abort spec on the line immediately before its URL assertion, in
# control mode only. Kept in sync with `ABORT_CONTROL_SENTINEL` in
# `web/e2e/optimize-assembled-stream.spec.ts`.
NEG_SENTINEL="R6_ABORT_CONTROL_AT_URL_ASSERTION"
# Playwright's exact failure line for this matcher on a Page (verified against
# Playwright 1.61.1 output, not assumed).
NEG_MATCHER="expect(page).toHaveURL(expected) failed"
# The exact expected pattern, so some OTHER URL assertion cannot stand in for it.
NEG_PATTERN='Expected pattern: /\/about$/'
# Positive evidence that the suppressed navigation is what failed: the page is still
# on the fixture route.
NEG_FIXTURE_ROUTE="optimize-durable-fixture"
# Playwright's global per-test timeout signature, which must NOT be how it went red.
NEG_GLOBAL_TIMEOUT_RE='Test timeout of [0-9]+ms exceeded'

# classify_abort_negative_control <exit_code> <log_file>
#
# Echoes exactly one verdict token:
#
#   passed-without-navigation  the control PASSED — the assertion can false-green
#   global-timeout             red via the lane's global cap, not the assertion
#   before-assertion           red before the assertion was ever reached
#   at-assertion               red AT the intended assertion, still on the fixture
#   not-that-assertion         reached the assertion but failed as something else
#
# Only `at-assertion` is a pass. The ordering matters: a global timeout is reported as
# such even when the sentinel printed, because a lane that runs out of total time has
# not demonstrated anything about the assertion.
classify_abort_negative_control() {
  local exit_code="$1" log="$2"

  if [ "$exit_code" = 0 ]; then
    echo "passed-without-navigation"
    return
  fi
  if [ ! -r "$log" ]; then
    echo "before-assertion"
    return
  fi
  if grep -qE "$NEG_GLOBAL_TIMEOUT_RE" "$log"; then
    echo "global-timeout"
    return
  fi
  # POSITIONAL. Nothing that fails before the assertion can have printed this.
  if ! grep -qF "$NEG_SENTINEL" "$log"; then
    echo "before-assertion"
    return
  fi
  # STRUCTURAL. -F throughout: exact literals, so a regex metacharacter in the matcher
  # text cannot quietly widen what counts as a match. A hand-thrown `Error` cannot
  # produce the matcher line plus the `Expected pattern:`/`Received string:` pair.
  if grep -qF "$NEG_MATCHER" "$log" &&
    grep -qF "$NEG_PATTERN" "$log" &&
    grep -F 'Received string:' "$log" | grep -qF "$NEG_FIXTURE_ROUTE"; then
    echo "at-assertion"
    return
  fi
  echo "not-that-assertion"
}
