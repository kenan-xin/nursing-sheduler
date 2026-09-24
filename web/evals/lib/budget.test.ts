import { describe, expect, it } from "vitest";
import { BUDGET_ERROR, Ledger, recordingFetch } from "./budget";

const sse = (...objects: unknown[]) =>
  objects.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + "data: [DONE]\n\n";

const fakeBase = (body: string) =>
  (async () =>
    new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;

describe("recordingFetch", () => {
  it("reads usage and cost from the final chunk", async () => {
    const ledger = new Ledger(5);
    const body = sse(
      { choices: [{ delta: { content: "hi" } }] },
      { usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0042 } },
    );
    const rec = recordingFetch("anthropic/claude-sonnet-4.5", ledger, fakeBase(body));
    const res = await rec.fetch("https://x.test/chat", { method: "POST", body: "{}" });
    await res.text();
    const usage = await rec.settled();
    expect(usage).toEqual({ inputTokens: 1000, outputTokens: 100, usd: 0.0042, estimated: false });
    expect(rec.hops()).toBe(1);
    expect(ledger.total.usd).toBeCloseTo(0.0042);
  });

  it("counts every call it refuses once the ledger is over", async () => {
    const ledger = new Ledger(0.001);
    ledger.add({ inputTokens: 0, outputTokens: 0, usd: 0.002, estimated: false });
    const rec = recordingFetch("openai/gpt-5-mini", ledger, fakeBase(sse()));
    await expect(rec.fetch("https://x.test")).rejects.toThrow(BUDGET_ERROR);
    await expect(rec.fetch("https://x.test")).rejects.toThrow(BUDGET_ERROR);
    expect(ledger.refused).toBe(2);
  });

  it("prices tokens from the table when the provider sends no cost", async () => {
    const ledger = new Ledger(5);
    const body = sse({ usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } });
    const rec = recordingFetch("anthropic/claude-sonnet-4.5", ledger, fakeBase(body));
    await (await rec.fetch("https://x.test", { method: "POST", body: "{}" })).text();
    expect((await rec.settled()).usd).toBeCloseTo(3);
  });

  it("reads usage from a plain JSON body (a non-streamed judge or user call)", async () => {
    const ledger = new Ledger(5);
    const body = JSON.stringify({ usage: { prompt_tokens: 2000, completion_tokens: 50 } });
    const rec = recordingFetch("openai/gpt-5-mini", ledger, fakeBase(body));
    await (await rec.fetch("https://x.test", { method: "POST", body: "{}" })).text();
    const usage = await rec.settled();
    expect(usage).toMatchObject({ inputTokens: 2000, outputTokens: 50, estimated: false });
    expect(ledger.total.usd).toBeCloseTo(0.0006);
  });

  it("estimates from byte length when there is no usage at all", async () => {
    const ledger = new Ledger(5);
    const rec = recordingFetch(
      "anthropic/claude-sonnet-4.5",
      ledger,
      fakeBase(sse({ choices: [] })),
    );
    await (await rec.fetch("https://x.test", { method: "POST", body: "x".repeat(4000) })).text();
    const usage = await rec.settled();
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBe(1000);
  });

  it("refuses a new hop once the ledger is over budget", async () => {
    const ledger = new Ledger(0.001);
    ledger.add({ inputTokens: 0, outputTokens: 0, usd: 0.01, estimated: false });
    const rec = recordingFetch("anthropic/claude-sonnet-4.5", ledger, fakeBase(sse()));
    await expect(rec.fetch("https://x.test", { method: "POST", body: "{}" })).rejects.toThrow(
      BUDGET_ERROR,
    );
  });
});
