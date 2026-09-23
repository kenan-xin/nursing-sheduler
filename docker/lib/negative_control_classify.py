#!/usr/bin/env python3
"""Classify the abort negative control from STRUCTURED reporter output.

Usage:
    negative_control_classify.py <exit_code> <report.json> <expected_origin>

Prints exactly one verdict token:

    passed-without-navigation   the control PASSED -- the assertion can false-green
    global-timeout              red via the lane's global cap, not the assertion
    before-assertion            red before the assertion was ever reached
    at-assertion                red AT the intended assertion, still on the fixture
    not-that-assertion          reached it, but that is not what failed

Only ``at-assertion`` is a pass.

Why this replaced whole-log greps
---------------------------------
The predecessor ran independent substring greps over the entire log, so fields from
DIFFERENT failure records cross-satisfied each other. Three measured false greens:
separately-printed structural lines after a forged sentinel; a genuine matcher record
whose received URL was ``http://evil.invalid/not-the-fixture?next=optimize-durable-fixture``
(the route as a SUBSTRING); and matcher/pattern printed before the sentinel with an
unrelated error after it.

Text shape alone cannot fix that: a hand-thrown ``Error`` reproduces Playwright's
reported ``message`` byte-identically. So every field here is read from ONE failing
``expect`` step -- a record Playwright creates only because a matcher ran and failed --
and the received URL is compared as a PARSED URL, never as a substring.

Why ``terminalExpectAudit`` is also required
--------------------------------------------
The reporter decides TERMINALITY (whose error ended the test) by throw-site congruence:
the step's error must match a test-level error on message AND stack AND location, and
the step must own that location. That rejects the forgery the cold review measured --
catching the genuine ``toHaveURL`` failure and rethrowing ``new Error(caught.message)``,
which carries its own stack and line.

It does NOT reject a spec that rebuilds the error object byte-for-byte, copied stack
included: every reporter-visible field is then congruent. So the support module wraps
the intended matcher, remembers the exact error OBJECT it re-propagated, and annotates
the test only when THAT object is the one that escaped the test body -- object identity,
which rethrowing text cannot reproduce. Exactly one such mark is required here.
"""

import json
import sys
from urllib.parse import urlsplit

#: The exact test the control targets.
EXPECTED_TITLE = "abort propagation: browser disconnect cancels upstream SSE body"
#: Playwright's own title for a step created by ``expect(page).toHaveURL(...)``.
EXPECTED_STEP_TITLE = 'Expect "toHaveURL"'
#: The spec that must own the failing assertion.
EXPECTED_SPEC_SUFFIX = "e2e/optimize-assembled-stream.spec.ts"
#: The exact pattern the suppressed navigation was supposed to satisfy.
EXPECTED_PATTERN = r"/\/about$/"
#: The exact path the browser must still be on, compared as a parsed path.
EXPECTED_PATH = "/optimize-durable-fixture"

PASSED = "passed-without-navigation"
TIMEOUT = "global-timeout"
BEFORE = "before-assertion"
AT = "at-assertion"
NOT_THAT = "not-that-assertion"


def _field(message, label):
    """Read ``label`` from THIS step's message. Returns None when absent.

    Scoped to one step's own error text, so it cannot pick up a line another record
    printed. Playwright pads ``Received string:`` with two spaces; strip handles both.
    """
    for line in message.splitlines():
        stripped = line.strip()
        if stripped.startswith(label):
            return stripped[len(label) :].strip()
    return None


def _received_url_is_exactly_the_fixture(raw, expected_origin):
    """True only for the canonical fixture URL on the assembled origin.

    Rejects a foreign host, a path suffix, a query, a fragment and embedded
    credentials -- every one of which a substring check accepted.
    """
    if raw is None:
        return False
    value = raw.strip()
    # Playwright quotes the received string; require the quotes and remove them.
    if len(value) < 2 or not value.startswith('"') or not value.endswith('"'):
        return False
    value = value[1:-1]

    try:
        got = urlsplit(value)
        want = urlsplit(expected_origin)
    except ValueError:
        return False

    if got.scheme != want.scheme or got.scheme not in ("http", "https"):
        return False
    # `netloc` carries any userinfo, so an exact compare rejects credentials too.
    if got.netloc != want.netloc:
        return False
    if got.username or got.password:
        return False
    # EXACT path: no suffix, no extra segment, no trailing slash.
    if got.path != EXPECTED_PATH:
        return False
    if got.query != "" or got.fragment != "":
        return False
    return True


