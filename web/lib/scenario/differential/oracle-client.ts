// Bounded subprocess client for the differential oracle (ii7.10.7).
//
// Both differential suites drive `oracle.py` as a one-shot child: write one JSON
// request to stdin, read one JSON response from stdout. That shape is kept — a
// long-lived oracle session would be a new protocol, and the measured cost does
// not justify one (see the budget notes below). What was missing was any BOUND on
// the child and any diagnostic when one misbehaves:
//
//   * `spawnSync` blocks the worker thread, so while a child runs Vitest's own
//     test timer cannot fire. Without a child `timeout` a wedged oracle is
//     un-interruptible; Vitest reports "Test timed out in 5000ms" only once the
//     child finally returns, and names nothing useful.
//   * A test's real cost is (oracle calls) x (per-call cost). Vitest's IMPLICIT
//     5s default is not a measured budget for that, so tests fell over the edge
//     as call counts and machine load varied — the eight-call date-resolution
//     case needs ~5.5s idle on a warm cache alone.
//
// This module gives every child a real killable timeout, classifies every way a
// child can fail, and exposes `oracleBudget()` so each test declares a LOCAL
// timeout derived from its own call count. Vitest's global `testTimeout` is left
// at its default.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect } from "vitest";

import { PROJECT_PYTHON } from "@/lib/python";

export const ORACLE = resolve(dirname(fileURLToPath(import.meta.url)), "oracle.py");

// Resolved by `@/lib/python`: an explicit `PYTHON` env override is honored when
// set (the differential self-tests substitute a Node child for the harness
// coverage, but a real venv / wrapper script is the contractually supported
// override path). With no override, the project mise pin is used so callers
// outside an activated `mise exec` shell — e.g. a plain `pnpm test:differential`
// — do not silently pick up a too-old or too-thin system Python.
export const PYTHON = PROJECT_PYTHON;

/** The differential suites are opt-in: `pnpm test:differential` sets this, so the
 *  default `pnpm test` never shells out to Python. */
export const GATED = !!process.env.RUN_DIFFERENTIAL;

// --- Measured budgets --------------------------------------------------------
//
// All figures below were measured on this repository's oracle under Python
// 3.12.13 with the declared `core/requirements.txt` dependencies installed
// (ortools, pandas, openpyxl, pydantic, ruamel.yaml, fastapi):
//
//   idle, warm bytecode cache      380-880ms  per call (all ops, incl. `export`)
//   10 concurrent children         833-1829ms per call
//   20 concurrent children on 10   2109-5284ms per call  <- worst healthy child
//     cores, cold bytecode cache
//
// The two semantic suites issue 76 Python children across their 59 cases: 39 in
// `differential.test.ts` and 37 in `workspace-differential.test.ts` (each total
// includes its module probe). The full 67-test differential command issues 79:
// the harness self-tests own three additional real-backend calls.

/** Hard bound on one oracle child. ~5.7x the worst healthy child ever measured
 *  (5,284ms at 2x CPU oversubscription with a cold bytecode cache), so only a
 *  genuinely wedged oracle trips it — but it DOES trip, which is the point:
 *  `spawnSync` blocks the JS thread, so this is the only timer that can actually
 *  terminate a stuck child. `describeChildFailure` then names the case. */
export const ORACLE_CHILD_TIMEOUT_MS = 30_000;

/** Per-call unit for `oracleBudget`: the worst healthy child measured above
 *  (5,284ms), rounded up. */
const ORACLE_CALL_BUDGET_MS = 6_000;

/** Fixed per-test headroom for the TypeScript half — serialize/validate, the
 *  import normalizer, and the fake-indexeddb store transactions. Measured at
 *  <=150ms idle across every case; 4s absorbs fork scheduling jitter under load. */
const ORACLE_TEST_OVERHEAD_MS = 4_000;

/**
 * The LOCAL timeout for a test that makes `calls` oracle calls. Passed as each
 * `it()`'s own third argument — never as a global `testTimeout`.
 *
 * Being generous here is safe rather than cosmetic: `ORACLE_CHILD_TIMEOUT_MS`
 * guarantees every call returns, so this timer always gets the chance to fire.
 * It bounds accumulated healthy work; the child timeout bounds a hang.
 */
export function oracleBudget(calls: number): number {
  return calls * ORACLE_CALL_BUDGET_MS + ORACLE_TEST_OVERHEAD_MS;
}

// --- Child failure classification -------------------------------------------

/** Every non-semantic way an oracle child can fail. A scenario-level rejection is
 *  NOT in this union: `oracle.py` exits 0 and returns `{ok: false, error}` for
 *  those, so a semantic mismatch can never be confused with a broken harness. */
export type OracleFailureKind =
  | "timeout" // child exceeded its killable budget (ETIMEDOUT)
  | "spawn-error" // could not start
  | "signal" // killed by a signal
  | "exit-status" // exited non-zero (the oracle only ever exits 0 or 2)
  | "malformed-output"; // exited 0 but stdout was not one JSON object

export interface OracleFailure {
  kind: OracleFailureKind;
  message: string;
}

/** Names the offending call in every diagnostic: the op, the caller's case label
 *  when the op alone is ambiguous, and the Vitest test that issued it. The
 *  availability probe runs at module scope, where there is no current test. */
