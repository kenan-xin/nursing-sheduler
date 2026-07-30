// Self-tests for the differential oracle's subprocess budget (ii7.10.7).
//
// These prove the harness's OWN failure handling, which the 59 semantic cases
// cannot: that a wedged child is actually terminated by its own budget rather
// than by Vitest's outer timer, and that every non-semantic child failure is
// classified distinctly from a scenario-level rejection.
//
// The misbehaving children are NODE processes, not Python ones. Nothing here is
// testing Python — it is testing this module's spawn budget and classification —
// and a Node child keeps these cases independent of `PYTHON`, which may point at
// a venv or a wrapper script whose own exit code would mask a child's signal.
// That also lets them run ungated, so the budget stays protected under the
// default `pnpm test` while still never shelling out to Python there. Only the
// two cases that genuinely need the vendored backend are gated.

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  callOracleRaw,
  describeChildFailure,
  GATED,
  MALFORMED_OUTPUT_MARKER,
  ORACLE_CHILD_TIMEOUT_MS,
  oracleBudget,
  oracleLabel,
  probeBackend,
  probeFailureReason,
  runOracleChild,
} from "./oracle-client";

/** A request shape that is valid for the real oracle, so the substituted children
 *  below differ from a healthy call ONLY in how the child behaves. */
const PROBE_REQUEST = { op: "shift_map", items: ["D"], groups: [] };

// Full-command Python accounting, harness call 1/3: real availability controls
// the two backend-dependent checks below. The synthetic child checks stay Node.
const PROBE = probeBackend(PROBE_REQUEST);

/** argv for a Node child running `script`. */
function nodeChild(script: string): readonly string[] {
  return [process.execPath, "-e", script];
}

/** Drives the real `callOracleRaw` path against a substituted misbehaving child. */
function callWithChild(script: string, caseLabel: string, timeoutMs?: number) {
  return callOracleRaw(PROBE_REQUEST, caseLabel, { argv: nodeChild(script), timeoutMs });
}

describe("differential oracle harness — child budget", () => {
  it("terminates a blocked oracle child on its own budget and names the case", () => {
    // The exact failure mode the child budget exists for. `spawnSync` blocks
    // the JS thread, so while this child runs Vitest's timer is powerless —
    // only the child's own `timeout` can interrupt it. This asserts THAT
    // mechanism fired, not the outer timer: only `spawnSync`'s timeout produces
    // `error.code === "ETIMEDOUT"` with `signal === "SIGTERM"`. Had the outer
    // timer fired instead, the test would have failed before reaching these
    // assertions. The local child budget stays far below the 30s sleep, so a
    // budget that is dropped or not forwarded FAILS this test rather than
    // hanging it — the test's own 5s timeout is the backstop.
    const CHILD_TIMEOUT_MS = 400;
    const BLOCK_FOREVER = "setTimeout(() => {}, 30_000)";
    const label = "blocked-oracle";
    const start = performance.now();
    const result = runOracleChild(JSON.stringify(PROBE_REQUEST), {
      argv: nodeChild(BLOCK_FOREVER),
      timeoutMs: CHILD_TIMEOUT_MS,
    });
    const elapsed = performance.now() - start;

    expect((result.error as NodeJS.ErrnoException | undefined)?.code ?? null).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
    // Measurable proof the child died near its budget, not after the sleep.
    expect(elapsed, `elapsed ${elapsed.toFixed(0)}ms`).toBeLessThan(CHILD_TIMEOUT_MS * 4);
    expect(elapsed).toBeLessThan(30_000);

    // The wedged child is classified distinctly from an interpreter spawn error.
    // Its diagnostic retains the timeout code, termination signal, op, case, and
    // test — none of which a bare Vitest timeout would report. Expecting the
    // distinct kind makes deleting or moving the timeout branch below the generic
    // error branch a failing mutation.
    const failure = describeChildFailure(result, oracleLabel(PROBE_REQUEST, label));
    expect(failure?.kind).toBe("timeout");
    expect(failure?.message).toContain("ETIMEDOUT");
    expect(failure?.message).toContain("SIGTERM");
    expect(failure?.message).toContain(label);
    expect(failure?.message).toContain("shift_map");
    expect(failure?.message).toContain("terminates a blocked oracle child");

    // The same budget reaches the real call path, which throws that diagnostic.
    expect(() => callWithChild(BLOCK_FOREVER, label, CHILD_TIMEOUT_MS)).toThrow(
      /timed out \(ETIMEDOUT\).*signal SIGTERM/,
    );
  }, 5_000);

  it("applies a finite default child budget above the worst measured healthy call", () => {
    // Guards the constant itself: a 0 or Infinity budget would silently restore
    // the un-interruptible behaviour this ticket fixed, and a budget below the
    // measured 5,284ms worst healthy child would kill honest work.
    expect(Number.isFinite(ORACLE_CHILD_TIMEOUT_MS)).toBe(true);
    expect(ORACLE_CHILD_TIMEOUT_MS).toBeGreaterThan(5_284);
    // Per-test budgets scale with call count and always exceed the child budget's
    // worst case for a single call.
    expect(oracleBudget(1)).toBeGreaterThan(oracleBudget(0));
    expect(oracleBudget(8) - oracleBudget(7)).toBe(oracleBudget(2) - oracleBudget(1));
    expect(oracleBudget(8)).toBeGreaterThan(8 * 5_284);
  });
});

