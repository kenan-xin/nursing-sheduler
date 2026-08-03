#!/usr/bin/env bash
# The abort negative control's CLASSIFIER, extracted so it is a total function over
# (exit code, log) and can be adversarially tested without bringing up the Compose
# stack. See `negative-control.test.sh` beside it for the truth table, including the
# spoof attempts this shape exists to reject.
#
# Sourced by `docker/verify-stream.sh`; defines functions only, runs nothing.

# Printed by the abort spec on the line immediately before its URL assertion, in
# control mode only. Kept in sync with `ABORT_CONTROL_SENTINEL` in
# `web/e2e/support/abort-control-reporter.ts`.
NEG_SENTINEL="R6_ABORT_CONTROL_AT_URL_ASSERTION"

# classify_abort_negative_control <exit_code> <report_json> <expected_origin>
#
# Echoes exactly one verdict token:
#
#   passed-without-navigation  the control PASSED — the assertion can false-green
#   global-timeout             red via the lane's global cap, not the assertion
#   before-assertion           red before the assertion was ever reached
#   at-assertion               red AT the intended assertion, still on the fixture
#   not-that-assertion         reached the assertion but failed as something else
#
# Only `at-assertion` is a pass.
#
# WHOLE-LOG GREPS ARE GONE. The predecessor ran independent substring greps over the
# entire log, so fields from DIFFERENT failure records cross-satisfied each other —
# three measured false greens (separately-printed structural lines after a forged
# sentinel; a genuine matcher record whose received URL merely CONTAINED the route,
# `http://evil.invalid/not-the-fixture?next=optimize-durable-fixture`; and
# matcher/pattern before the sentinel with an unrelated error after it).
#
# Text shape could not fix it: a probe showed a hand-thrown `Error` reproduces
# Playwright's reported message byte-identically. So the decision now reads Playwright's
# own STEP TREE via `web/e2e/support/abort-control-reporter.ts`, and every field is bound
# to ONE failing `expect` step — a record that exists only because a matcher ran and
# failed. The parsing lives in `negative_control_classify.py` because the received URL
# must be compared as a PARSED URL (foreign host, suffix, query, fragment and embedded
# credentials all rejected), which is not something to attempt in shell.
classify_abort_negative_control() {
  local exit_code="$1" report="$2" origin="$3"
  python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/negative_control_classify.py" \
    "$exit_code" "$report" "$origin"
}
