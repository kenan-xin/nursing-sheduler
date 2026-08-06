#!/usr/bin/env bash
# Truth table for the abort negative-control classifier.
#
#   bash docker/lib/negative-control.test.sh
#
# Runs in milliseconds: no Docker, no Compose, no browser. Every fixture is a
# STRUCTURED reporter document of the shape `abort-control-reporter.ts` emits, so the
# table exercises the real decision path rather than a shell-only approximation.
#
# `WHOLE_LOG_GREP_CLASSIFIER` at the bottom is the exact predecessor — independent
# substring greps over the whole log — kept as a committed adversarial baseline and
# asserted to ACCEPT the three false greens the structured judge now rejects. If anyone
# reverts toward whole-log greps, those assertions are what go red.
#
# The reporter half of the judgement — WHICH failing expect step is terminal, and the
# causal audit mark — has its own truth table in
# `web/e2e/support/abort-control-reporter.test.ts`, including the message-membership
# predecessor kept there as the matching adversarial baseline.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=negative-control.sh
. "$HERE/negative-control.sh"

ORIGIN="http://localhost:51236"
TITLE="abort propagation: browser disconnect cancels upstream SSE body"
SPEC="/repo/web/e2e/optimize-assembled-stream.spec.ts"
STEP_TITLE='Expect "toHaveURL"'

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# The genuine matcher message Playwright produces, captured from real 1.61.1 output.
matcher_message() {
  local received="$1"
  printf 'expect(page).toHaveURL(expected) failed\n\nExpected pattern: /\\/about$/\nReceived string:  "%s"\nTimeout: 30000ms\n' "$received"
}

# report <file> <json>
report() { printf '%s\n' "$2" >"$1"; }

# A one-test report with a single failing expect step carrying `received`.
intended_report() {
  local received="$1"
  python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$received")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{
    "title": title, "file": spec, "status": "failed", "timedOut": False,
    "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}],
}]}))
PY
}

# expect_verdict <name> <want> <exit_code> <report-json>
expect_verdict() {
  local name="$1" want="$2" code="$3" body="$4" f got
  f="$WORK/$(echo "$name" | tr ' /()"' '_____').json"
  report "$f" "$body"
  got="$(classify_abort_negative_control "$code" "$f" "$ORIGIN")"
  if [ "$got" = "$want" ]; then
    echo "  PASS: $name -> $got"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name -> got '$got', want '$want'"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# The one intended failure
# ---------------------------------------------------------------------------
INTENDED="$(intended_report "$ORIGIN/optimize-durable-fixture")"
expect_verdict "the exact intended failure" at-assertion 1 "$INTENDED"

# ---------------------------------------------------------------------------
# Exit code / timeout / ordering
# ---------------------------------------------------------------------------
# Assertion removal and skip removal both make the control PASS, which is the same
# rejection: the assertion can go green without the navigation.
expect_verdict "a control that passed (assertion removed)" passed-without-navigation 0 "$INTENDED"
expect_verdict "a control that passed (skip honoured, navigation ran)" passed-without-navigation 0 '{"tests":[]}'

expect_verdict "red via the global test timeout" global-timeout 1 "$(python3 - "$TITLE" "$SPEC" <<'PY'
import json, sys
title, spec = sys.argv[1:3]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "timedOut",
    "timedOut": True, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": []}]}))
PY
)"

# FORGED STRUCTURAL LINES. A hand-thrown Error reproduces the matcher text
# byte-identically, but produces NO expect step — the asymmetry the repair rests on.
expect_verdict "a hand-thrown Error forging the exact matcher text" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, message = sys.argv[1:4]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 0, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": []}]}))
PY
)"

# OUT-OF-ORDER / EARLY FAILURE. No sentinel on this test's own stdout.
expect_verdict "a failure before the assertion (no sentinel)" before-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": False, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

expect_verdict "a missing report" before-assertion 1 'not json at all {'

# ---------------------------------------------------------------------------
# Cross-record aggregation — the finding this round closed
# ---------------------------------------------------------------------------
expect_verdict "two tests in one report (cross-test aggregation)" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
one = {"title": title, "file": spec, "status": "failed", "timedOut": False,
       "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
       "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                              "terminal": True}]}
two = dict(one, title="some other test")
print(json.dumps({"tests": [one, two]}))
PY
)"

expect_verdict "two test-level errors (multiple failures)" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 2, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

expect_verdict "two TERMINAL failing expect steps (ambiguous which failed)" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
step = {"title": step_title, "file": spec, "line": 950, "message": message, "terminal": True}
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 2, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [step, dict(step, line=42)]}]}))
PY
)"

