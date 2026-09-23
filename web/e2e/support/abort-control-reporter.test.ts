// R6 — the abort negative control's REPORTER truth table, proved without Playwright.
//
// The reporter decides one thing the classifier cannot re-derive: which failing
// `expect` step is TERMINAL, i.e. whose own error ended the test. The shape that
// shipped decided it by MESSAGE MEMBERSHIP (`result.errors` texts include this step's
// message), which the cold review at `d1d6fff` broke by catching a genuine
// `toHaveURL` failure and rethrowing `new Error(caught.message)`: the caught,
// non-terminal step was marked terminal.
//
// `HISTORICAL_MESSAGE_MEMBERSHIP` below is that exact predecessor, kept as a committed
// adversarial baseline and asserted to ACCEPT the forgery the current rule rejects. If
// anyone reverts toward comparing message text, these tests name what was lost.
//
// Every fixture here mirrors shapes MEASURED against the installed Playwright 1.61.1
// with a real Chromium `toHaveURL` failure:
//
//   genuine failure          step.location == step.error.location == test error location,
//                            stacks byte-equal
//   `new Error(msg)` rethrow same message, DIFFERENT stack, test error located at the
//                            THROW site
//   `expect.poll` noise      transient attempt steps carry NO stack and NO location
//   stack-copy rethrow       fully congruent — which is why the audit mark exists

import type { TestError, TestStep } from "@playwright/test/reporter";
import { describe, expect, it } from "vitest";
import {
  ABORT_CONTROL_SENTINEL,
  auditTerminalExpect,
  describeTestResult,
  guardTerminalExpect,
  isTerminalExpectStep,
  sameLocation,
  TERMINAL_EXPECT_AUDIT,
  throwSiteIdentity,
  type ReportedResultInput,
} from "./abort-control-reporter";

const SPEC = "/repo/web/e2e/optimize-assembled-stream.spec.ts";
const TITLE = "abort propagation: browser disconnect cancels upstream SSE body";
const STEP_TITLE = 'Expect "toHaveURL"';

/** The genuine matcher text Playwright produces, captured from real 1.61.1 output. */
const MATCHER_MESSAGE =
  "expect(page).toHaveURL(expected) failed\n\n" +
  "Expected pattern: /\\/about$/\n" +
  'Received string:  "http://localhost:51236/optimize-durable-fixture"\n' +
  "Timeout: 30000ms";

const at = (line: number, column: number) => ({ file: SPEC, line, column });

/** A stack as Playwright serializes it: the message, then the frames it was thrown at. */
const stackAt = (line: number, column: number, message = MATCHER_MESSAGE): string =>
  `Error: ${message}\n    at ${SPEC}:${line}:${column}`;

/** One serialized error, located exactly where it was thrown. */
function error(line: number, column: number, message = MATCHER_MESSAGE): TestError {
  return {
    message,
    stack: stackAt(line, column, message),
    location: at(line, column),
  };
}

/** A failing `expect` step whose error was thrown at its own location — the genuine shape. */
function expectStep(line: number, column: number, message = MATCHER_MESSAGE): TestStep {
  return {
    title: STEP_TITLE,
    category: "expect",
    location: at(line, column),
    error: error(line, column, message),
    steps: [],
    duration: 1,
    startTime: new Date(0),
    annotations: [],
    attachments: [],
    titlePath: () => [STEP_TITLE],
  } as unknown as TestStep;
}

/**
 * An `expect.poll` transient attempt, exactly as measured: an errored expect step with
 * NO stack and NO location, because no throw site is attributable to it.
 */
function pollNoiseStep(): TestStep {
  return {
    title: 'Expect "not toBeNull"',
    category: "expect",
    location: undefined,
    error: {
      message: "Error: expect(received).not.toBeNull()\n\nReceived: null",
    },
    steps: [],
    duration: 1,
    startTime: new Date(0),
    annotations: [],
    attachments: [],
    titlePath: () => [],
  } as unknown as TestStep;
}

function result(over: Partial<ReportedResultInput> = {}): ReportedResultInput {
  return {
    status: "failed",
    errors: [],
    steps: [],
    stdout: [`${ABORT_CONTROL_SENTINEL}\n`],
    annotations: [{ type: TERMINAL_EXPECT_AUDIT }],
    ...over,
  };
}

