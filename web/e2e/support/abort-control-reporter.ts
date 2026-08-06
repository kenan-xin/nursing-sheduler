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
// message, stack, snippet}` per error, and `message` is a string the throwing code owns.
// Any text-shape rule is therefore forgeable by construction.
//
// THE CAUSAL GUARANTEE, in three independent layers.
//
// LAYER 1 — the step must EXIST. Playwright creates a STEP for each `expect` call, with
// `category: "expect"`, and sets that step's `error` only when the matcher itself
// failed. A probe of the installed 1.61.1 runtime confirmed the asymmetry directly:
//
//   real  `await expect(page).toHaveURL(/\/about$/)` failing
//         -> step { category: "expect", title: 'Expect "toHaveURL"', error: set,
//                   location: <the assertion's own line> }
//   forged `throw new Error("<the matcher's exact text>")`
//         -> ZERO expect steps
//
// Test code cannot manufacture that step by printing anything; the only way to get one
// is to actually call the matcher, which is the assertion under test.
//
// LAYER 2 — the step's error must BE the error that ended the test. This is where the
// previous shape broke: it marked a step terminal when the step's message appeared in
// `result.errors`, so catching a genuine `toHaveURL` failure and rethrowing
// `new Error(caught.message)` marked the caught — non-terminal — step as terminal.
//
// Playwright's public reporter offers no object identity to lean on: `step.error` and
// `result.errors[i]` are serialized SEPARATELY, so `===` is always false (measured).
// What it does expose is what Playwright derives from the THROW SITE — `stack` and
// `location` — so terminality is now full-record congruence:
//
//   step.error.message === e.message  AND  step.error.stack === e.stack
//   AND step.error.location === e.location   (file+line+column)
//   AND step.location === step.error.location  (the step owns its own error's site)
//   AND exactly ONE test-level error matches
//
// Measured against 1.61.1 with a real Chromium `toHaveURL` failure:
//
//   genuine                  -> step loc == error loc == test-error loc; stacks equal
//   `new Error(msg)` rethrow -> stacks differ, test-error location is the THROW site
//   `expect.poll` retry noise -> transient attempt steps carry NO stack and NO
//                                location at all, so they can never be terminal
//
// LAYER 3 — the audit mark, because layer 2 is still only as strong as the throw site.
// A spec that reconstructs the error byte-for-byte (`e.stack = caught.stack`) IS
// congruent, as the same probe measured. So `guardTerminalExpect` below wraps the
// intended matcher, remembers the exact error OBJECT it re-propagated in a module-scoped
// `WeakSet`, and `auditTerminalExpect` — wrapping the whole test body — annotates the
// test only when the object that ESCAPED the body is that same object. Object identity
// is not reproducible by rethrowing text, so the byte-identical reconstruction above
// produces NO annotation (measured: annotation present for the genuine failure, absent
// for both the same-message and the copied-stack rethrow). The classifier requires
// exactly one mark, so the guarded matcher's own error must have ended the test.
//
// Deliberately NOT asserted here: anything about pass/fail policy. This reporter only
// reports; `docker/lib/negative_control_classify.py` decides. The pure judgements are
// exported and their truth table lives in `abort-control-reporter.test.ts`, which also
// keeps the message-membership predecessor as a committed adversarial baseline.

import { writeFileSync } from "node:fs";
import type {
  FullResult,
  Location,
  Reporter,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

/** Playwright's own category for a step created by an `expect` call. */
const EXPECT_CATEGORY = "expect";

/**
 * Annotation type the audit wrapper pushes when the error that escaped the test body
 * is the very object a guarded matcher threw. Read by the reporter, required by the
 * classifier. The description is diagnostic only — the TYPE and the COUNT decide.
 */
export const TERMINAL_EXPECT_AUDIT = "r6-terminal-expect";

/**
 * Errors this module re-propagated out of a guarded matcher, by OBJECT identity.
 *
 * Module-scoped and per worker process, which is all that is needed: the guard and the
 * audit run in the same worker, while the reporter reads only the annotation they leave
 * behind. A `WeakSet` so a retained error cannot keep a page or fixture alive.
 */
const guardedMatcherErrors = new WeakSet<object>();

/**
 * Run the ONE assertion the negative control turns on, and remember the exact error
 * object it threw. Rethrows that same object, unchanged — this must not alter the
 * failure the classifier reads, only witness it.
 */
export async function guardTerminalExpect<T>(body: () => Promise<T> | T): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (typeof error === "object" && error !== null) guardedMatcherErrors.add(error);
    throw error;
  }
}

/** The `testInfo.annotations` surface the audit needs, and nothing more. */
export interface TerminalExpectAuditSink {
  annotations: Array<{ type: string; description?: string }>;
}

/**
 * Wrap a whole test body so the error that ESCAPED it can be compared, by object
 * identity, against what a guarded matcher threw. Only then is the test annotated.
 *
 * This is the part a mutation of the spec cannot fake: catching the guarded failure and
 * throwing anything else — including a byte-identical reconstruction of it — leaves a
 * DIFFERENT object escaping, so no mark is written and the control is rejected.
 */
export async function auditTerminalExpect(
  sink: TerminalExpectAuditSink,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (typeof error === "object" && error !== null && guardedMatcherErrors.has(error)) {
      sink.annotations.push({
        type: TERMINAL_EXPECT_AUDIT,
        description: "a guarded matcher's own error object ended this test",
      });
    }
    throw error;
  }
}