def classify(exit_code, report_path, expected_origin):
    if exit_code == 0:
        return PASSED

    try:
        with open(report_path, "r", encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, ValueError):
        # No structured evidence at all: fail closed rather than guess from text.
        return BEFORE

    tests = report.get("tests")
    if not isinstance(tests, list) or len(tests) != 1:
        # More (or fewer) than the one targeted test means the verdict would be an
        # aggregate across records. That is the defect, so it is a rejection.
        return NOT_THAT
    test = tests[0]
    if not isinstance(test, dict):
        return NOT_THAT

    # STRUCTURAL timeout signal from Playwright's own status, not a text match.
    if test.get("timedOut") is True or test.get("status") == "timedOut":
        return TIMEOUT
    if test.get("title") != EXPECTED_TITLE:
        return NOT_THAT
    if test.get("status") != "failed":
        return NOT_THAT

    # ORDERING: the sentinel is printed on the line before the assertion, so its
    # absence means the test died earlier. Bound to THIS test's own stdout.
    if test.get("sawSentinel") is not True:
        return BEFORE

    # Exactly one test-level error: more than one is cross-failure aggregation.
    if test.get("errorCount") != 1:
        return NOT_THAT

    # THE CAUSAL MARK. Written by the support module's matcher guard, and only when the
    # error object that escaped the test body is the very object the guarded matcher
    # threw. Zero means something else ended the test -- including a byte-identical
    # reconstruction of the matcher's own error, which every field below would accept.
    # More than one means several guarded matchers ended it, so "which one" is ambiguous.
    if test.get("terminalExpectAudit") != 1:
        return NOT_THAT

    steps = test.get("failedExpectSteps")
    if not isinstance(steps, list):
        return NOT_THAT

    # RETRY NOISE IS NOT FAILURE. Playwright's polling assertions retry the matcher and
    # leave an errored expect step per failed attempt -- including for a poll that then
    # SUCCEEDS. A measured control run carried three failing expect steps (two transient
    # `Expect "not toBeNull"` from the abort lane's first-response poll, plus the genuine
    # `Expect "toHaveURL"`) while ``errorCount`` was 1, so demanding exactly one failing
    # expect step rejected a correct control -- nondeterministically, whenever the host
    # was slow enough for that poll to retry.
    #
    # So the judge selects the TERMINAL step: the one whose own error ended the test.
    # The causal guarantee is untouched -- the step must still exist, which only a
    # matcher that ran and failed can produce, and every field below is still read from
    # that one step's own message. Transient attempts are carried for diagnostics and
    # cannot move the verdict.
    terminal = [s for s in steps if isinstance(s, dict) and s.get("terminal") is True]
    if len(terminal) != 1:
        # Zero: the failure was not a matcher at all (a hand-thrown Error produces no
        # expect step), or the reporter marked none as terminal. More than one: several
        # assertions genuinely ended the test, so "which one" is ambiguous.
        return NOT_THAT
    step = terminal[0]

    if step.get("title") != EXPECTED_STEP_TITLE:
        return NOT_THAT
    if not str(step.get("file", "")).endswith(EXPECTED_SPEC_SUFFIX):
        return NOT_THAT

    # Both fields come from THIS step's own message -- the binding that makes
    # cross-record aggregation impossible rather than merely improbable.
    message = step.get("message")
    if not isinstance(message, str):
        return NOT_THAT
    if _field(message, "Expected pattern:") != EXPECTED_PATTERN:
        return NOT_THAT
    if not _received_url_is_exactly_the_fixture(
        _field(message, "Received string:"), expected_origin
    ):
        return NOT_THAT

    return AT


def main(argv):
    if len(argv) != 4:
        sys.stderr.write("usage: negative_control_classify.py <exit> <report.json> <origin>\n")
        return 2
    try:
        exit_code = int(argv[1])
    except ValueError:
        exit_code = 1
    print(classify(exit_code, argv[2], argv[3]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
