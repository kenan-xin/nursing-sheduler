import { describe, expect, it, vi } from "vitest";
import { compactHistory } from "./compact-history";
import type { AssistantMessageV1, AssistantSettingsV1 } from "@/lib/ai/assistant/records";
import { AI_KEY_HEADER } from "@/lib/ai/protocol";

const ready = { enabled: true, apiKey: "sk-or-TEST", modelId: "m" } as AssistantSettingsV1;
const big = (n: number): AssistantMessageV1[] =>
  Array.from({ length: n }, (_, i) => ({
    messageId: `m${i}`,
    schemaVersion: 1,
    threadId: "t",
    scenarioId: "s",
    seq: i,
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(8_000),
    toolCalls: null,
    toolCallId: null,
    modelId: null,
    turnId: null,
    globalGeneration: 0,
    scenarioGeneration: 0,
    createdAt: "2026-09-27T00:00:00.000Z",
  })) as AssistantMessageV1[];
const input = (history: AssistantMessageV1[]) => ({
  threadId: "t",
  scenarioId: "s",
  history,
  generations: { globalGeneration: 0, scenarioGeneration: 0 },
});
const answer = (body: unknown) =>
  (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

describe("compactHistory", () => {
  it("summarises an over-budget thread once and stores it", async () => {
    const save = vi.fn(async () => "accepted" as const);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, summary: "S" })));
    const onSummarising = vi.fn();
    const out = await compactHistory(
      { ...input(big(20)), onSummarising },
      {
        readThread: async () => ({ summary: null }) as never,
        readSettings: async () => ready,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        saveThreadSummary: save,
        now: () => new Date("2026-09-27T01:00:00.000Z"),
      },
    );
    expect(out.compactedNow).toBe(true);
    expect(out.summary).toMatchObject({ text: "S", throughSeq: 11 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)[AI_KEY_HEADER]).toBe("sk-or-TEST");
    expect(String(init.body)).not.toContain("sk-or-TEST");
    expect(save).toHaveBeenCalledOnce();
    expect(onSummarising).toHaveBeenCalledOnce();
  });

  it("keeps the old summary when the call fails, throws or the write is fenced", async () => {
    const old = { text: "old", throughSeq: 1, createdAt: "x" };
    const deps = {
      readThread: async () => ({ summary: old }) as never,
      readSettings: async () => ready,
      saveThreadSummary: async () => "fenced" as const,
    };
    const kept = { summary: old, compactedNow: false };
    expect(
      await compactHistory(input(big(20)), {
        ...deps,
        fetchImpl: answer({ ok: false, code: "ai_provider_declined" }),
      }),
    ).toEqual(kept);
    expect(
      await compactHistory(input(big(20)), {
        ...deps,
        fetchImpl: (async () => {
          throw new TypeError("offline");
        }) as unknown as typeof fetch,
      }),
    ).toEqual(kept);
    expect(
      await compactHistory(input(big(20)), {
        ...deps,
        fetchImpl: answer({ ok: true, summary: "S" }),
      }),
    ).toEqual(kept);
  });

  it("calls the summariser once across two consecutive sends past the threshold", async () => {
    let stored: { text: string; throughSeq: number; createdAt: string } | null = null;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, summary: "S" })));
    const deps = {
      readThread: async () => ({ summary: stored }) as never,
      readSettings: async () => ready,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      saveThreadSummary: async (_t: string, _s: string, summary: typeof stored) => {
        stored = summary;
        return "accepted" as const;
      },
    };
    // 10 user turns of 16,000 characters each (user + assistant).
    const history = big(20);
    expect((await compactHistory(input(history), deps)).compactedNow).toBe(true);
    const grown = [...history, ...big(22).slice(20)];
    expect((await compactHistory(input(grown), deps)).compactedNow).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does no request under the budget, or while the assistant is not ready", async () => {
    const fetchImpl = vi.fn();
    const deps = {
      readThread: async () => ({ summary: null }) as never,
      readSettings: async () => ready,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    const onSummarising = vi.fn();
    expect(await compactHistory({ ...input(big(3)), onSummarising }, deps)).toEqual({
      summary: null,
      compactedNow: false,
    });
    expect(onSummarising).not.toHaveBeenCalled();
    expect(
      await compactHistory(input(big(20)), {
        ...deps,
        readSettings: async () => ({ ...ready, apiKey: null }),
      }),
    ).toEqual({ summary: null, compactedNow: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
