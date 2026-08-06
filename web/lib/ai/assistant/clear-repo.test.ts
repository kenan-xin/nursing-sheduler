import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";

import { beginClear, finishClear, resumePendingClears } from "./clear-repo";
import {
  persistThreadMessages,
  readThreadMessages,
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
} from "./history-repo";
import { activateProbedConfiguration } from "./settings-repo";
import {
  createAssistantHarness,
  SENTINEL_KEY,
  TEST_MODEL,
  type AssistantHarness,
} from "./test-support";
import type { AssistantThreadV1, AssistantTurnV1 } from "./records";

function user(id: string, content: string): Message {
  return { id, role: "user", content };
}

/** A thread with one persisted message and one live turn, as a real session leaves it. */
async function seedConversation(
  harness: AssistantHarness,
  scenarioId: string,
): Promise<{ thread: AssistantThreadV1; turn: AssistantTurnV1 }> {
  const thread = await selectActiveThread(scenarioId, harness.config);
  const turn = await recordPreparingTurn(
    {
      threadId: thread.threadId,
      scenarioId,
      basisDocumentRevision: 3,
      leaseEpoch: 1,
      modelId: TEST_MODEL,
      runId: `run-${scenarioId}`,
      turnEpoch: 1,
      runtimeInstanceId: "instance-1",
    },
    harness.config,
  );
  if (!turn) throw new Error("expected a live thread");
  await setTurnState(turn.turnId, { state: "streaming" }, harness.config);
  await persistThreadMessages(
    [user(`m-${scenarioId}`, `a question about ${scenarioId}`)],
    {
      threadId: thread.threadId,
      scenarioId,
      modelId: TEST_MODEL,
      turnId: turn.turnId,
      globalGeneration: turn.globalGeneration,
      scenarioGeneration: turn.scenarioGeneration,
      createdAt: harness.now().toISOString(),
    },
    harness.config,
  );
  return { thread, turn };
}

async function storeConfiguration(harness: AssistantHarness) {
  await activateProbedConfiguration(
    { apiKey: SENTINEL_KEY, modelId: TEST_MODEL, modelSource: "catalog" },
    harness.config,
  );
}

/** A late callback: the same write, replayed with the generations it captured. */
function lateWrite(
  harness: AssistantHarness,
  seeded: { thread: AssistantThreadV1; turn: AssistantTurnV1 },
) {
  return persistThreadMessages(
    [user("m-late", "a chunk that arrived after the clear")],
    {
      threadId: seeded.thread.threadId,
      scenarioId: seeded.turn.scenarioId,
      modelId: TEST_MODEL,
      turnId: seeded.turn.turnId,
      globalGeneration: seeded.turn.globalGeneration,
      scenarioGeneration: seeded.turn.scenarioGeneration,
      createdAt: harness.now().toISOString(),
    },
    harness.config,
  );
}

describe("clear history", () => {
  it("fences and marks in the FIRST transaction, and deletes only in the second", async () => {
    const harness = createAssistantHarness();
    const seeded = await seedConversation(harness, "scenario-a");

    const fence = await beginClear("history", "scenario-a", harness.config);

    // Fenced already -- before any cancellation was requested, let alone settled.
    expect(fence.captured).toEqual([{ scopeKey: "scenario:scenario-a", generation: 1 }]);
    expect((await harness.db.assistantThreads.get(seeded.thread.threadId))?.state).toBe("cleared");
    // ...and yet nothing is deleted, so the panel can still show honest settlement.
    expect(await harness.db.assistantMessages.count()).toBe(1);

    const deletion = await finishClear(fence, harness.config);

    expect(deletion).toMatchObject({ outcome: "deleted", threads: 1, messages: 1, turns: 1 });
    expect(await harness.db.assistantMessages.count()).toBe(0);
    expect(await harness.db.assistantTurns.count()).toBe(0);
    expect(await harness.db.assistantThreads.count()).toBe(0);
  });

  it("keeps the credential, the preferences and the permanent fence rows", async () => {
    const harness = createAssistantHarness();
    await storeConfiguration(harness);
    await seedConversation(harness, "scenario-a");

    await finishClear(await beginClear("history", "scenario-a", harness.config), harness.config);

    expect(await harness.db.assistantSettings.get("local")).toMatchObject({
      apiKey: SENTINEL_KEY,
      modelId: TEST_MODEL,
    });
    // The fence rows are what stop a late callback recreating this conversation after
    // a reload, so they must OUTLIVE the data they guard.
    expect((await harness.db.assistantGenerations.get("scenario:scenario-a"))?.generation).toBe(1);
  });

  it("leaves another scenario's conversation and its live turn untouched", async () => {
    const harness = createAssistantHarness();
    const other = await seedConversation(harness, "scenario-b");
    await selectActiveThread("scenario-a", harness.config);
    await seedConversation(harness, "scenario-a");

    await finishClear(await beginClear("history", "scenario-a", harness.config), harness.config);

    expect(await readThreadMessages(other.thread.threadId, harness.config)).toHaveLength(1);
    expect((await harness.db.assistantTurns.get(other.turn.turnId))?.state).toBe("streaming");
    // A write belonging to the untouched scenario still passes its own fence.
    expect(await lateWrite(harness, other)).toBe("accepted");
  });

  it("quarantines a late callback that captured the pre-clear generation", async () => {
    const harness = createAssistantHarness();
    const seeded = await seedConversation(harness, "scenario-a");
    const fence = await beginClear("history", "scenario-a", harness.config);

    // Arriving DURING settlement, before anything was deleted.
    expect(await lateWrite(harness, seeded)).toBe("fenced");

    await finishClear(fence, harness.config);

    // ...and again after deletion, which is the case an in-memory flag would miss.
    expect(await lateWrite(harness, seeded)).toBe("fenced");
    expect(await harness.db.assistantMessages.count()).toBe(0);
  });

  it("does not delete a conversation the user started again during settlement", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");
    const fence = await beginClear("history", "scenario-a", harness.config);

    // A fresh thread minted after the clear carries the POST-clear generations.
    const restarted = await selectActiveThread("scenario-a", harness.config);
    expect(restarted.scenarioGeneration).toBe(1);

    await finishClear(fence, harness.config);

    expect(await harness.db.assistantThreads.get(restarted.threadId)).toBeDefined();
  });
});