const reportOf = (over: Partial<ReportedResultInput> = {}) =>
  describeTestResult({ title: TITLE, location: { file: SPEC } }, result(over));

/**
 * THE EXACT PREDECESSOR. Terminality by membership of this step's message in the
 * test-level error texts — no stack, no location, no object identity.
 */
function HISTORICAL_MESSAGE_MEMBERSHIP(step: TestStep, testErrors: readonly TestError[]): boolean {
  return testErrors.map((e) => e.message ?? "").includes(step.error?.message ?? "");
}

describe("isTerminalExpectStep binds a step to the error that ENDED the test", () => {
  // The genuine shape: one matcher ran, failed, and its error propagated out. Step
  // location, step error location and the test-level error location are the same site,
  // and the stacks are byte-equal, because there is only ONE error object.
  it("marks a genuine propagated matcher failure terminal", () => {
    const step = expectStep(1008, 11);
    expect(isTerminalExpectStep(step, [error(1008, 11)])).toBe(true);
  });

  // THE FORGERY THE REVIEW MEASURED. `catch (e) { throw new Error(e.message) }`: the
  // message is byte-identical, but the stack and location are the rethrow's own.
  it("refuses a caught matcher whose MESSAGE was rethrown from another line", () => {
    const step = expectStep(1008, 11);
    const rethrown = error(1010, 5);
    expect(rethrown.message).toBe(step.error?.message);
    expect(isTerminalExpectStep(step, [rethrown])).toBe(false);
    // ...and the predecessor accepted exactly this, which is why the rule changed.
    expect(HISTORICAL_MESSAGE_MEMBERSHIP(step, [rethrown])).toBe(true);
  });

  // Same line, different column — a rethrow squeezed onto the assertion's own line
  // still has its own throw site.
  it("refuses a rethrow on the same LINE at a different column", () => {
    expect(isTerminalExpectStep(expectStep(1008, 11), [error(1008, 40)])).toBe(false);
  });

  // RETRY NOISE IS NOT FAILURE, and it is also not attributable: no stack, no location.
  it("never marks an expect.poll transient attempt terminal", () => {
    const noise = pollNoiseStep();
    expect(isTerminalExpectStep(noise, [error(1008, 11)])).toBe(false);
    // Not even against a test-level error carrying the poll's own text.
    expect(
      isTerminalExpectStep(noise, [
        {
          message: noise.error?.message,
          stack: undefined,
          location: undefined,
        },
      ]),
    ).toBe(false);
  });

  it("refuses a step whose error was thrown somewhere other than the step's own site", () => {
    const detached = {
      ...expectStep(1008, 11),
      location: at(1008, 12),
    } as unknown as TestStep;
    expect(isTerminalExpectStep(detached, [error(1008, 11)])).toBe(false);
  });

  // AMBIGUITY IS A REJECTION. Two congruent test-level errors mean the report cannot
  // say which one this step's failure was.
  it("refuses when two test-level errors are congruent with the step", () => {
    const step = expectStep(1008, 11);
    expect(isTerminalExpectStep(step, [error(1008, 11), error(1008, 11)])).toBe(false);
  });

  it("refuses when there is no test-level error at all", () => {
    expect(isTerminalExpectStep(expectStep(1008, 11), [])).toBe(false);
  });

  it.each([
    ["no stack", { message: MATCHER_MESSAGE, location: at(1008, 11) }],
    ["no location", { message: MATCHER_MESSAGE, stack: stackAt(1008, 11) }],
    ["no message", { stack: stackAt(1008, 11), location: at(1008, 11) }],
  ])("refuses a test-level error with %s", (_label, testError) => {
    expect(isTerminalExpectStep(expectStep(1008, 11), [testError as TestError])).toBe(false);
  });

  it("pins the throw-site identity it is built from", () => {
    expect(throwSiteIdentity(error(1008, 11))).toEqual({
      message: MATCHER_MESSAGE,
      stack: stackAt(1008, 11),
      location: at(1008, 11),
    });
    expect(throwSiteIdentity(undefined)).toBeNull();
    expect(throwSiteIdentity({ message: "x" })).toBeNull();
  });

  it("treats an absent location as matching nothing, including another absence", () => {
    expect(sameLocation(undefined, undefined)).toBe(false);
    expect(sameLocation(at(1, 1), undefined)).toBe(false);
    expect(sameLocation(at(1, 1), at(1, 1))).toBe(true);
    expect(sameLocation(at(1, 1), at(1, 2))).toBe(false);
  });
});

