// A machine-readable reporter for the abort negative control (R6 P2-A).
//
// WHY THIS EXISTS, and why log parsing could not be fixed in place.
//
// The control's classifier used to grep the whole gate log for a matcher line, an
// expected pattern and a received URL. Those greps were independent, so fields from
// DIFFERENT failure records cross-satisfied each other — three measured false greens:
//
//   1. forged sentinel + an unrelated error + the three lines printed separately
//   2. genuine matcher/pattern + `Received string: "http://evil.invalid/not-the-fixture
//      ?next=optimize-durable-fixture"` (substring, not the route)
//   3. matcher/pattern BEFORE the sentinel, unrelated error after, fixture line separate
//
// Tightening the greps cannot close this. A probe settled it: a hand-thrown
// `new Error(...)` whose message is the matcher's text reproduces Playwright's JSON
// report `message` field BYTE-IDENTICALLY — the report exposes only `{location,
// message}` per error, and `message` is a string the throwing code owns. Any
// text-shape rule is therefore forgeable by construction.
//
// THE CAUSAL GUARANTEE. Playwright creates a STEP for each `expect` call, with
// `category: "expect"`, and sets that step's `error` only when the matcher itself
// failed. The same probe confirmed the asymmetry directly:
//
//   real  `await expect(page).toHaveURL(/\/about$/)` failing
//         -> step { category: "expect", title: 'Expect "toHaveURL"', error: set,
//                   location: <the assertion's own line> }
//   forged `throw new Error("<the matcher's exact text>")`
//         -> ZERO expect steps
//
// Test code cannot manufacture that step by printing anything; the only way to get one
// is to actually call the matcher, which is the assertion under test. So this reporter
// reads the step tree — Playwright's own record of what ran — and emits it as JSON. The
// classifier then binds every field to ONE step's own error, which is what makes
// cross-record aggregation impossible rather than merely unlikely.
//
// Deliberately NOT asserted here: anything about pass/fail policy. This reporter only
// reports; `docker/lib/negative_control_classify.py` decides.

import { writeFileSync } from "node:fs";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

/** Playwright's own category for a step created by an `expect` call. */
const EXPECT_CATEGORY = "expect";

/** One failing `expect` step, with its error bound to it — never to the run at large. */
export interface FailedExpectStep {
  title: string;
  file: string;
  line: number;
  /** THIS step's error message, ANSI-stripped. Not the run's output. */
  message: string;
  /**
   * Whether this step's error is the one that ENDED the test.
   *
   * RETRY NOISE IS NOT FAILURE. Playwright's polling assertions retry the matcher
   * internally and leave an errored `expect` step per failed attempt — including for a
   * poll that ultimately SUCCEEDS. A measured control run showed exactly that: the
   * abort lane's first-response `expect.poll` needed three attempts, so the report
   * carried three failing expect steps (two transient `Expect "not toBeNull"` at the
   * poll, plus the genuine `Expect "toHaveURL"`), while `errorCount` was 1. A judge
   * that demanded exactly one failing expect step therefore rejected a perfectly
   * correct control as `not-that-assertion`, nondeterministically — red for the wrong
   * reason whenever the host was slow enough for the poll to retry.
   *
   * So each step also reports whether it is TERMINAL: whether its own message is one of
   * the test-level errors. That does not weaken the causal guarantee this reporter
   * exists for — the step must still EXIST, which only a matcher that actually ran and
   * failed can produce, and a hand-thrown `Error` still yields zero expect steps. The
   * flag only selects among genuine expect steps which one ended the test, so a
   * transient attempt can be reported as context without being able to change a verdict.
   */
  terminal: boolean;
}

export interface ReportedTest {
  title: string;
  file: string;
  status: string;
  /** Playwright's structural timeout signal, not a text match on the message. */
  timedOut: boolean;
  /** Test-level errors. More than one means aggregation, which the judge rejects. */
  errorCount: number;
  expectStepCount: number;
  failedExpectSteps: FailedExpectStep[];
  /** Whether this test's OWN stdout carried the ordering sentinel. */
  sawSentinel: boolean;
}

/* eslint-disable-next-line no-control-regex */
const ANSI = /\[[0-9;]*m/g;

function strip(value: string | undefined): string {
  return (value ?? "").replace(ANSI, "");
}

/** The ordering sentinel the abort spec prints just before its URL assertion. */
export const ABORT_CONTROL_SENTINEL = "R6_ABORT_CONTROL_AT_URL_ASSERTION";

function collectFailedExpectSteps(
  steps: readonly TestStep[] | undefined,
  terminalMessages: readonly string[],
): FailedExpectStep[] {
  const found: FailedExpectStep[] = [];
  for (const step of steps ?? []) {
    if (step.category === EXPECT_CATEGORY && step.error !== undefined) {
      const message = strip(step.error.message);
      found.push({
        title: step.title,
        file: step.location?.file ?? "",
        line: step.location?.line ?? 0,
        message,
        terminal: terminalMessages.includes(message),
      });
    }
    found.push(...collectFailedExpectSteps(step.steps, terminalMessages));
  }
  return found;
}

function countExpectSteps(steps: readonly TestStep[] | undefined): number {
  let total = 0;
  for (const step of steps ?? []) {
    if (step.category === EXPECT_CATEGORY) total += 1;
    total += countExpectSteps(step.steps);
  }
  return total;
}

/**
 * Writes `{ tests: ReportedTest[] }` to `process.env.ABORT_CONTROL_REPORT`.
 *
 * Every test that ran is included, so the classifier can insist on seeing EXACTLY the
 * one it grepped for — an extra test in the report is itself a rejection, rather than
 * something to search past.
 */
export default class AbortControlReporter implements Reporter {
  private readonly tests: ReportedTest[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const stdout = result.stdout.map((chunk) => strip(chunk.toString())).join("");
    // The errors that actually ENDED the test, used only to mark which failing expect
    // step is terminal — never as evidence on its own.
    const terminalMessages = result.errors.map((error) => strip(error.message));
    this.tests.push({
      title: test.title,
      file: test.location.file,
      status: result.status,
      timedOut: result.status === "timedOut",
      errorCount: result.errors.length,
      expectStepCount: countExpectSteps(result.steps),
      failedExpectSteps: collectFailedExpectSteps(result.steps, terminalMessages),
      sawSentinel: stdout.includes(ABORT_CONTROL_SENTINEL),
    });
  }

  onEnd(_result: FullResult): void {
    const target = process.env.ABORT_CONTROL_REPORT;
    if (target === undefined || target.length === 0) return;
    writeFileSync(target, JSON.stringify({ tests: this.tests }, null, 2), "utf-8");
  }
}