export function oracleLabel(request: object, caseLabel?: string): string {
  const op = (request as { op?: unknown }).op;
  const test = expect.getState().currentTestName ?? "module scope (availability probe)";
  const scoped = caseLabel === undefined ? "" : ` case=${JSON.stringify(caseLabel)}`;
  return `op=${JSON.stringify(op)}${scoped} test=${JSON.stringify(test)}`;
}

/**
 * Classify a completed `spawnSync` result, or `null` when the child terminated
 * healthily (exit 0). Fail-closed and diagnostic: each branch names the case, so
 * a stuck or broken oracle can never surface as a bare Vitest timeout.
 *
 * `oracle.py` exits 0 for every scenario-level outcome (rejections are data) and
 * 2 only for an unknown op, so any non-zero status here is a harness break.
 */
export function describeChildFailure(
  result: SpawnSyncReturns<string>,
  label: string,
): OracleFailure | null {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? result.error.message;
    // `timeout` firing sets BOTH `error.code === "ETIMEDOUT"` and the signal that
    // terminated the child. Detect it before the generic spawn-error branch so a
    // wedged backend cannot be confused with an interpreter launch failure.
    if (code === "ETIMEDOUT") {
      return {
        kind: "timeout",
        message:
          `oracle child timed out (${code}) and was terminated by signal ` +
          `${result.signal ?? "unknown"} for ${label}`,
      };
    }
    return { kind: "spawn-error", message: `oracle child error (${code}) for ${label}` };
  }
  if (result.signal !== null) {
    return {
      kind: "signal",
      message: `oracle child killed by signal ${result.signal} for ${label}`,
    };
  }
  if (result.status !== 0) {
    return {
      kind: "exit-status",
      message:
        `oracle child exited with unexpected status ${result.status} for ${label}: ` +
        `${result.stderr || result.stdout}`,
    };
  }
  return null;
}

// --- Child invocation --------------------------------------------------------

export interface OracleChildOverride {
  /** Replaces the interpreter argv. TEST-ONLY: the harness self-tests substitute a
   *  child that hangs, crashes, or babbles, so this module's own budget and
   *  diagnostics are exercised through the exact path real calls take. */
  argv?: readonly string[];
  /** Replaces `ORACLE_CHILD_TIMEOUT_MS`. TEST-ONLY: keeps the blocked-child proof
   *  fast without weakening the budget real calls run under. */
  timeoutMs?: number;
}

/** Spawn one oracle child under its budget. Returns the raw result — unclassified,
 *  so the self-tests can assert on `error`/`signal`/`status` directly. */
export function runOracleChild(
  input: string,
  override: OracleChildOverride = {},
): SpawnSyncReturns<string> {
  const [command, ...args] = override.argv ?? [PYTHON, ORACLE];
  return spawnSync(command, args, {
    input,
    encoding: "utf-8",
    timeout: override.timeoutMs ?? ORACLE_CHILD_TIMEOUT_MS,
  });
}

/**
 * Drive one oracle call to completion.
 *
 * Throws a case-naming diagnostic for every harness-level failure (see
 * `OracleFailureKind`). Returns the parsed response otherwise — INCLUDING
 * `{ok: false}` scenario rejections, which are data the callers assert on.
 */
export function callOracleRaw<T>(
  request: object,
  caseLabel?: string,
  override: OracleChildOverride = {},
): T {
  const label = oracleLabel(request, caseLabel);
  const result = runOracleChild(JSON.stringify(request), override);
  const failure = describeChildFailure(result, label);
  if (failure) {
    throw new Error(failure.message);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `oracle child produced unparseable stdout for ${label}: ${JSON.stringify(result.stdout.slice(0, 400))}`,
    );
  }
}

/** The `malformed-output` classification, exposed for the self-tests: `JSON.parse`
 *  failure is raised inside `callOracleRaw` rather than by `describeChildFailure`,
 *  because it needs the successfully-captured stdout. */
export const MALFORMED_OUTPUT_MARKER = "produced unparseable stdout";

// --- Availability probe ------------------------------------------------------

export type BackendProbe = { available: true } | { available: false; reason: string };

/**
 * One bounded probe call deciding whether the vendored Python backend is
 * reachable. Fail-closed is preserved exactly: an unreachable backend leaves the
 * suites' availability assertion to fail the whole command rather than skipping
 * green. The difference is that the REASON now survives, instead of being
 * swallowed by a bare `catch`.
 *
 * This is also where the cold bytecode/page cache is paid: it runs during module
 * collection, so the first real test does not absorb a ~10s cold import.
 */
export function probeBackend(request: object): BackendProbe {
  if (!GATED) return { available: false, reason: "RUN_DIFFERENTIAL is not set" };
  try {
    const res = callOracleRaw<{ ok?: boolean; error?: string }>(request, "availability probe");
    if (res.ok === true) return { available: true };
    return {
      available: false,
      reason: `backend rejected the availability probe: ${res.error ?? JSON.stringify(res)}`,
    };
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
}

/** The `expect` message for the fail-closed availability assertion — names why the
 *  backend was unreachable instead of just asserting `false === true`. */
export function probeFailureReason(probe: BackendProbe): string {
  return probe.available ? "backend available" : probe.reason;
}
