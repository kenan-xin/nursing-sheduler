// Cost accounting at the provider fetch seam, and the hard stop.
import type { Usage } from "./trial";

/** USD per million tokens. Check openrouter.ai/models before a release run. */
export const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
  "openai/gpt-5-mini": { input: 0.25, output: 2 },
};
const FALLBACK = { input: 3, output: 15 };

export const BUDGET_ERROR = "eval budget exhausted";

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, usd: 0, estimated: false };
export const plus = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  usd: a.usd + b.usd,
  estimated: a.estimated || b.estimated,
});

export class Ledger {
  total: Usage = ZERO;
  /** Calls refused once over: a trial that saw one was cut by the budget, not failed. */
  refused = 0;
  constructor(readonly maxUsd: number) {}
  add(usage: Usage): void {
    this.total = plus(this.total, usage);
  }
  get over(): boolean {
    return this.total.usd >= this.maxUsd;
  }
}

export interface Recorder {
  fetch: typeof fetch;
  hops(): number;
  settled(): Promise<Usage>;
}

function priced(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING_PER_MTOK[model] ?? FALLBACK;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

type UsageChunk = { prompt_tokens?: number; completion_tokens?: number; cost?: number };

function usageOf(model: string, requestBytes: number, responseText: string): Usage {
  let found: UsageChunk | null = null;
  for (const line of responseText.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const chunk = JSON.parse(line.slice(6)) as { usage?: UsageChunk };
      if (chunk.usage) found = chunk.usage;
    } catch {
      // A non-JSON data line carries no usage.
    }
  }
  if (!found) {
    // A non-streamed call (the judge, the simulated user) answers with one JSON body.
    try {
      found = (JSON.parse(responseText) as { usage?: UsageChunk }).usage ?? null;
    } catch {
      // Not JSON either: estimated below.
    }
  }
  if (found?.prompt_tokens !== undefined) {
    const inputTokens = found.prompt_tokens;
    const outputTokens = found.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      usd: found.cost ?? priced(model, inputTokens, outputTokens),
      estimated: false,
    };
  }
  // ponytail: 4 bytes per token; only used when the provider reports nothing.
  const inputTokens = Math.round(requestBytes / 4);
  const outputTokens = Math.round(responseText.length / 4);
  return {
    inputTokens,
    outputTokens,
    usd: priced(model, inputTokens, outputTokens),
    estimated: true,
  };
}

export function recordingFetch(
  model: string,
  ledger: Ledger,
  base: typeof fetch = globalThis.fetch,
): Recorder {
  let hops = 0;
  let trial = ZERO;
  const pending: Promise<void>[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (ledger.over) {
      ledger.refused += 1;
      throw new Error(BUDGET_ERROR);
    }
    hops += 1;
    const requestBytes = typeof init?.body === "string" ? init.body.length : 0;
    const response = await base(input, init);
    pending.push(
      response
        .clone()
        .text()
        .then((text) => {
          const usage = usageOf(model, requestBytes, text);
          trial = plus(trial, usage);
          ledger.add(usage);
        }),
    );
    return response;
  }) as typeof fetch;
  return {
    fetch: wrapped,
    hops: () => hops,
    settled: async () => {
      await Promise.allSettled(pending);
      return trial;
    },
  };
}
