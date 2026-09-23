// The publication filter, and why it is a filter rather than a timing guard.
//
// CopilotKit emits `TOOL_CALL_END` when the model has finished ASKING for a tool --
// before the handler runs. Publishing the list at that boundary makes a dangling call
// canonical, and a turn stopped mid-tool leaves it that way permanently: the next
// turn hydrates it and sends a question the provider never got an answer to.

import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";

import { completeToolPairs } from "./messages";

function assistantCall(id: string, callId: string): Message {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [{ id: callId, type: "function", function: { name: "t", arguments: "{}" } }],
  } as unknown as Message;
}

function toolResult(id: string, callId: string): Message {
  return { id, role: "tool", content: "result", toolCallId: callId } as unknown as Message;
}

const user = { id: "u1", role: "user", content: "hello" } as unknown as Message;
const answer = { id: "a1", role: "assistant", content: "the answer" } as unknown as Message;

/**
 * The invariant every published history must satisfy, asserted structurally rather
 * than by eyeballing ids: each surviving call has exactly ONE later result, and each
 * surviving result has exactly ONE earlier call. Reused by every case below so a
 * future shape cannot pass by matching an expectation the invariant would reject.
 */
function assertOneToOneOrdered(published: readonly Message[]): void {
  const callAt = new Map<string, number>();
  published.forEach((message, index) => {
    if (message.role !== "assistant") return;
    for (const call of (message as { toolCalls?: { id?: string }[] }).toolCalls ?? []) {
      expect(call.id, "a published call must have a non-empty id").toBeTruthy();
      expect(callAt.has(call.id!), `call ${call.id} was published twice`).toBe(false);
      callAt.set(call.id!, index);
    }
  });

  const answered = new Set<string>();
  published.forEach((message, index) => {
    if (message.role !== "tool") return;
    const id = (message as { toolCallId?: string }).toolCallId;
    expect(id, "a published result must have a non-empty id").toBeTruthy();
    expect(callAt.has(id!), `result ${id} has no published call`).toBe(true);
    expect(callAt.get(id!)! < index, `result ${id} precedes its call`).toBe(true);
    expect(answered.has(id!), `call ${id} was answered twice`).toBe(false);
    answered.add(id!);
  });

  for (const [id] of callAt) {
    expect(answered.has(id), `call ${id} was published without a result`).toBe(true);
  }
}

describe("the reviewer's malformed shapes", () => {
  // Each of these was reproduced against the previous helper and produced a dangling
  // pair. They are the regression, stated exactly.

  it("drops a result that precedes its call, and the now-dangling call", () => {
    const published = completeToolPairs([toolResult("r1", "c1"), assistantCall("m1", "c1")]);

    expect(published).toEqual([]);
    assertOneToOneOrdered(published);
  });

  it("keeps one call when two declare the same id and only one result exists", () => {
    const published = completeToolPairs([
      assistantCall("m1", "c1"),
      assistantCall("m2", "c1"),
      toolResult("r1", "c1"),
    ]);

    expect(published.map((message) => message.id)).toEqual(["m1", "r1"]);
    assertOneToOneOrdered(published);
  });

  it("drops a duplicate result for an already-answered call", () => {
    const published = completeToolPairs([
      assistantCall("m1", "c1"),
      toolResult("r1", "c1"),
      toolResult("r2", "c1"),
    ]);

    expect(published.map((message) => message.id)).toEqual(["m1", "r1"]);
    assertOneToOneOrdered(published);
  });

  it("keeps the assistant's words when its call is unanswered", () => {
    // AG-UI permits content alongside toolCalls. Dropping the message wholesale cost
    // the user a sentence the assistant genuinely said.
    const mixed = {
      id: "m1",
      role: "assistant",
      content: "Let me look that up.",
      toolCalls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    } as unknown as Message;

    const published = completeToolPairs([user, mixed]);

    expect(published).toHaveLength(2);
    expect((published[1] as { content?: string }).content).toBe("Let me look that up.");
    expect((published[1] as { toolCalls?: unknown }).toolCalls).toBeUndefined();
    assertOneToOneOrdered(published);
  });

  it("drops an empty call id rather than treating it as matchable", () => {
    const published = completeToolPairs([assistantCall("m1", ""), toolResult("r1", "")]);

    expect(published).toEqual([]);
    assertOneToOneOrdered(published);
  });
});

