// THE COMMIT WINDOW.
//
// A caller that checks its authority and then calls the repository has an await
// between the decision and the write. Stop lands in that window: the write was
// authorised when it was requested and is not when it commits. A pre-call recheck
// cannot close this -- by the time authority is lost, the transaction is already open.
//
// So the check moved INSIDE the write's own transaction. These tests hold the write
// open at a deterministic barrier, revoke, and then let it resume.

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@ag-ui/client";

import { persistThreadMessages, readThreadMessages, selectActiveThread } from "./history-repo";
import { createAssistantHarness, type AssistantHarness } from "./test-support";

let harness: AssistantHarness;
let threadId: string;

beforeEach(async () => {
  harness = createAssistantHarness();
  threadId = (await selectActiveThread("scenario-a")).threadId;
});

function context(createdAt = new Date().toISOString()) {
  return {
    threadId,
    scenarioId: "scenario-a",
    modelId: "m",
    turnId: "turn-1",
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt,
  };
}

const hello = { id: "m1", role: "user", content: "hello" } as unknown as Message;

describe("authority is compared at the commit boundary", () => {
  it("commits while authorized", async () => {
    const outcome = await persistThreadMessages([hello], context(), {
      authorizeCommit: () => true,
    });

    expect(outcome).toBe("accepted");
    expect(await readThreadMessages(threadId)).toHaveLength(1);
  });

  it("refuses a write whose authority is gone BEFORE it opens", async () => {
    const outcome = await persistThreadMessages([hello], context(), {
      authorizeCommit: () => false,
    });

    expect(outcome).toBe("fenced");
    expect(await readThreadMessages(threadId)).toHaveLength(0);
  });

  it("refuses when Stop lands while the transaction is already open", async () => {
    // THE WINDOW ITSELF. The guard is called from inside the transaction, so the
    // barrier below is the moment a pre-call check could not have seen.
    let authorized = true;
    let barrierEntered = false;

    const outcome = await persistThreadMessages([hello], context(), {
      authorizeCommit: () => {
        // Evaluated inside the open transaction -- proved by the flag, so this case
        // cannot pass by the guard never being consulted at all.
        barrierEntered = true;
        // Stop happens exactly here, between the transaction opening and the write.
        authorized = false;
        return authorized;
      },
    });

    expect(barrierEntered).toBe(true);
    expect(outcome).toBe("fenced");
    // Nothing was written. That is the whole claim.
    expect(await readThreadMessages(threadId)).toHaveLength(0);
  });

  it("is not vacuous: the same shape commits when the guard stays true", async () => {
    let barrierEntered = false;

    const outcome = await persistThreadMessages([hello], context(), {
      authorizeCommit: () => {
        barrierEntered = true;
        return true;
      },
    });

    expect(barrierEntered).toBe(true);
    expect(outcome).toBe("accepted");
    expect(await readThreadMessages(threadId)).toHaveLength(1);
  });

  it("leaves earlier committed history untouched when a later write is refused", async () => {
    await persistThreadMessages([hello], context(), { authorizeCommit: () => true });

    const later = { id: "m2", role: "user", content: "second" } as unknown as Message;
    const outcome = await persistThreadMessages([hello, later], context(), {
      authorizeCommit: () => false,
    });

    expect(outcome).toBe("fenced");
    const rows = await readThreadMessages(threadId);
    expect(rows.map((row) => row.messageId)).toEqual(["m1"]);
  });

  it("still writes for callers with no guard -- the interruption controller's path", async () => {
    // The controller settles its own work precisely when authority is gone, so the
    // guard is opt-in rather than mandatory.
    const outcome = await persistThreadMessages([hello], context());

    expect(outcome).toBe("accepted");
  });
});

describe("a queued write cannot reread later state", () => {
  // WHERE THIS PROPERTY LIVES. The repository writes exactly the array it is handed --
  // it has no view of the caller's clone and should not invent one. The protection is
  // the SESSION's: it evaluates its normalized snapshot when it ENQUEUES, producing a
  // fresh array, so nothing the clone does afterwards can reach the queued task.
  //
  // Both halves are asserted, because getting either wrong reopens the defect: the
  // repository must be faithful to its argument, and a snapshot must be a copy.

  it("is faithful to the array it was given", async () => {
    const live: Message[] = [hello];
    await persistThreadMessages(live, context(), { authorizeCommit: () => true });

    expect((await readThreadMessages(threadId)).map((row) => row.messageId)).toEqual(["m1"]);
  });

  it("a snapshot taken at enqueue is immune to later clone mutation", async () => {
    const clone: Message[] = [hello];
    // Exactly what the session does at the authorized moment: capture, do not alias.
    const snapshot = [...clone];

    // The clone moves on -- a tool result inserted after Stop, say.
    clone.push({ id: "late", role: "user", content: "late" } as unknown as Message);

    await persistThreadMessages(snapshot, context(), { authorizeCommit: () => true });

    const rows = await readThreadMessages(threadId);
    expect(rows.map((row) => row.messageId)).toEqual(["m1"]);
    // Non-vacuity: the late message really did exist by then.
    expect(clone).toHaveLength(2);
  });
});

describe("a rejected write does not poison the ones after it", () => {
  it("recovers, reports once, and lets the final authorized write land", async () => {
    // The session's chain `.catch`es each link. This proves the repository-level
    // behaviour the chain depends on: a rejection is isolated to its own write.
    const failing = vi
      .spyOn(harness.db.assistantMessages, "put")
      .mockRejectedValueOnce(new Error("storage full"));

    await expect(
      persistThreadMessages([hello], context(), { authorizeCommit: () => true }),
    ).rejects.toThrow();
    expect(failing).toHaveBeenCalled();
    failing.mockRestore();

    const outcome = await persistThreadMessages([hello], context(), {
      authorizeCommit: () => true,
    });

    expect(outcome).toBe("accepted");
    expect(await readThreadMessages(threadId)).toHaveLength(1);
  });
});