describe("differential oracle harness — failure discrimination", () => {
  it("classifies a signal-killed child as a signal failure", () => {
    const script = "process.kill(process.pid, 'SIGKILL')";
    const result = runOracleChild(JSON.stringify(PROBE_REQUEST), { argv: nodeChild(script) });
    const failure = describeChildFailure(result, oracleLabel(PROBE_REQUEST, "signalled"));
    expect(failure?.kind).toBe("signal");
    expect(failure?.message).toContain("SIGKILL");
    expect(failure?.message).toContain("signalled");
    expect(() => callWithChild(script, "signalled")).toThrow(/killed by signal SIGKILL/);
  }, 10_000);

  it("classifies an unexpected non-zero exit as an exit-status failure and keeps stderr", () => {
    const script = "process.stderr.write('backend import exploded'); process.exit(3)";
    const result = runOracleChild(JSON.stringify(PROBE_REQUEST), { argv: nodeChild(script) });
    const failure = describeChildFailure(result, oracleLabel(PROBE_REQUEST, "exit-3"));
    expect(failure?.kind).toBe("exit-status");
    expect(failure?.message).toContain("status 3");
    expect(failure?.message).toContain("backend import exploded");
    expect(() => callWithChild(script, "exit-3")).toThrow(/unexpected status 3/);
  }, 10_000);

  it("classifies a clean exit with non-JSON stdout as malformed output", () => {
    // Exit 0 with unusable stdout is the one failure `describeChildFailure` cannot
    // see — it is caught at the parse boundary instead, and must still name the case
    // rather than surfacing a bare SyntaxError.
    const script = "console.log('Traceback (most recent call last): not json')";
    const result = runOracleChild(JSON.stringify(PROBE_REQUEST), { argv: nodeChild(script) });
    expect(result.status).toBe(0);
    expect(describeChildFailure(result, "unused")).toBeNull();
    let thrown: Error | null = null;
    try {
      callWithChild(script, "babbling");
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain(MALFORMED_OUTPUT_MARKER);
    expect(thrown?.message).toContain("babbling");
    expect(thrown?.message).toContain("not json");
  }, 10_000);

  it("classifies an unstartable interpreter as a spawn error", () => {
    const result = runOracleChild(JSON.stringify(PROBE_REQUEST), {
      argv: ["/nonexistent/interpreter-that-is-not-installed", "-e", "0"],
    });
    const failure = describeChildFailure(result, oracleLabel(PROBE_REQUEST, "missing-interpreter"));
    expect(failure?.kind).toBe("spawn-error");
    expect(failure?.message).toContain("ENOENT");
    expect(failure?.message).toContain("missing-interpreter");
  }, 10_000);
});

describe.skipIf(!GATED)("differential oracle harness — backend availability reporting", () => {
  it("reports an unavailable backend with its reason instead of swallowing it", () => {
    // Harness-owned Python call 2/3: verifies the real oracle's unknown-op exit
    // reaches the fail-closed availability diagnostic with status and reason.
    // Fail-closed reporting: `probeBackend` never throws, but the reason it saw
    // must survive so the suites' availability assertion can name it.
    const probe = probeBackend({ op: "definitely-not-an-op" });
    expect(probe.available).toBe(false);
    expect(probeFailureReason(probe)).toContain("unexpected status 2");
  }, 10_000);
});

describe.skipIf(!PROBE.available)(
  "differential oracle harness — semantic rejections are not harness failures",
  () => {
    it(
      "a scenario-level rejection returns as data, distinct from every child failure",
      () => {
        // Harness-owned Python call 3/3: only the real backend can prove its
        // semantic rejection exits 0 and remains data rather than a child error.
        // The load-bearing separation: `oracle.py` exits 0 for scenario rejections,
        // so a semantic mismatch must arrive as `{ok: false, error}` and NOT as a
        // thrown timeout / signal / exit-status / malformed-output diagnostic.
        const rejection = callOracleRaw<{ ok: boolean; error?: string; errorType?: string }>(
          { op: "shift_map", items: ["D"], groups: [{ id: "g", members: ["later"] }] },
          "forward-reference rejection",
        );
        expect(rejection.ok).toBe(false);
        expect(rejection.error).toBeTruthy();
        expect(rejection.errorType).toBeTruthy();
      },
      oracleBudget(1),
    );
  },
);
