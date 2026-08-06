import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";

import {
  detachStaleTurns,
  persistThreadMessages,
  readLatestTurn,
  readThreadMessages,
  readThreadsForScenario,
  recordPreparingTurn,
  selectActiveThread,
  setTurnState,
} from "./history-repo";
import { toTransportThread } from "./messages";
import { createAssistantHarness, TEST_MODEL, type AssistantHarness } from "./test-support";

function context(harness: AssistantHarness, threadId: string, scenarioId: string) {
  return {
    threadId,
    scenarioId,
    modelId: TEST_MODEL,
    turnId: "turn-1",
    createdAt: harness.now().toISOString(),
  };
}

function userMessage(id: string, content: string): Message {
  return { id, role: "user", content };
}

function assistantMessage(id: string, content: string): Message {
  return { id, role: "assistant", content };
}

describe("the scenario-bound thread boundary", () => {
  it("gives one scenario exactly one active thread, idempotently", async () => {
    const harness = createAssistantHarness();

    const first = await selectActiveThread("scenario-a", harness.config);
    const second = await selectActiveThread("scenario-a", harness.config);

    expect(second.threadId).toBe(first.threadId);
    expect(await readThreadsForScenario("scenario-a", harness.config)).toHaveLength(1);
  });

  it("starts a CLEAN thread for a new identity and suspends the previous one", async () => {
    const harness = createAssistantHarness();
    const original = await selectActiveThread("scenario-a", harness.config);
    await persistThreadMessages(
      [userMessage("m1", "about scenario A")],
      context(harness, original.threadId, "scenario-a"),
      harness.config,
    );

    // A Load/replace mints a new scenario identity upstream, so the assistant can
    // only ever find no thread for it.
    const replacement = await selectActiveThread("scenario-b", harness.config);

    expect(replacement.threadId).not.toBe(original.threadId);
    expect(await readThreadMessages(replacement.threadId, harness.config)).toEqual([]);

    const suspended = await harness.db.assistantThreads.get(original.threadId);
    expect(suspended?.state).toBe("historical");
  });

  it("restores a prior identity's EXACT historical thread, never a merge", async () => {
    const harness = createAssistantHarness();
    const original = await selectActiveThread("scenario-a", harness.config);
    await persistThreadMessages(
      [userMessage("m1", "about scenario A")],
      context(harness, original.threadId, "scenario-a"),
      harness.config,
    );
    await selectActiveThread("scenario-b", harness.config);

    const restored = await selectActiveThread("scenario-a", harness.config);

    expect(restored.threadId).toBe(original.threadId);
    expect(restored.state).toBe("active");
    const messages = await readThreadMessages(restored.threadId, harness.config);
    expect(messages.map((m) => m.content)).toEqual(["about scenario A"]);
    // Exactly two threads exist -- restoring did not mint a third, and scenario B's
    // messages did not migrate into A's.
    expect(await harness.db.assistantThreads.count()).toBe(2);
  });

  it("repairs a database that somehow holds two active threads", async () => {
    const harness = createAssistantHarness();
    const a = await selectActiveThread("scenario-a", harness.config);
    const b = await selectActiveThread("scenario-b", harness.config);
    // Simulate an interruption that left both marked active.
    await harness.db.assistantThreads.put({ ...a, state: "active" });

    await selectActiveThread("scenario-b", harness.config);

    expect((await harness.db.assistantThreads.get(a.threadId))?.state).toBe("historical");
    expect((await harness.db.assistantThreads.get(b.threadId))?.state).toBe("active");
  });

  it("captures the clear fences at creation so T05 has something durable to compare", async () => {
    const harness = createAssistantHarness();

    const thread = await selectActiveThread("scenario-a", harness.config);

    expect(thread.globalGeneration).toBe(0);
    expect(thread.scenarioGeneration).toBe(0);
    expect(await harness.db.assistantGenerations.get("global")).toBeDefined();
    expect(await harness.db.assistantGenerations.get("scenario:scenario-a")).toBeDefined();
  });
});

