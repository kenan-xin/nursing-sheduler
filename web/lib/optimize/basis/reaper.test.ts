// T08 — the local reaper. The ORDER of the plan is the correctness property, so
// these assert on the emitted sequence, not merely on which rows survive.

import { describe, expect, it } from "vitest";
import type { OptimizeBasisRecordV2 } from "./basis-row";
import { mayRetainPayload, planReap } from "./reaper";

const NOW = new Date("2026-07-20T12:00:00Z");
const FUTURE = "2026-07-21T00:00:00Z";
const PAST = "2026-07-20T00:00:00Z";

function row(over: Partial<OptimizeBasisRecordV2> & { basisId: string }): OptimizeBasisRecordV2 {
  return {
    schemaVersion: 2,
    scenarioId: "scenario-1",
    documentRevision: 1,
    submissionDigest: "a".repeat(64),
    basis: {
      schemaVersion: 2,
      submissionContractVersion: "optimize-yaml-v1",
      workspaceSchemaVersion: "1",
      serializerVersion: "canonical-strict-yaml-v1",
      anonymizationMode: "none",
      inputSha256: "a".repeat(64),
      normalizedOptions: { solver: "ortools/cp-sat", prettify: false, timeoutSeconds: 300 },
      solverSemanticVersion: "ortools/cp-sat@1",
      backendCapabilityVersion: "nurse-scheduling-backend@1",
    },
    ownerKind: "ordinary",
    attemptId: "attempt",
    jobId: "job",
    parentBasisId: null,
    transformDigest: null,
    submittedYaml: "workspaceVersion: 1\n",
    createdAt: PAST,
    expiresAt: FUTURE,
    ...over,
  };
}

const NONE: ReadonlySet<string> = new Set();

describe("planReap", () => {
  it("deletes an expired child before its expired parent", () => {
    const actions = planReap({
      rows: [
        row({ basisId: "parent", expiresAt: PAST, submittedYaml: null }),
        row({
          basisId: "child",
          ownerKind: "candidate",
          parentBasisId: "parent",
          transformDigest: "t",
          expiresAt: PAST,
          submittedYaml: null,
        }),
      ],
      referencedBasisIds: NONE,
      now: NOW,
    });
    expect(actions).toEqual([
      { kind: "delete-row", basisId: "child", reason: "expired" },
      { kind: "delete-row", basisId: "parent", reason: "expired" },
    ]);
  });

  it("never deletes the ordinary parent because a candidate expired", () => {
    const actions = planReap({
      rows: [
        row({ basisId: "parent", submittedYaml: null }),
        row({
          basisId: "child",
          ownerKind: "candidate",
          parentBasisId: "parent",
          transformDigest: "t",
          expiresAt: PAST,
          submittedYaml: null,
        }),
      ],
      referencedBasisIds: new Set(["parent"]),
      now: NOW,
    });
    expect(actions).toEqual([{ kind: "delete-row", basisId: "child", reason: "expired" }]);
  });

  it("defers an expired parent while a live child still references it", () => {
    const actions = planReap({
      rows: [
        row({ basisId: "parent", expiresAt: PAST, submittedYaml: null }),
        row({
          basisId: "child",
          ownerKind: "candidate",
          parentBasisId: "parent",
          transformDigest: "t",
          submittedYaml: null,
        }),
      ],
      referencedBasisIds: new Set(["child"]),
      now: NOW,
    });
    // The parent survives THIS pass so the live child is never orphaned mid-plan.
    expect(actions).toEqual([]);
  });

  it("removes a child whose parent row is already gone", () => {
    const actions = planReap({
      rows: [
        row({
          basisId: "child",
          ownerKind: "candidate",
          parentBasisId: "vanished",
          transformDigest: "t",
          submittedYaml: null,
        }),
      ],
      referencedBasisIds: new Set(["child"]),
      now: NOW,
    });
    // Even though it is referenced and unexpired: it can never be interpreted again.
    expect(actions).toEqual([{ kind: "delete-row", basisId: "child", reason: "orphaned-child" }]);
  });

  it("clears raw payload before any row is deleted", () => {
    const actions = planReap({
      rows: [
        row({ basisId: "keep" }),
        row({ basisId: "gone", expiresAt: PAST, submittedYaml: null }),
      ],
      referencedBasisIds: NONE,
      now: NOW,
    });
    expect(actions[0]).toEqual({
      kind: "clear-payload",
      basisId: "keep",
      reason: "unreferenced",
    });
    expect(actions[1]).toEqual({ kind: "delete-row", basisId: "gone", reason: "expired" });
  });

  it("keeps the raw payload of a referenced, unexpired row", () => {
    const actions = planReap({
      rows: [row({ basisId: "live" })],
      referencedBasisIds: new Set(["live"]),
      now: NOW,
    });
    expect(actions).toEqual([]);
  });

  it("does not re-clear a payload that is already gone", () => {
    const actions = planReap({
      rows: [row({ basisId: "bare", submittedYaml: null })],
      referencedBasisIds: NONE,
      now: NOW,
    });
    expect(actions).toEqual([]);
  });

  it("treats an absent or unparseable expiry as expired, never as retain-forever", () => {
    for (const expiresAt of [null, "nonsense"]) {
      const actions = planReap({
        rows: [row({ basisId: "x", expiresAt, submittedYaml: null })],
        referencedBasisIds: new Set(["x"]),
        now: NOW,
      });
      expect(actions).toEqual([{ kind: "delete-row", basisId: "x", reason: "expired" }]);
    }
  });

  it("leaves rows belonging to another scenario untouched", () => {
    // Foreign-reference safety: reaping is driven by expiry and ownership, never by
    // which scenario happens to be open.
    const actions = planReap({
      rows: [row({ basisId: "other", scenarioId: "scenario-2", submittedYaml: null })],
      referencedBasisIds: new Set(["other"]),
      now: NOW,
    });
    expect(actions).toEqual([]);
  });
});

describe("mayRetainPayload", () => {
  it("allows a referenced, unexpired payload", () => {
    expect(mayRetainPayload(row({ basisId: "a" }), new Set(["a"]), NOW)).toBe(true);
  });

  it("refuses an unreferenced payload", () => {
    expect(mayRetainPayload(row({ basisId: "a" }), NONE, NOW)).toBe(false);
  });

  it("refuses past the advertised expiry even while actively referenced", () => {
    // A long-lived Preview must not extend the life of evidence the server released.
    expect(mayRetainPayload(row({ basisId: "a", expiresAt: PAST }), new Set(["a"]), NOW)).toBe(
      false,
    );
  });
});
