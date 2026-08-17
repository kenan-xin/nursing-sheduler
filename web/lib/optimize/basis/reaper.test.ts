// T08 — the local reaper. The ORDER of the plan is the correctness property, so
// these assert on the emitted sequence, not merely on which rows survive.

import { describe, expect, it } from "vitest";
import type { OptimizeBasisRecordV1, OptimizeBasisRecordV2 } from "./basis-row";
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

/**
 * A pre-T08 row, exactly as a shipped build wrote it: no `ownerKind`, no `basis`,
 * no `submittedYaml`. The reaper used to partition solely on `ownerKind`, so this
 * shape matched neither candidates nor ordinaries and was retained forever.
 */
function legacyRow(
  over: Partial<OptimizeBasisRecordV1> & { basisId: string },
): OptimizeBasisRecordV1 {
  return {
    schemaVersion: 1,
    scenarioId: "scenario-1",
    documentRevision: 7,
    submissionDigest: "a".repeat(64),
    semanticBasisDigest: "sha256:legacy-semantic-basis",
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

describe("planReap under the legacy retention policy (C2F3)", () => {
  it("deletes an expired legacy row instead of ignoring it forever", () => {
    const actions = planReap({
      rows: [legacyRow({ basisId: "legacy", expiresAt: PAST })],
      referencedBasisIds: NONE,
      now: NOW,
    });
    expect(actions).toEqual([{ kind: "delete-row", basisId: "legacy", reason: "legacy-expired" }]);
  });

  it("deletes an expired legacy row even while it is actively referenced", () => {
    // Same rule as a V2 row: a reference protects raw material, never lifetime.
    const actions = planReap({
      rows: [legacyRow({ basisId: "legacy", expiresAt: PAST })],
      referencedBasisIds: new Set(["legacy"]),
      now: NOW,
    });
    expect(actions).toEqual([{ kind: "delete-row", basisId: "legacy", reason: "legacy-expired" }]);
  });

  it("treats an absent or unparseable legacy expiry as expired", () => {
    for (const expiresAt of [null, "nonsense"]) {
      const actions = planReap({
        rows: [legacyRow({ basisId: "legacy", expiresAt })],
        referencedBasisIds: NONE,
        now: NOW,
      });
      expect(actions).toEqual([
        { kind: "delete-row", basisId: "legacy", reason: "legacy-expired" },
      ]);
    }
  });

  it("keeps an unexpired legacy row's compact identity and plans nothing", () => {
    const actions = planReap({
      rows: [legacyRow({ basisId: "legacy" })],
      referencedBasisIds: NONE,
      now: NOW,
    });
    // Nothing to compact and nothing expired: retention is honoured, not guessed.
    expect(actions).toEqual([]);
  });

  it("compacts an unexpired legacy row that holds raw material, reference or not", () => {
    const actions = planReap({
      rows: [legacyRow({ basisId: "legacy", submittedYaml: "workspaceVersion: 1\n" })],
      referencedBasisIds: new Set(["legacy"]),
      now: NOW,
    });
    // A reference cannot protect material whose provenance cannot be verified.
    expect(actions).toEqual([
      { kind: "clear-payload", basisId: "legacy", reason: "legacy-unreadable" },
    ]);
  });

  it("does not let a legacy row disturb the current rows in the same pass", () => {
    const actions = planReap({
      rows: [
        legacyRow({ basisId: "legacy", expiresAt: PAST }),
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
    // Children first, then parents, then legacy — the ordering invariant holds
    // across both schema versions rather than only within one.
    expect(actions).toEqual([
      { kind: "delete-row", basisId: "child", reason: "expired" },
      { kind: "delete-row", basisId: "parent", reason: "expired" },
      { kind: "delete-row", basisId: "legacy", reason: "legacy-expired" },
    ]);
  });

  it("defers an expired legacy row while a live child still hangs off it", () => {
    const actions = planReap({
      rows: [
        legacyRow({ basisId: "legacy", expiresAt: PAST }),
        row({
          basisId: "child",
          ownerKind: "candidate",
          parentBasisId: "legacy",
          transformDigest: "t",
          submittedYaml: null,
        }),
      ],
      referencedBasisIds: NONE,
      now: NOW,
    });
    // Invariant 1 does not depend on candidates only ever having V2 parents.
    expect(actions).toEqual([]);
  });

  it("classifies a row that merely CLAIMS to be V2 as legacy, not as ordinary", () => {
    // The failure this closes: partitioning on `ownerKind` alone let a structurally
    // incomplete row fall through every branch and survive its own expiry.
    const { ownerKind: _dropped, ...malformed } = row({
      basisId: "malformed",
      expiresAt: PAST,
      submittedYaml: null,
    });
    const actions = planReap({
      rows: [malformed as OptimizeBasisRecordV2],
      referencedBasisIds: NONE,
      now: NOW,
    });
    expect(actions).toEqual([
      { kind: "delete-row", basisId: "malformed", reason: "legacy-expired" },
    ]);
  });
});

describe("mayRetainPayload", () => {
  it("refuses a legacy row's raw material outright, however referenced", () => {
    // Nothing can attest what those bytes are, so nothing may display them.
    expect(
      mayRetainPayload(
        legacyRow({ basisId: "legacy", submittedYaml: "workspaceVersion: 1\n" }),
        new Set(["legacy"]),
        NOW,
      ),
    ).toBe(false);
  });

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
