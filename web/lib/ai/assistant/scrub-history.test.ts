// Dirty history that is already on disk.
//
// Publication filtering stops NEW damage, but `persistThreadMessages` upserts what it
// is given and never deletes what it omits -- so a dangling call written by an older
// build, a crash, or a malformed import survives every sanitized write and is replayed
// into every later turn. Only a delete repairs it, and only a fenced, thread-scoped
// delete can do that without touching anything it does not own.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { readThreadMessages, scrubThreadHistory, selectActiveThread } from "./history-repo";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

let harness: AssistantHarness;

beforeEach(() => {
  harness = createAssistantHarness();
});

/** Write a row straight to Dexie, as an older build would have left it. */
async function seed(
  threadId: string,
  scenarioId: string,
  row: { messageId: string; seq: number; role: string; content?: string; toolCalls?: unknown },
) {
  await harness.db.assistantMessages.put({
    schemaVersion: 1,
    threadId,
    scenarioId,
    content: "",
    toolCalls: null,
    toolCallId: null,
    modelId: null,
    turnId: null,
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt: new Date().toISOString(),
    ...row,
  } as never);
}

describe("a pre-existing dangling call is deleted, not merely skipped", () => {
  it("removes the dangling row and leaves the valid conversation", async () => {
    const thread = await selectActiveThread("scenario-a");
    await seed(thread.threadId, "scenario-a", {
      messageId: "u1",
      seq: 1,
      role: "user",
      content: "hi",
    });
    await seed(thread.threadId, "scenario-a", {
      messageId: "dangling",
      seq: 2,
      role: "assistant",
      toolCalls: [{ toolCallId: "c-dangling", name: "t", args: "{}" }],
    });

    // Non-vacuity: it really is on disk before the scrub.
    expect(JSON.stringify(await harness.db.assistantMessages.toArray())).toContain("c-dangling");

    const result = await scrubThreadHistory(thread.threadId);

    expect(result).toEqual({ removed: 1 });
    const after = await harness.db.assistantMessages.toArray();
    expect(JSON.stringify(after)).not.toContain("c-dangling");
    // The valid message is untouched -- a scrub is not a wipe.
    expect(after.map((row) => row.messageId)).toEqual(["u1"]);
    // And the canonical read agrees.
    expect(JSON.stringify(await readThreadMessages(thread.threadId))).not.toContain("c-dangling");
  });

  it("keeps a complete pair", async () => {
    const thread = await selectActiveThread("scenario-a");
    await seed(thread.threadId, "scenario-a", {
      messageId: "m1",
      seq: 1,
      role: "assistant",
      toolCalls: [{ toolCallId: "c1", name: "t", args: "{}" }],
    });
    await harness.db.assistantMessages.put({
      schemaVersion: 1,
      messageId: "r1",
      seq: 2,
      threadId: thread.threadId,
      scenarioId: "scenario-a",
      role: "tool",
      content: "done",
      toolCalls: null,
      toolCallId: "c1",
      modelId: null,
      turnId: null,
      globalGeneration: 0,
      scenarioGeneration: 0,
      createdAt: new Date().toISOString(),
    } as never);

    expect(await scrubThreadHistory(thread.threadId)).toEqual({ removed: 0 });
    expect((await harness.db.assistantMessages.toArray()).length).toBe(2);
  });

  it("touches no other thread", async () => {
    // Thread scoping is the whole safety argument: a scrub must never be able to reach
    // another conversation's rows, let alone another scenario's.
    const mine = await selectActiveThread("scenario-a");
    const theirs = await selectActiveThread("scenario-b");
    await seed(mine.threadId, "scenario-a", {
      messageId: "mine-dangling",
      seq: 1,
      role: "assistant",
      toolCalls: [{ toolCallId: "c1", name: "t", args: "{}" }],
    });
    await seed(theirs.threadId, "scenario-b", {
      messageId: "theirs-dangling",
      seq: 1,
      role: "assistant",
      toolCalls: [{ toolCallId: "c2", name: "t", args: "{}" }],
    });

    await scrubThreadHistory(mine.threadId);

    const remaining = (await harness.db.assistantMessages.toArray()).map((row) => row.messageId);
    expect(remaining).toEqual(["theirs-dangling"]);
  });

  it("reports a missing thread rather than guessing", async () => {
    expect(await scrubThreadHistory("no-such-thread")).toBe("missing");
  });
});
