// T08 — table-driven coverage of the closed product-outcome mapping, including
// values a FUTURE backend might introduce. Everything unrecognized must fail
// closed to `failed` / `unclassified_failure` and carry no evidence.

import { describe, expect, it } from "vitest";
import type { JobState, OptimizationOutcome } from "@/lib/bff/types";
import {
  isEvidenceBearing,
  mapJobToProductOutcome,
  notStarted,
  provesFeasible,
  UNCLASSIFIED_FAILURE,
  type OutcomeInput,
} from "./outcome-mapping";

function completed(
  outcome: OptimizationOutcome,
  termination_reason: string | null,
  score: number | null = null,
): OutcomeInput {
  return {
    state: "completed",
    terminal: true,
    result: { outcome, score, solver_status: "X", termination_reason },
    error: null,
  };
}

describe("mapJobToProductOutcome", () => {
  it.each(["queued", "running", "cancelling"] as JobState[])(
    "returns null for the live state %s rather than inventing an outcome",
    (state) => {
      expect(
        mapJobToProductOutcome({ state, terminal: false, result: null, error: null }),
      ).toBeNull();
    },
  );

  it("trusts the state enum over a contradictory terminal flag", () => {
    expect(
      mapJobToProductOutcome({ state: "running", terminal: true, result: null, error: null }),
    ).toBeNull();
  });

  it("maps cancellation with no evidence", () => {
    const view = mapJobToProductOutcome({
      state: "cancelled",
      terminal: true,
      result: null,
      error: { code: "cancelled", message: "Optimisation cancelled." },
    });
    expect(view).toEqual({ outcome: "cancelled", evidence: "none", reason: "cancelled" });
    expect(isEvidenceBearing(view!)).toBe(false);
  });

  it("keeps a failure's stable backend code", () => {
    const view = mapJobToProductOutcome({
      state: "failed",
      terminal: true,
      result: null,
      error: { code: "worker_lost", message: "gone" },
    });
    expect(view).toEqual({ outcome: "failed", evidence: "none", reason: "worker_lost" });
  });

  it("reports a failure with no code as unclassified rather than guessing", () => {
    expect(
      mapJobToProductOutcome({ state: "failed", terminal: true, result: null, error: null }),
    ).toEqual(UNCLASSIFIED_FAILURE);
  });

  it.each(["optimal", "feasible"] as OptimizationOutcome[])(
    "maps %s to tested-feasible with feasibility evidence",
    (outcome) => {
      const view = mapJobToProductOutcome(completed(outcome, "optimality_proven", 42))!;
      expect(view.outcome).toBe("tested-feasible");
      expect(provesFeasible(view)).toBe(true);
    },
  );

  it("keeps a timeout that RETURNED a schedule as feasible", () => {
    // Lack of optimality is not lack of feasibility — the schedule is real evidence.
    const view = mapJobToProductOutcome(completed("feasible", "solver_timeout", 7))!;
    expect(view).toEqual({
      outcome: "tested-feasible",
      evidence: "feasibility",
      reason: "solver_timeout",
    });
  });

  it("maps proven infeasibility to still-infeasible with infeasibility evidence", () => {
    expect(mapJobToProductOutcome(completed("infeasible", "infeasibility_proven"))).toEqual({
      outcome: "tested-still-infeasible",
      evidence: "infeasibility",
      reason: "infeasibility_proven",
    });
  });

  it.each(["solver_timeout_no_solution", "no_proof", "solver_unknown"])(
    "maps inconclusive/%s to no-proof evidence, preserving the reason",
    (reason) => {
      const view = mapJobToProductOutcome(completed("inconclusive", reason))!;
      expect(view).toEqual({ outcome: "inconclusive", evidence: "no-proof", reason });
      // No proof either way is still usable evidence — unlike a crash or a cancel.
      expect(isEvidenceBearing(view)).toBe(true);
      expect(provesFeasible(view)).toBe(false);
    },
  );

  it("never reports an inconclusive run as infeasible or failed", () => {
    const view = mapJobToProductOutcome(completed("inconclusive", "solver_timeout_no_solution"))!;
    expect(view.outcome).not.toBe("tested-still-infeasible");
    expect(view.outcome).not.toBe("failed");
  });

  it("fails closed on an inconclusive reason outside the closed set", () => {
    expect(mapJobToProductOutcome(completed("inconclusive", "some_future_reason"))).toEqual(
      UNCLASSIFIED_FAILURE,
    );
    expect(mapJobToProductOutcome(completed("inconclusive", null))).toEqual(UNCLASSIFIED_FAILURE);
  });

  it("fails closed on an outcome a future backend might add", () => {
    expect(
      mapJobToProductOutcome(completed("probably_feasible" as OptimizationOutcome, "x")),
    ).toEqual(UNCLASSIFIED_FAILURE);
  });

  it("fails closed on a state a future backend might add", () => {
    expect(
      mapJobToProductOutcome({
        state: "paused" as JobState,
        terminal: true,
        result: null,
        error: null,
      }),
    ).toBeNull();
  });

  it("treats a completed job with no result as a broken contract", () => {
    expect(
      mapJobToProductOutcome({ state: "completed", terminal: true, result: null, error: null }),
    ).toEqual(UNCLASSIFIED_FAILURE);
  });

  it("never yields evidence for any non-completed terminal state", () => {
    const cancelled = mapJobToProductOutcome({
      state: "cancelled",
      terminal: true,
      result: null,
      error: { code: "cancelled", message: "m" },
    })!;
    const failed = mapJobToProductOutcome({
      state: "failed",
      terminal: true,
      result: null,
      error: { code: "boom", message: "m" },
    })!;
    expect(isEvidenceBearing(cancelled)).toBe(false);
    expect(isEvidenceBearing(failed)).toBe(false);
  });
});

describe("notStarted", () => {
  it.each(["invalid_input", "diagnostic_capacity_reserved", "transport_rejected"] as const)(
    "carries no evidence for %s",
    (reason) => {
      const view = notStarted(reason);
      expect(view).toEqual({ outcome: "not-started", evidence: "none", reason });
      expect(isEvidenceBearing(view)).toBe(false);
    },
  );
});
