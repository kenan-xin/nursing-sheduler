// A durable Clear record must describe a state a Clear invocation can actually be in.
//
// THE DEFECT THIS FIXES. Validation checked that each field held a value this build
// recognises, and stopped there. Every field could be individually legal while the
// COMBINATION described something that never happened -- and two of those combinations
// were live defects, not curiosities:
//
//   * a `pending` row carrying `deletionOutcome: "deleted"` was accepted as live
//     deletion authority, so a record claiming its own deletion had already committed
//     could authorize a second one;
//   * a terminal `failed` row carrying `deletionOutcome: "deleted"` rendered a retry,
//     which is exactly the reach-forward the committed-deletion contract forbids.
//
// So each case below starts from a genuinely valid record and changes ONE field. A
// rejected row must authorize nothing, render nothing, and survive scoped retirement --
// fail-closed in all three directions, not just invisible.

import { beforeEach, describe, expect, it } from "vitest";

import { clearOutcomes, finishClear, readClearOutcome, type ClearScope } from "./clear-repo";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

const TARGET = "scenario-target";

/**
 * The scope key, spelled out rather than imported from the repository module.
 *
 * `lib/store/authority-boundary.test.ts` enforces at the AST level that only the
 * projection adapter reaches into `@/lib/repository`, and that boundary is worth more
 * than the convenience of reusing one helper here.
 */
function scenarioGenerationScope(scenarioId: string): `scenario:${string}` {
  return `scenario:${scenarioId}`;
}

let harness: AssistantHarness;

function commitmentFor(captured: { scopeKey: string; generation: number }[]) {
  const sorted = [...captured].sort((left, right) =>
    left.scopeKey < right.scopeKey ? -1 : left.scopeKey > right.scopeKey ? 1 : 0,
  );
  return {
    count: sorted.length,
    canonical: JSON.stringify(sorted.map((entry) => [entry.scopeKey, entry.generation])),
  };
}

/** A genuinely valid canonical record in one of the three reachable states. */
function validRecord(state: "pending" | "incomplete" | "failed", scope: ClearScope = "history") {
  const captured =
    scope === "history"
      ? [{ scopeKey: scenarioGenerationScope(TARGET), generation: 1 }]
      : [{ scopeKey: "global", generation: 1 }];
  const shared = {
    operationId: `op-${state}`,
    version: 5 as const,
    requestId: `request-${state}`,
    scope,
    scenarioId: scope === "history" ? (TARGET as string | null) : null,
    captured,
    commitment: commitmentFor(captured),
    startedAt: "2026-08-01T00:00:00.000Z",
  };
  if (state === "pending") {
    return {
      ...shared,
      outcome: "pending" as const,
      reason: null,
      settlement: null,
      deletionOutcome: null,
      configurationOutcome: scope === "all" ? ("deleted" as const) : ("retained" as const),
    };
  }
  if (state === "incomplete") {
    return {
      ...shared,
      outcome: "incomplete" as const,
      reason: scope === "all" ? ("recapture_exhausted" as const) : ("superseded" as const),
      settlement: "stopped" as const,
      deletionOutcome: "superseded" as const,
      configurationOutcome: scope === "all" ? ("deleted" as const) : ("retained" as const),
    };
  }
  return {
    ...shared,
    outcome: "failed" as const,
    reason: "storage" as const,
    settlement: null,
    deletionOutcome: null,
    configurationOutcome: scope === "all" ? ("unknown" as const) : ("retained" as const),
  };
}

/** Put every fence row at generation 1, so a record naming one could match. */
async function fenceAtOne() {
  const at = new Date().toISOString();
  for (const scopeKey of ["global", scenarioGenerationScope(TARGET)]) {
    await harness.db.assistantGenerations.put({
      scopeKey,
      generation: 1,
      clearedAt: at,
      createdAt: at,
    } as never);
  }
}

beforeEach(async () => {
  harness = createAssistantHarness();
  await fenceAtOne();
});