describe("describeTestResult reports the whole record the classifier reads", () => {
  it("reports the genuine control failure, terminal and audited", () => {
    const step = expectStep(1008, 11);
    const report = reportOf({ errors: [error(1008, 11)], steps: [step] });
    expect(report).toEqual({
      title: TITLE,
      file: SPEC,
      status: "failed",
      timedOut: false,
      errorCount: 1,
      expectStepCount: 1,
      sawSentinel: true,
      terminalExpectAudit: 1,
      failedExpectSteps: [
        {
          title: STEP_TITLE,
          file: SPEC,
          line: 1008,
          column: 11,
          message: MATCHER_MESSAGE,
          terminal: true,
        },
      ],
    });
  });

  // The measured live shape: poll retries around the genuine failure. Exactly ONE
  // terminal step, so the transient attempts are context and cannot move a verdict.
  it("carries poll retry noise as context with exactly one terminal step", () => {
    const report = reportOf({
      errors: [error(1008, 11)],
      steps: [pollNoiseStep(), pollNoiseStep(), expectStep(1008, 11)],
    });
    expect(report.expectStepCount).toBe(3);
    expect(report.failedExpectSteps.map((s) => s.terminal)).toEqual([false, false, true]);
  });

  it("marks nothing terminal when the matcher's message was rethrown", () => {
    const report = reportOf({
      errors: [error(1010, 5)],
      steps: [expectStep(1008, 11)],
    });
    expect(report.errorCount).toBe(1);
    expect(report.failedExpectSteps.map((s) => s.terminal)).toEqual([false]);
  });

  // CROSS-STEP: a sibling assertion failing with the same text does not make the other
  // one terminal, because each carries its own site.
  it("keeps two same-message sibling steps distinct", () => {
    const report = reportOf({
      errors: [error(1008, 11)],
      steps: [expectStep(1008, 11), expectStep(1042, 11)],
    });
    expect(report.failedExpectSteps.map((s) => [s.line, s.terminal])).toEqual([
      [1008, true],
      [1042, false],
    ]);
  });

  it("finds failing expect steps nested inside other steps", () => {
    const parent = {
      title: "attempt 1",
      category: "test.step",
      steps: [expectStep(1008, 11)],
      duration: 1,
      startTime: new Date(0),
      annotations: [],
      attachments: [],
      titlePath: () => [],
    } as unknown as TestStep;
    const report = reportOf({ errors: [error(1008, 11)], steps: [parent] });
    expect(report.expectStepCount).toBe(1);
    expect(report.failedExpectSteps.map((s) => s.terminal)).toEqual([true]);
  });

  it("reports Playwright's structural timeout signal, not a text match", () => {
    expect(reportOf({ status: "timedOut" }).timedOut).toBe(true);
    expect(reportOf({ status: "failed" }).timedOut).toBe(false);
  });

  it("binds the sentinel to THIS test's own stdout", () => {
    expect(reportOf({ stdout: [] }).sawSentinel).toBe(false);
    expect(reportOf({ stdout: [Buffer.from(`${ABORT_CONTROL_SENTINEL}\n`)] }).sawSentinel).toBe(
      true,
    );
  });

  it("counts only the audit annotation type, and counts every one of them", () => {
    expect(reportOf({ annotations: [] }).terminalExpectAudit).toBe(0);
    expect(reportOf({ annotations: [{ type: "skip" }] }).terminalExpectAudit).toBe(0);
    expect(
      reportOf({
        annotations: [{ type: TERMINAL_EXPECT_AUDIT }, { type: TERMINAL_EXPECT_AUDIT }],
      }).terminalExpectAudit,
    ).toBe(2);
  });

  it("strips ANSI from the step message it hands the classifier", () => {
    const coloured = expectStep(1008, 11, `[2mexpect[22m failed`);
    expect(reportOf({ errors: [], steps: [coloured] }).failedExpectSteps[0].message).toBe(
      "expect failed",
    );
  });
});

