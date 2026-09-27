import { describe, expect, it } from "vitest";
import type { AssistantMessageV1 } from "./records";
import {
  COMPACT_AT_CHARS,
  KEEP_RECENT_USER_TURNS,
  historyChars,
  omittedMessageIds,
  planCompaction,
  transcriptForSummary,
} from "./compaction";

let seq = 0;
function row(
  role: AssistantMessageV1["role"],
  content: string,
  extra: Partial<AssistantMessageV1> = {},
): AssistantMessageV1 {
  seq += 1;
  return {
    messageId: `m${seq}`,
    schemaVersion: 1,
    threadId: "t",
    scenarioId: "s",
    seq,
    role,
    content,
    toolCalls: null,
    toolCallId: null,
    modelId: null,
    turnId: null,
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
    ...extra,
  };
}
/** n turns of: user, assistant tool call, tool result, assistant answer. */
function turns(n: number, size = 4_000): AssistantMessageV1[] {
  return Array.from({ length: n }, (_, i) => [
    row("user", `question ${i} ${"q".repeat(size)}`),
    row("assistant", "", {
      toolCalls: [{ toolCallId: `c${i}`, name: "get_roster", args: "{}" }],
    }),
    row("tool", "r".repeat(size), { toolCallId: `c${i}` }),
    row("assistant", `answer ${i}`),
  ]).flat();
}

describe("planCompaction", () => {
  it("does nothing under the budget", () => {
    const records = turns(3, 100);
    expect(historyChars(records)).toBeLessThan(COMPACT_AT_CHARS);
    expect(planCompaction(records, null)).toBeNull();
  });

  it("cuts just before the 4th-from-last user message, keeping tool pairs whole", () => {
    const records = turns(10);
    const plan = planCompaction(records, null)!;
    const firstKept = records.filter((r) => r.role === "user").at(-KEEP_RECENT_USER_TURNS)!;
    expect(plan.throughSeq).toBe(firstKept.seq - 1);
    expect(plan.slice.at(-1)!.role).toBe("assistant");
    expect(plan.slice.every((r) => r.seq <= plan.throughSeq)).toBe(true);
  });

  it("never compacts 4 or fewer user turns, however large", () => {
    expect(planCompaction(turns(KEEP_RECENT_USER_TURNS, 30_000), null)).toBeNull();
  });

  it("rolls forward from an existing summary and only counts what it does not cover", () => {
    const records = turns(10);
    const first = planCompaction(records, null)!;
    const summary = { text: "s", throughSeq: first.throughSeq, createdAt: "x" };
    expect(planCompaction(records, summary)).toBeNull();
    const more = [...records, ...turns(10)];
    expect(planCompaction(more, summary)!.throughSeq).toBeGreaterThan(first.throughSeq);
    expect(planCompaction(more, summary)!.slice[0].seq).toBe(first.throughSeq + 1);
  });

  it("omits exactly the covered messages", () => {
    const records = turns(10);
    const plan = planCompaction(records, null)!;
    const ids = omittedMessageIds(records, {
      text: "s",
      throughSeq: plan.throughSeq,
      createdAt: "x",
    });
    expect([...ids]).toEqual(plan.slice.map((r) => r.messageId));
    expect(omittedMessageIds(records, null).size).toBe(0);
  });
});

describe("transcriptForSummary", () => {
  it("keeps the words, names the tools, trims results and skips reasoning", () => {
    const text = transcriptForSummary([
      row("user", "Ana is on leave on 3 Nov"),
      row("assistant", "", {
        toolCalls: [{ toolCallId: "c", name: "get_roster", args: "{}" }],
      }),
      row("tool", "x".repeat(2_000), { toolCallId: "c" }),
      row("reasoning", "secret thinking"),
      row("assistant", "Noted."),
    ]);
    expect(text).toContain("User: Ana is on leave on 3 Nov");
    expect(text).toContain("Assistant used get_roster.");
    expect(text).toContain("Assistant: Noted.");
    expect(text).not.toContain("secret thinking");
    expect(text).not.toContain("x".repeat(601));
  });

  it("keeps the newest part when the input is over the cap", () => {
    const text = transcriptForSummary([
      row("user", `oldest ${"a".repeat(130_000)}`),
      row("user", "newest"),
    ]);
    expect(text.length).toBeLessThanOrEqual(120_000);
    expect(text).toContain("User: newest");
    expect(text).not.toContain("oldest");
  });
});