describe("clear all AI data", () => {
  it("deletes the credential in the FIRST transaction, before any cancellation", async () => {
    const harness = createAssistantHarness();
    await storeConfiguration(harness);
    await seedConversation(harness, "scenario-a");

    const fence = await beginClear("all", "scenario-a", harness.config);

    // The contract is "delete the browser key immediately". Settlement never needs it:
    // the runtime's info/connect/stop routes are keyless by design.
    expect(fence.configurationDeleted).toBe(true);
    expect(await harness.db.assistantSettings.count()).toBe(0);
    // The conversation is still there, awaiting settlement.
    expect(await harness.db.assistantMessages.count()).toBe(1);
  });

  it("bumps the global scope and every scenario that has ever had data", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");
    await seedConversation(harness, "scenario-b");

    const fence = await beginClear("all", "scenario-b", harness.config);

    expect([...fence.captured].sort((a, b) => a.scopeKey.localeCompare(b.scopeKey))).toEqual([
      { scopeKey: "global", generation: 1 },
      { scopeKey: "scenario:scenario-a", generation: 1 },
      { scopeKey: "scenario:scenario-b", generation: 1 },
    ]);
    expect(fence.threadIds).toHaveLength(2);
  });

  it("survives clear all → detach → reload → late event without recreating anything", async () => {
    const harness = createAssistantHarness();
    await storeConfiguration(harness);
    const seeded = await seedConversation(harness, "scenario-a");

    // Clear all, then detach after the bounded window, then delete.
    const fence = await beginClear("all", "scenario-a", harness.config);
    await finishClear(fence, harness.config);

    // RELOAD: a new page lifetime remembers no fence and no epoch. Only the durable
    // generation rows survive -- and they are exactly what defeats the late event.
    expect(await harness.db.assistantGenerations.count()).toBeGreaterThan(0);

    expect(await lateWrite(harness, seeded)).toBe("fenced");
    // A late turn-state write is refused by the same fence, so a detached callback
    // cannot even resurrect the turn row its message would have hung off.
    expect(await setTurnState(seeded.turn.turnId, { state: "terminal" }, harness.config)).toBe(
      "missing",
    );

    expect(await harness.db.assistantMessages.count()).toBe(0);
    expect(await harness.db.assistantTurns.count()).toBe(0);
    expect(await harness.db.assistantThreads.count()).toBe(0);
    expect(await harness.db.assistantSettings.count()).toBe(0);
  });

  it("keeps the scenario document itself -- clearing AI data is not clearing work", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");
    await harness.db.keyval.put({ key: "scenario", value: "the user's roster" });

    await finishClear(await beginClear("all", "scenario-a", harness.config), harness.config);

    expect(await harness.db.keyval.get("scenario")).toBeDefined();
  });
});

describe("an interrupted clear", () => {
  it("finishes at the next bring-up when the deletion pass never ran", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");
    // Phase one committed; the tab was then closed during settlement.
    await beginClear("history", "scenario-a", harness.config);

    const resumed = await resumePendingClears(harness.config);

    expect(resumed).toMatchObject({ outcome: "deleted", threads: 1, messages: 1 });
    expect(await harness.db.assistantMessages.count()).toBe(0);
  });

  it("is a no-op when no clear is pending", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");

    expect(await resumePendingClears(harness.config)).toMatchObject({ threads: 0, messages: 0 });
    expect(await harness.db.assistantMessages.count()).toBe(1);
  });

  it("lets a SECOND clear supersede the first's deletion pass rather than double-deleting", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");
    const first = await beginClear("history", "scenario-a", harness.config);

    // The user clears everything while the first clear is still settling.
    const second = await beginClear("all", "scenario-a", harness.config);

    // The first pass sees a moved generation and does nothing -- the newer clear owns
    // a strictly larger scope, so deleting here would be redundant at best.
    expect(await finishClear(first, harness.config)).toMatchObject({
      outcome: "superseded",
      messages: 0,
    });
    expect(await harness.db.assistantMessages.count()).toBe(1);

    expect(await finishClear(second, harness.config)).toMatchObject({ outcome: "deleted" });
    expect(await harness.db.assistantMessages.count()).toBe(0);
  });

  it("refuses a clear-history with no scenario identity rather than clearing everything", async () => {
    const harness = createAssistantHarness();
    await seedConversation(harness, "scenario-a");

    await expect(beginClear("history", null, harness.config)).rejects.toThrow(/scenario identity/);
    expect(await harness.db.assistantMessages.count()).toBe(1);
  });
});