describe("canonical message persistence", () => {
  it("assigns monotonic seq and restores in that order", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const ctx = context(harness, thread.threadId, "scenario-a");

    await persistThreadMessages(
      [userMessage("m1", "first"), assistantMessage("m2", "second")],
      ctx,
      harness.config,
    );
    await persistThreadMessages([userMessage("m3", "third")], ctx, harness.config);

    const records = await readThreadMessages(thread.threadId, harness.config);
    expect(records.map((r) => [r.seq, r.content])).toEqual([
      [0, "first"],
      [1, "second"],
      [2, "third"],
    ]);
  });

  it("keeps a growing message in its original slot rather than reordering it", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const ctx = context(harness, thread.threadId, "scenario-a");

    await persistThreadMessages(
      [userMessage("m1", "question"), assistantMessage("m2", "partial")],
      ctx,
      harness.config,
    );
    harness.advance(1_000);
    // The same assistant message, longer -- exactly what a stream produces.
    await persistThreadMessages(
      [userMessage("m1", "question"), assistantMessage("m2", "partial and then more")],
      { ...ctx, createdAt: harness.now().toISOString() },
      harness.config,
    );

    const records = await readThreadMessages(thread.threadId, harness.config);
    expect(records.map((r) => [r.seq, r.content])).toEqual([
      [0, "question"],
      [1, "partial and then more"],
    ]);
    // The original timestamp survives: a message the user read at T did not move to T+1s.
    expect(records[1].createdAt).toBe("2026-08-06T00:00:00.000Z");
  });

  it("persists tool calls and their results, and replays them to the transport", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const ctx = context(harness, thread.threadId, "scenario-a");

    await persistThreadMessages(
      [
        {
          id: "m1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "get_schedule_overview", arguments: "{}" },
            },
          ],
        },
        { id: "m2", role: "tool", content: '{"people":3}', toolCallId: "call-1" },
      ] as Message[],
      ctx,
      harness.config,
    );

    const replayed = toTransportThread(await readThreadMessages(thread.threadId, harness.config));
    expect(replayed[0]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "call-1", function: { name: "get_schedule_overview" } }],
    });
    expect(replayed[1]).toMatchObject({ role: "tool", toolCallId: "call-1" });
  });

  it("records the model that produced each message", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);

    await persistThreadMessages(
      [assistantMessage("m1", "hello")],
      context(harness, thread.threadId, "scenario-a"),
      harness.config,
    );

    const [record] = await readThreadMessages(thread.threadId, harness.config);
    expect(record.modelId).toBe(TEST_MODEL);
  });

  it("drops message kinds the product never promised to restore", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);

    await persistThreadMessages(
      [
        { id: "m1", role: "activity", content: { note: "internal" }, activityType: "x" },
        userMessage("m2", "kept"),
      ] as Message[],
      context(harness, thread.threadId, "scenario-a"),
      harness.config,
    );

    const records = await readThreadMessages(thread.threadId, harness.config);
    expect(records.map((r) => r.content)).toEqual(["kept"]);
  });
});

describe("turn lifecycle", () => {
  const turnInput = (threadId: string) => ({
    threadId,
    scenarioId: "scenario-a",
    basisDocumentRevision: 7,
    leaseEpoch: 3,
    modelId: TEST_MODEL,
    runId: "run-1",
    turnEpoch: 1,
    runtimeInstanceId: "instance-1",
  });

  it("persists a preparing turn with its full basis before any run starts", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);

    const turn = await recordPreparingTurn(turnInput(thread.threadId), harness.config);

    expect(turn.state).toBe("preparing");
    expect(turn.basisDocumentRevision).toBe(7);
    expect(turn.leaseEpoch).toBe(3);
    expect(turn.runtimeInstanceId).toBe("instance-1");
  });

  it("settles every unfinished turn as detached on the next page lifetime", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const streaming = await recordPreparingTurn(turnInput(thread.threadId), harness.config);
    await setTurnState(streaming.turnId, "streaming", null, harness.config);
    const finished = await recordPreparingTurn(turnInput(thread.threadId), harness.config);
    await setTurnState(finished.turnId, "terminal", "completed", harness.config);

    const settled = await detachStaleTurns("runtime_lost_on_reload", harness.config);

    expect(settled).toBe(1);
    expect((await harness.db.assistantTurns.get(streaming.turnId))?.state).toBe("detached");
    // An already-terminal turn is not rewritten -- it settled honestly.
    expect((await harness.db.assistantTurns.get(finished.turnId))?.terminalReason).toBe(
      "completed",
    );
  });

  it("reads the latest turn on a thread", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    await recordPreparingTurn(turnInput(thread.threadId), harness.config);
    harness.advance(1_000);
    const latest = await recordPreparingTurn(turnInput(thread.threadId), harness.config);

    expect((await readLatestTurn(thread.threadId, harness.config))?.turnId).toBe(latest.turnId);
  });

  it("treats a missing turn as a no-op rather than a throw", async () => {
    const harness = createAssistantHarness();
    await expect(setTurnState("nope", "terminal", null, harness.config)).resolves.toBeUndefined();
    expect(await readLatestTurn("nope", harness.config)).toBeNull();
  });
});