# ---------------------------------------------------------------------------
# THE CAUSAL AUDIT MARK — object identity, not text
# ---------------------------------------------------------------------------
# Throw-site congruence (message AND stack AND location) rejects the rethrow the cold
# review measured, but NOT a spec that rebuilds the error byte-for-byte with the stack
# copied: every reporter-visible field is then congruent, so the step below is genuinely
# `terminal: True` and every other field is exactly right. What fails it is the mark the
# support module writes only when the error OBJECT the guarded matcher threw is the one
# that escaped the test body — which rethrowing text cannot reproduce.
expect_verdict "a congruent step with NO audit mark (byte-identical reconstruction)" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True,
    "terminalExpectAudit": 0,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

# Two marks mean two guarded matchers ended the test, so which one is ambiguous.
expect_verdict "two audit marks (ambiguous which guarded matcher ended it)" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True,
    "terminalExpectAudit": 2,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

# An older report, written before the mark existed, has no field at all. Fail closed.
expect_verdict "a report with no audit field at all" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

# ---------------------------------------------------------------------------
# RETRY NOISE — the defect a live run measured, not a hypothetical
# ---------------------------------------------------------------------------
# Playwright's polling assertions retry the matcher and leave an errored expect step
# per failed attempt, INCLUDING for a poll that ultimately succeeds. The measured
# control run carried three failing expect steps — two transient `Expect "not
# toBeNull"` from the abort lane's first-response poll, plus the genuine
# `Expect "toHaveURL"` — with `errorCount` 1. A judge demanding exactly ONE failing
# expect step therefore rejected a correct control, nondeterministically, whenever the
# host was slow enough for that poll to retry. The verdict now turns on the TERMINAL
# step, so transient attempts are context and cannot move it.
expect_verdict "retry noise around the intended failure (as measured live)" at-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
retry = {"title": 'Expect "not toBeNull"', "file": spec, "line": 953,
         "message": "Error: expect(received).not.toBeNull()\n\nReceived: null",
         "terminal": False}
intended = {"title": step_title, "file": spec, "line": 1008, "message": message,
            "terminal": True}
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 9, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [retry, dict(retry), intended]}]}))
PY
)"

# ...but retry noise ALONE is not the intended failure. Nothing terminal means no
# matcher ended this test, so the control is rejected exactly as a hand-thrown Error is.
expect_verdict "retry noise with NO terminal step" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" <<'PY'
import json, sys
title, spec = sys.argv[1:3]
retry = {"title": 'Expect "not toBeNull"', "file": spec, "line": 953,
         "message": "Error: expect(received).not.toBeNull()\n\nReceived: null",
         "terminal": False}
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 4, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [retry, dict(retry)]}]}))
PY
)"

# And a step that is merely PRESENT is not a step that ended the test: the intended
# matcher, with every field exactly right, still fails when it is not terminal.
expect_verdict "the intended matcher present but NOT terminal" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, step_title, message = sys.argv[1:5]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950,
                           "message": message, "terminal": False}]}]}))
PY
)"

# A DIFFERENT matcher, and a different owning file, must not stand in.
expect_verdict "a different matcher's failing step" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, spec, message = sys.argv[1:4]
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": 'Expect "toBeVisible"', "file": spec, "line": 950,
                           "message": message, "terminal": True}]}]}))
PY
)"

expect_verdict "a failing step owned by another file" not-that-assertion 1 "$(python3 - "$TITLE" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
title, step_title, message = sys.argv[1:4]
spec = "/repo/web/e2e/some-other.spec.ts"
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