// The layer throw-site congruence cannot reach: a spec that rebuilds the error object
// byte-for-byte (`e.stack = caught.stack`) IS congruent — measured against 1.61.1. Object
// identity is not reproducible by rethrowing text, so the guard/audit pair closes it.
describe("the audit mark witnesses the guarded matcher's OWN error object", () => {
  const sink = () => ({
    annotations: [] as Array<{ type: string; description?: string }>,
  });
  const failingMatcher = () => {
    throw new Error(MATCHER_MESSAGE);
  };

  it("passes a guarded matcher's value through untouched when it succeeds", async () => {
    const marks = sink();
    await auditTerminalExpect(marks, async () => {
      expect(await guardTerminalExpect(() => "ok")).toBe("ok");
    });
    expect(marks.annotations).toEqual([]);
  });

  it("annotates when the guarded matcher's own error escapes the body", async () => {
    const marks = sink();
    await expect(
      auditTerminalExpect(marks, async () => {
        await guardTerminalExpect(failingMatcher);
      }),
    ).rejects.toThrow(MATCHER_MESSAGE);
    expect(marks.annotations).toEqual([
      { type: TERMINAL_EXPECT_AUDIT, description: expect.any(String) },
    ]);
  });

  it("does NOT annotate a same-message rethrow", async () => {
    const marks = sink();
    await expect(
      auditTerminalExpect(marks, async () => {
        try {
          await guardTerminalExpect(failingMatcher);
        } catch (caught) {
          throw new Error((caught as Error).message);
        }
      }),
    ).rejects.toThrow(MATCHER_MESSAGE);
    expect(marks.annotations).toEqual([]);
  });

  // The strongest forgery available to a spec: message AND stack copied verbatim, so
  // every reporter-visible field is congruent. Object identity still says no.
  it("does NOT annotate a byte-identical reconstruction with a copied stack", async () => {
    const marks = sink();
    await expect(
      auditTerminalExpect(marks, async () => {
        try {
          await guardTerminalExpect(failingMatcher);
        } catch (caught) {
          const forged = new Error((caught as Error).message);
          forged.stack = (caught as Error).stack;
          throw forged;
        }
      }),
    ).rejects.toThrow(MATCHER_MESSAGE);
    expect(marks.annotations).toEqual([]);
  });

  it("does NOT annotate a failure that never went through the guard", async () => {
    const marks = sink();
    await expect(
      auditTerminalExpect(marks, async () => {
        failingMatcher();
      }),
    ).rejects.toThrow(MATCHER_MESSAGE);
    expect(marks.annotations).toEqual([]);
  });

  // A guarded failure the spec SWALLOWS ends nothing, so there is no mark either.
  it("does NOT annotate a guarded failure that was swallowed", async () => {
    const marks = sink();
    await auditTerminalExpect(marks, async () => {
      try {
        await guardTerminalExpect(failingMatcher);
      } catch {
        /* swallowed: the test continues and passes */
      }
    });
    expect(marks.annotations).toEqual([]);
  });

  // A thrown non-object cannot be tracked by identity, so it can never be marked.
  it("does NOT annotate a thrown non-object", async () => {
    const marks = sink();
    await expect(
      auditTerminalExpect(marks, async () => {
        await guardTerminalExpect(() => {
          throw "a bare string";
        });
      }),
    ).rejects.toBe("a bare string");
    expect(marks.annotations).toEqual([]);
  });

  // Every layer at once, on the exact shapes the control can produce.
  it("composes: only the genuine failure is both terminal and audited", async () => {
    const genuine = reportOf({
      errors: [error(1008, 11)],
      steps: [expectStep(1008, 11)],
    });
    expect([genuine.failedExpectSteps[0].terminal, genuine.terminalExpectAudit]).toEqual([true, 1]);

    const rethrown = reportOf({
      errors: [error(1010, 5)],
      steps: [expectStep(1008, 11)],
      annotations: [],
    });
    expect([rethrown.failedExpectSteps[0].terminal, rethrown.terminalExpectAudit]).toEqual([
      false,
      0,
    ]);

    // Congruent but unaudited — the copied-stack reconstruction. Terminality alone would
    // pass it; the audit count is what fails it.
    const copied = reportOf({
      errors: [error(1008, 11)],
      steps: [expectStep(1008, 11)],
      annotations: [],
    });
    expect([copied.failedExpectSteps[0].terminal, copied.terminalExpectAudit]).toEqual([true, 0]);
  });
});