describe("valid shapes survive intact", () => {
  it("keeps a valid multi-call group", () => {
    const twoCalls = {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "t", arguments: "{}" } },
      ],
    } as unknown as Message;

    const published = completeToolPairs([
      user,
      twoCalls,
      toolResult("r1", "c1"),
      toolResult("r2", "c2"),
      answer,
    ]);

    expect(published.map((message) => message.id)).toEqual(["u1", "m1", "r1", "r2", "a1"]);
    assertOneToOneOrdered(published);
  });

  it("keeps repeated groups with distinct ids", () => {
    const published = completeToolPairs([
      assistantCall("m1", "c1"),
      toolResult("r1", "c1"),
      assistantCall("m2", "c2"),
      toolResult("r2", "c2"),
      answer,
    ]);

    expect(published.map((message) => message.id)).toEqual(["m1", "r1", "m2", "r2", "a1"]);
    assertOneToOneOrdered(published);
  });

  it("is idempotent -- normalizing published history changes nothing", () => {
    const once = completeToolPairs([
      assistantCall("m1", "c1"),
      toolResult("r1", "c1"),
      assistantCall("m2", "c2"),
    ]);

    expect(completeToolPairs(once)).toEqual(once);
    assertOneToOneOrdered(once);
  });
});

describe("only complete tool call/result pairs are publishable", () => {
  it("drops an assistant call that has no result yet", () => {
    // The exact `TOOL_CALL_END` moment.
    const kept = completeToolPairs([user, assistantCall("m1", "call-1")]);

    expect(kept).toEqual([user]);
  });

  it("keeps the pair once the result arrives", () => {
    const kept = completeToolPairs([
      user,
      assistantCall("m1", "call-1"),
      toolResult("r1", "call-1"),
      answer,
    ]);

    expect(kept.map((message) => message.id)).toEqual(["u1", "m1", "r1", "a1"]);
  });

  it("drops an orphan result whose call is gone", () => {
    // Otherwise the history would answer a question it does not contain.
    const kept = completeToolPairs([user, toolResult("r1", "call-1")]);

    expect(kept).toEqual([user]);
  });

  it("drops a multi-call message when only some calls are answered", () => {
    const twoCalls = {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", type: "function", function: { name: "t", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "t", arguments: "{}" } },
      ],
    } as unknown as Message;

    const kept = completeToolPairs([user, twoCalls, toolResult("r1", "call-1")]);

    // A half-answered message is as unusable to a provider as an unanswered one, and
    // its surviving result would be an orphan.
    expect(kept).toEqual([user]);
  });

  it("leaves ordinary conversation untouched", () => {
    const plain = [user, answer];

    expect(completeToolPairs(plain)).toEqual(plain);
  });

  it("makes the in-flight revocation race unloseable", () => {
    // THE RACE, stated as a property. A check before a write cannot retract a write
    // already underway, so the mechanism is not to time the write but to make the
    // PAYLOAD incapable of carrying an incomplete pair. Whatever moment a persist is
    // taken at -- before a Stop, during one, after one -- the bytes it commits are
    // this function's output, and there is no input for which that output contains a
    // dangling call.
    const midToolSnapshots = [
      [user, assistantCall("m1", "call-1")],
      [user, assistantCall("m1", "call-1"), toolResult("r1", "other")],
      [assistantCall("m1", "call-1")],
    ];

    for (const snapshot of midToolSnapshots) {
      const published = JSON.stringify(completeToolPairs(snapshot));
      expect(published).not.toContain("call-1");
    }
  });
});