expect_verdict "a wrong test title" not-that-assertion 1 "$(python3 - "$SPEC" "$STEP_TITLE" "$(matcher_message "$ORIGIN/optimize-durable-fixture")" <<'PY'
import json, sys
spec, step_title, message = sys.argv[1:4]
print(json.dumps({"tests": [{"title": "a different test entirely", "file": spec,
    "status": "failed", "timedOut": False, "errorCount": 1, "expectStepCount": 1,
    "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

# ---------------------------------------------------------------------------
# Received URL — parsed exactly, never as a substring
# ---------------------------------------------------------------------------
# Each of these CONTAINS `optimize-durable-fixture`, which is exactly why the old
# substring check accepted them.
for received in \
  "http://evil.invalid/not-the-fixture?next=optimize-durable-fixture" \
  "$ORIGIN/optimize-durable-fixture?x=1" \
  "$ORIGIN/optimize-durable-fixture#frag" \
  "$ORIGIN/optimize-durable-fixture/extra" \
  "$ORIGIN/optimize-durable-fixture-suffix" \
  "$ORIGIN/prefix/optimize-durable-fixture" \
  "http://user:pass@localhost:51236/optimize-durable-fixture" \
  "http://localhost:9999/optimize-durable-fixture" \
  "https://localhost:51236/optimize-durable-fixture" \
  "$ORIGIN/optimize-durable-fixture/" \
  ; do
  expect_verdict "received URL $received" not-that-assertion 1 "$(intended_report "$received")"
done

# A wrong expected pattern cannot stand in for the /about one.
expect_verdict "a different expected pattern" not-that-assertion 1 "$(python3 - "$TITLE" "$SPEC" "$STEP_TITLE" "$ORIGIN" <<'PY'
import json, sys
title, spec, step_title, origin = sys.argv[1:5]
message = ('expect(page).toHaveURL(expected) failed\n\n'
           'Expected pattern: /\\/optimize-and-export$/\n'
           'Received string:  "%s/optimize-durable-fixture"\n' % origin)
print(json.dumps({"tests": [{"title": title, "file": spec, "status": "failed",
    "timedOut": False, "errorCount": 1, "expectStepCount": 1, "sawSentinel": True, "terminalExpectAudit": 1,
    "failedExpectSteps": [{"title": step_title, "file": spec, "line": 950, "message": message,
                           "terminal": True}]}]}))
PY
)"

# ---------------------------------------------------------------------------
# MUTATION PROOF — the whole-log grep predecessor accepted the false greens
# ---------------------------------------------------------------------------
WHOLE_LOG_GREP_CLASSIFIER() {
  local log="$1"
  grep -qF "R6_ABORT_CONTROL_AT_URL_ASSERTION" "$log" || return 1
  grep -qF "expect(page).toHaveURL(expected) failed" "$log" || return 1
  grep -qF 'Expected pattern: /\/about$/' "$log" || return 1
  grep -F 'Received string:' "$log" | grep -qF "optimize-durable-fixture" || return 1
  grep -qE 'Test timeout of [0-9]+ms exceeded' "$log" && return 1
  return 0
}

# The three false greens the review named, as LOGS (what the predecessor consumed).
cat >"$WORK/fg1.log" <<'EOF'
R6_ABORT_CONTROL_AT_URL_ASSERTION
    Error: locator.click: Target page closed
    a line mentioning expect(page).toHaveURL(expected) failed
    an unrelated block: Expected pattern: /\/about$/
    a different record: Received string:  "http://localhost:1/optimize-durable-fixture"
EOF
cat >"$WORK/fg2.log" <<'EOF'
R6_ABORT_CONTROL_AT_URL_ASSERTION
    Error: expect(page).toHaveURL(expected) failed
    Expected pattern: /\/about$/
    Received string:  "http://evil.invalid/not-the-fixture?next=optimize-durable-fixture"
EOF
cat >"$WORK/fg3.log" <<'EOF'
    Error: expect(page).toHaveURL(expected) failed
    Expected pattern: /\/about$/
R6_ABORT_CONTROL_AT_URL_ASSERTION
    Error: page.evaluate: Execution context was destroyed
    Received string:  "http://localhost:51236/optimize-durable-fixture"
EOF

for n in 1 2 3; do
  if WHOLE_LOG_GREP_CLASSIFIER "$WORK/fg$n.log"; then
    echo "  PASS: the whole-log grep predecessor ACCEPTED false green $n (as measured)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: false green $n no longer reproduces against the predecessor"
    FAIL=$((FAIL + 1))
  fi
done

# ...and it accepted the genuine failure too, so it is a faithful replica.
cat >"$WORK/genuine.log" <<'EOF'
R6_ABORT_CONTROL_AT_URL_ASSERTION
    Error: expect(page).toHaveURL(expected) failed
    Expected pattern: /\/about$/
    Received string:  "http://localhost:51236/optimize-durable-fixture"
EOF
if WHOLE_LOG_GREP_CLASSIFIER "$WORK/genuine.log"; then
  echo "  PASS: the predecessor also accepted the genuine failure (faithful replica)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: the predecessor rejects the genuine failure; not a faithful replica"
  FAIL=$((FAIL + 1))
fi

# The structured judge's verdict on the SAME three shapes is above:
#   1 -> not-that-assertion (no expect step)
#   2 -> not-that-assertion (received URL is not the fixture when PARSED)
#   3 -> not-that-assertion (no expect step; matcher text was never a step's error)

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