/** One failing `expect` step, with its error bound to it — never to the run at large. */
export interface FailedExpectStep {
  title: string;
  file: string;
  line: number;
  /** Column of the step's own location, so the throw site is reported in full. */
  column: number;
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
   * So each step also reports whether it is TERMINAL. That is decided by throw-site
   * congruence with a test-level error (see `isTerminalExpectStep`), never by message
   * membership: a caught matcher whose text was rethrown is NOT terminal, because the
   * rethrow's stack and location are its own.
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
  /**
   * How many `TERMINAL_EXPECT_AUDIT` marks this test carries — i.e. how many times a
   * guarded matcher's own error OBJECT escaped the test body. The judge requires
   * exactly one, which is what closes the byte-identical-reconstruction forgery that
   * throw-site congruence alone cannot see.
   */
  terminalExpectAudit: number;
}

/**
 * SGR colour sequences, with the ESC byte optional so a sequence is stripped whether or
 * not it carries one. The predecessor matched only `[<n>m` and left the ESC behind,
 * which would have broken the classifier's exact `Expected pattern:` line compare had
 * the gate ever run with colour enabled.
 */
/* eslint-disable-next-line no-control-regex */
const ANSI = /?\[[0-9;]*m/g;

function strip(value: string | undefined): string {
  return (value ?? "").replace(ANSI, "");
}

/** The ordering sentinel the abort spec prints just before its URL assertion. */
export const ABORT_CONTROL_SENTINEL = "R6_ABORT_CONTROL_AT_URL_ASSERTION";

/**
 * The identity of one serialized error: only the parts Playwright DERIVES from the
 * throw site. `message` alone is owned by the throwing code, so it never decides
 * anything on its own here.
 *
 * A record missing any part cannot be bound to anything — notably an `expect.poll`
 * transient attempt, which carries neither stack nor location.
 */
export interface ThrowSiteIdentity {
  message: string;
  stack: string;
  location: Location;
}

/** Total: an error that cannot be pinned to a throw site yields `null`, never a guess. */
export function throwSiteIdentity(error: TestError | undefined): ThrowSiteIdentity | null {
  if (error === undefined) return null;
  const message = strip(error.message);
  const stack = strip(error.stack);
  if (message.length === 0 || stack.length === 0 || error.location === undefined) return null;
  return { message, stack, location: error.location };
}

/** Exact file+line+column equality. An absent location matches nothing, including itself. */
export function sameLocation(a: Location | undefined, b: Location | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.file === b.file && a.line === b.line && a.column === b.column;
}

function sameThrowSite(a: ThrowSiteIdentity, b: ThrowSiteIdentity): boolean {
  return a.message === b.message && a.stack === b.stack && sameLocation(a.location, b.location);
}

/**
 * Whether this failing expect step's error is the one that ended the test.
 *
 * Three conjuncts, each closing a measured shape:
 *
 *   1. the step's error must be pinnable to a throw site  -> poll retry noise is out
 *   2. the step must OWN that site (`step.location`)      -> a step cannot inherit
 *                                                            another record's site
 *   3. exactly one test-level error must be congruent     -> a rethrow carries its own
 *      on message AND stack AND location                     stack/location; two equal
 *                                                            test errors are ambiguous
 */
export function isTerminalExpectStep(
  step: Pick<TestStep, "error" | "location">,
  testErrors: readonly TestError[],
): boolean {
  const stepSite = throwSiteIdentity(step.error);
  if (stepSite === null) return false;
  if (!sameLocation(step.location, stepSite.location)) return false;
  let matches = 0;
  for (const candidate of testErrors) {
    const site = throwSiteIdentity(candidate);
    if (site !== null && sameThrowSite(site, stepSite)) matches += 1;
  }
  return matches === 1;
}

function collectFailedExpectSteps(
  steps: readonly TestStep[] | undefined,
  testErrors: readonly TestError[],
): FailedExpectStep[] {
  const found: FailedExpectStep[] = [];
  for (const step of steps ?? []) {
    if (step.category === EXPECT_CATEGORY && step.error !== undefined) {
      found.push({
        title: step.title,
        file: step.location?.file ?? "",
        line: step.location?.line ?? 0,
        column: step.location?.column ?? 0,
        message: strip(step.error.message),
        terminal: isTerminalExpectStep(step, testErrors),
      });
    }
    found.push(...collectFailedExpectSteps(step.steps, testErrors));
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

/** The structural subset of `TestCase` this report is built from. */
export type ReportedCaseInput = { title: string; location: { file: string } };

/** The structural subset of `TestResult` this report is built from. */
export type ReportedResultInput = {
  status: string;
  errors: readonly TestError[];
  steps: readonly TestStep[];
  stdout: readonly (string | Buffer)[];
  annotations: readonly { type: string; description?: string }[];
};

/**
 * Build one `ReportedTest`. Pure, so the whole judgement is provable in the unit suite
 * instead of only inside a Compose run.
 */
export function describeTestResult(
  test: ReportedCaseInput,
  result: ReportedResultInput,
): ReportedTest {
  const stdout = result.stdout.map((chunk) => strip(chunk.toString())).join("");
  return {
    title: test.title,
    file: test.location.file,
    status: result.status,
    timedOut: result.status === "timedOut",
    errorCount: result.errors.length,
    expectStepCount: countExpectSteps(result.steps),
    failedExpectSteps: collectFailedExpectSteps(result.steps, result.errors),
    sawSentinel: stdout.includes(ABORT_CONTROL_SENTINEL),
    terminalExpectAudit: result.annotations.filter(
      (annotation) => annotation.type === TERMINAL_EXPECT_AUDIT,
    ).length,
  };
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
    this.tests.push(describeTestResult(test, result));
  }

  onEnd(_result: FullResult): void {
    const target = process.env.ABORT_CONTROL_REPORT;
    if (target === undefined || target.length === 0) return;
    writeFileSync(target, JSON.stringify({ tests: this.tests }, null, 2), "utf-8");
  }
}