describe("the reachable-state table accepts the states that happen", () => {
  it("accepts a valid pending record as deletion authority", async () => {
    await harness.db.assistantClearOperations.put(validRecord("pending") as never);
    // Non-vacuity for every rejection below: this baseline really does authorize.
    const deletion = await finishClear(
      {
        scope: "history",
        scenarioId: TARGET,
        operationId: "op-pending",
        captured: [{ scopeKey: scenarioGenerationScope(TARGET), generation: 1 }],
        threadIds: [],
        configurationDeleted: false,
      },
      { db: harness.db },
    );
    expect(deletion.outcome).toBe("deleted");
  });

  it.each(["incomplete", "failed"] as const)(
    "accepts a valid %s record as a notice",
    async (state) => {
      await harness.db.assistantClearOperations.put(validRecord(state) as never);
      expect(await readClearOutcome({ db: harness.db })).toMatchObject({
        operationId: `op-${state}`,
        status: state,
      });
    },
  );

  it("accepts a valid global incomplete record with its proven configuration fact", async () => {
    await harness.db.assistantClearOperations.put(validRecord("incomplete", "all") as never);
    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      status: "incomplete",
      scope: "all",
      reason: "recapture_exhausted",
      configurationOutcome: "deleted",
    });
  });
});

describe("the reachable-state table rejects states that cannot happen", () => {
  type Record = ReturnType<typeof validRecord>;

  /** Contradictions on a PENDING record. Each must lose deletion authority. */
  const PENDING_CONTRADICTIONS: [string, (r: Record) => unknown][] = [
    // THE AUTHORITY DEFECT: a row claiming its own deletion already committed.
    ["a committed deletion outcome", (r) => ({ ...r, deletionOutcome: "deleted" })],
    ["a superseded deletion outcome", (r) => ({ ...r, deletionOutcome: "superseded" })],
    ["a failure reason", (r) => ({ ...r, reason: "storage" })],
    ["a supersession reason", (r) => ({ ...r, reason: "superseded" })],
    ["a settlement class", (r) => ({ ...r, settlement: "stopped" })],
    [
      "a configuration fact its scope disproves",
      (r) => ({ ...r, configurationOutcome: "deleted" }),
    ],
    ["an unproven configuration fact", (r) => ({ ...r, configurationOutcome: "unknown" })],
  ];

  it.each(PENDING_CONTRADICTIONS)(
    "refuses authority to pending with %s",
    async (_label, mutate) => {
      await harness.db.assistantClearOperations.put(mutate(validRecord("pending")) as never);

      const deletion = await finishClear(
        {
          scope: "history",
          scenarioId: TARGET,
          operationId: "op-pending",
          captured: [{ scopeKey: scenarioGenerationScope(TARGET), generation: 1 }],
          threadIds: [],
          configurationDeleted: false,
        },
        { db: harness.db },
      );
      // Authorizes nothing...
      expect(deletion.outcome).toBe("superseded");
      // ...renders nothing...
      expect(await readClearOutcome({ db: harness.db })).toBeNull();
      // ...and survives a scoped retirement that names it explicitly.
      await clearOutcomes("history", TARGET, {
        db: harness.db,
        predecessorOperationIds: ["op-pending"],
      });
      expect(await harness.db.assistantClearOperations.get("op-pending")).toBeDefined();
    },
  );

  /** Contradictions on a TERMINAL record. Each must stop rendering a notice. */
  const TERMINAL_CONTRADICTIONS: [string, "incomplete" | "failed", (r: Record) => unknown][] = [
    // THE RETRY DEFECT: a tombstone whose own facts say the deletion committed.
    ["a committed deletion outcome", "failed", (r) => ({ ...r, deletionOutcome: "deleted" })],
    ["a committed deletion outcome", "incomplete", (r) => ({ ...r, deletionOutcome: "deleted" })],
    ["a superseded deletion outcome", "failed", (r) => ({ ...r, deletionOutcome: "superseded" })],
    ["no deletion outcome", "incomplete", (r) => ({ ...r, deletionOutcome: null })],
    ["no settlement", "incomplete", (r) => ({ ...r, settlement: null })],
    ["the wrong scope's reason", "incomplete", (r) => ({ ...r, reason: "recapture_exhausted" })],
    ["a supersession reason", "failed", (r) => ({ ...r, reason: "superseded" })],
    ["a recapture reason", "failed", (r) => ({ ...r, reason: "recapture_exhausted" })],
    ["no reason at all", "failed", (r) => ({ ...r, reason: null })],
    ["no reason at all", "incomplete", (r) => ({ ...r, reason: null })],
    [
      "a deleted configuration a history scope disproves",
      "failed",
      (r) => ({
        ...r,
        configurationOutcome: "deleted",
      }),
    ],
    [
      "an unproven configuration a history scope disproves",
      "incomplete",
      (r) => ({
        ...r,
        configurationOutcome: "unknown",
      }),
    ],
  ];

  it.each(TERMINAL_CONTRADICTIONS)(
    "renders no notice for %s on a %s record",
    async (_label, state, mutate) => {
      await harness.db.assistantClearOperations.put(mutate(validRecord(state)) as never);

      expect(await readClearOutcome({ db: harness.db })).toBeNull();
      await clearOutcomes("history", TARGET, {
        db: harness.db,
        predecessorOperationIds: [`op-${state}`],
      });
      expect(await harness.db.assistantClearOperations.get(`op-${state}`)).toBeDefined();
    },
  );

  it.each(["retained", "unknown"] as const)(
    "refuses a v5 global failure that settled yet claims configuration %s",
    async (configurationOutcome) => {
      // THE WRITER'S OWN ORDER RULES THIS OUT. The fence is step 1 of the interruption
      // and the bounded settlement is step 4, so a non-null settlement proves
      // `beginClear` returned -- and that transaction is what deletes the configuration
      // row. `retained` here would render a Clear-all retry from a row whose own facts
      // say the credential is already gone; `unknown` would claim an ignorance the
      // writer did not have.
      await harness.db.assistantClearOperations.put({
        ...validRecord("failed", "all"),
        settlement: "stopped",
        configurationOutcome,
      } as never);

      expect(await readClearOutcome({ db: harness.db })).toBeNull();
    },
  );

  it("accepts a v5 global failure that settled and proves deletion", async () => {
    // The reachable one: the fence committed, settlement ran, finish threw.
    await harness.db.assistantClearOperations.put({
      ...validRecord("failed", "all"),
      settlement: "stopped",
      configurationOutcome: "deleted",
    } as never);

    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      status: "failed",
      scope: "all",
      settlement: "stopped",
      configurationOutcome: "deleted",
    });
  });

  it.each(["retained", "unknown", "deleted"] as const)(
    "accepts a v5 global failure with no settlement and configuration %s",
    async (configurationOutcome) => {
      // All three are genuinely produced with a null settlement: `retained` before the
      // fence, `deleted` after the fence but before the window closed, and `unknown`
      // by legacy normalization.
      await harness.db.assistantClearOperations.put({
        ...validRecord("failed", "all"),
        settlement: null,
        configurationOutcome,
      } as never);

      expect(await readClearOutcome({ db: harness.db })).toMatchObject({
        status: "failed",
        configurationOutcome,
      });
    },
  );

  it("keeps the broader version-4 compatibility, which never recorded the fact", async () => {
    // A version-4 global failure derives `unknown`, and its settlement says nothing
    // about a field that build did not store. Tightening the v5 rule onto v4 would
    // reject rows the previous build legitimately wrote.
    const base = validRecord("failed", "all");
    const { configurationOutcome: _absent, ...asV4 } = base;
    await harness.db.assistantClearOperations.put({
      ...asV4,
      version: 4,
      settlement: "stopped",
    } as never);

    expect(await readClearOutcome({ db: harness.db })).toMatchObject({
      status: "failed",
      scope: "all",
      settlement: "stopped",
      configurationOutcome: "unknown",
    });
  });

  it("refuses a global incomplete record that denies its own proven deletion", async () => {
    // A global clear that reached the deletion pass necessarily committed its fence,
    // and that fence deleted the configuration row. Claiming otherwise is unreachable.
    await harness.db.assistantClearOperations.put({
      ...validRecord("incomplete", "all"),
      configurationOutcome: "retained",
    } as never);
    expect(await readClearOutcome({ db: harness.db })).toBeNull();
  });
});
