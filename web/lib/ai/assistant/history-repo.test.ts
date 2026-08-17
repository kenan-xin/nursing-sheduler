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
    // The generations a fresh database is at. `fence.test.ts` owns the cases where
    // these disagree with the stored fence.
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt: harness.now().toISOString(),
  };
}

/** `recordPreparingTurn` refuses a cleared thread with `null`; these threads are live. */
async function prepareTurn(
  input: Parameters<typeof recordPreparingTurn>[0],
  harness: AssistantHarness,
) {
  const turn = await recordPreparingTurn(input, harness.config);
  if (!turn) throw new Error("expected a live thread to accept a preparing turn");
  return turn;
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

  it("keeps every earlier message's turn, model and generations when a later turn persists", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const firstTurn = {
      ...context(harness, thread.threadId, "scenario-a"),
      modelId: "vendor/one",
      turnId: "turn-1",
    };

    await persistThreadMessages(
      [userMessage("m1", "why is the 15th short?"), assistantMessage("m2", "because of leave")],
      firstTurn,
      harness.config,
    );
    const before = await readThreadMessages(thread.threadId, harness.config);

    // Any fence movement -- a Clear that landed between the two turns -- leaves this
    // scenario's stored generation behind, so the second turn writes under a
    // different pair. Moved directly rather than through `beginClear`, which would
    // also mark the thread doomed and delete the very rows under test.
    const fenceRow = await harness.db.assistantGenerations.get("scenario:scenario-a");
    if (!fenceRow) throw new Error("expected a fence row for the new thread");
    await harness.db.assistantGenerations.put({
      ...fenceRow,
      generation: fenceRow.generation + 1,
    });
    harness.advance(60_000);

    // A second turn under a DIFFERENT model. Every settled boundary persists the WHOLE
    // hydrated thread, so the two older messages arrive again in this turn's context.
    const secondTurn = {
      ...context(harness, thread.threadId, "scenario-a"),
      modelId: "vendor/two",
      turnId: "turn-2",
      scenarioGeneration: 1,
      createdAt: harness.now().toISOString(),
    };
    await persistThreadMessages(
      [
        userMessage("m1", "why is the 15th short?"),
        assistantMessage("m2", "because of leave"),
        userMessage("m3", "and the 16th?"),
        assistantMessage("m4", "partial"),
      ],
      secondTurn,
      harness.config,
    );
    // ...and the second turn's own answer is still streaming.
    await persistThreadMessages(
      [
        userMessage("m1", "why is the 15th short?"),
        assistantMessage("m2", "because of leave"),
        userMessage("m3", "and the 16th?"),
        assistantMessage("m4", "partial and then the rest"),
      ],
      secondTurn,
      harness.config,
    );

    const after = await readThreadMessages(thread.threadId, harness.config);
    // BYTE-STABLE. A later turn relabelling these would destroy the per-turn model
    // record the setup, privacy and thread contracts promise.
    expect(after.slice(0, 2)).toEqual(before);
    expect(after.slice(0, 2).map((r) => [r.modelId, r.turnId, r.scenarioGeneration])).toEqual([
      ["vendor/one", "turn-1", 0],
      ["vendor/one", "turn-1", 0],
    ]);
    // The new turn's own records carry the new provenance, and its answer still grew.
    expect(
      after.slice(2).map((r) => [r.modelId, r.turnId, r.scenarioGeneration, r.content]),
    ).toEqual([
      ["vendor/two", "turn-2", 1, "and the 16th?"],
      ["vendor/two", "turn-2", 1, "partial and then the rest"],
    ]);
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

    const turn = await prepareTurn(turnInput(thread.threadId), harness);

    expect(turn.state).toBe("preparing");
    expect(turn.basisDocumentRevision).toBe(7);
    expect(turn.leaseEpoch).toBe(3);
    expect(turn.runtimeInstanceId).toBe("instance-1");
    // Captured inside the turn's own write transaction, so the value cannot have
    // gone stale between the read and the row landing.
    expect(turn.globalGeneration).toBe(0);
    expect(turn.scenarioGeneration).toBe(0);
    expect(turn.interruptionTrigger).toBeNull();
  });

  it("settles every unfinished turn as detached on the next page lifetime", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    const streaming = await prepareTurn(turnInput(thread.threadId), harness);
    await setTurnState(streaming.turnId, { state: "streaming" }, harness.config);
    const finished = await prepareTurn(turnInput(thread.threadId), harness);
    await setTurnState(
      finished.turnId,
      { state: "terminal", settlement: "completed" },
      harness.config,
    );

    const settled = await detachStaleTurns(harness.config);

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
    await prepareTurn(turnInput(thread.threadId), harness);
    harness.advance(1_000);
    const latest = await prepareTurn(turnInput(thread.threadId), harness);

    expect((await readLatestTurn(thread.threadId, harness.config))?.turnId).toBe(latest.turnId);
  });

  it("treats a missing turn as an idempotent no-op rather than a throw", async () => {
    const harness = createAssistantHarness();
    // A stop aimed at a turn a clear already deleted must be ordinary and quiet.
    await expect(setTurnState("nope", { state: "terminal" }, harness.config)).resolves.toBe(
      "missing",
    );
    expect(await readLatestTurn("nope", harness.config)).toBeNull();
  });

  it("refuses to prepare a turn on a thread a clear has marked for deletion", async () => {
    const harness = createAssistantHarness();
    const thread = await selectActiveThread("scenario-a", harness.config);
    await harness.db.assistantThreads.put({ ...thread, state: "cleared" });

    expect(await recordPreparingTurn(turnInput(thread.threadId), harness.config)).toBeNull();
  });
});
