import type { EvalCase } from "./case";
import type { Baseline } from "./report";
// Cost accounting at the provider fetch seam, and the hard stop.
import type { TurnLatency, Usage } from "./trial";

/** USD per million tokens. Check openrouter.ai/models before a release run. */
export const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
  "openai/gpt-5-mini": { input: 0.25, output: 2 },
};
const FALLBACK = { input: 3, output: 15 };

export const BUDGET_ERROR = "eval budget exhausted";

const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  estimated: false,
};
export const plus = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  usd: a.usd + b.usd,
  estimated: a.estimated || b.estimated,
});

// ponytail: the check runs before a hop and usage lands after its body resolves, so a hop
// already in flight (or a parallel one) can go over by one hop. Reserve an estimate up front
// if that overshoot ever matters.
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

/**
 * A trial the budget cut short: it ended over (the driver stops on `over`, and the judge
 * would be refused) or one of its calls was refused. Not a verdict on the assistant.
 */
export const cutByBudget = (ledger: Ledger, refusedBefore: number): boolean =>
  ledger.over || ledger.refused > refusedBefore;

// ponytail: flat guess for a case the baseline has not measured.
export const FALLBACK_TRIAL_USD = 0.3;

type Planned = Pick<EvalCase, "id" | "tags" | "trials">;

/** EVAL_CASES as trimmed ids, or null when unset. A typo fails loudly, before any spend. */
export function parseCaseIds(raw: string | undefined, all: Planned[]): string[] | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`EVAL_CASES names no case: ${unknown.join(", ")}`);
  return ids;
}

export const selectCases = <C extends Planned>(
  cases: C[],
  tags: string[] | null,
  ids: string[] | null = null,
): C[] =>
  cases.filter(
    (c) => (!tags || c.tags.some((t) => tags.includes(t))) && (!ids || ids.includes(c.id)),
  );

/** Expected cost of the cases, at each one's measured cost a trial in the baseline. */
export function plannedUsd(cases: Planned[], trials: number, baseline: Baseline): number {
  return cases.reduce((sum, c) => {
    const b = baseline.cases[c.id];
    const perTrial = b && b.trials > 0 ? b.usd / b.trials : FALLBACK_TRIAL_USD;
    return sum + (c.trials ?? trials) * perTrial;
  }, 0);
}

/** One provider call on the `performance.now()` clock. */
export interface HopTiming {
  start: number;
  /** The first streamed text or tool-call delta; reasoning and role chunks do not count. */
  firstToken: number | null;
  end: number;
}

export interface Recorder {
  fetch: typeof fetch;
  hops(): number;
  settled(): Promise<Usage>;
  timings(): HopTiming[];
}

/** A non-empty `content` string or a `tool_calls` list: something the user sees. */
const VISIBLE = /"(?:content":\s*"[^"]|tool_calls":\s*\[)/;

/** Each turn's wait: to its first hop's visible token, and to its end. */
export function turnLatencies(
  windows: { start: number; end: number }[],
  hops: HopTiming[],
): TurnLatency[] {
  return windows.map((w) => {
    const first = hops.find((h) => h.start >= w.start && h.start <= w.end && h.firstToken !== null);
    return {
      ttftMs: first ? Math.round(first.firstToken! - w.start) : null,
      ms: Math.round(w.end - w.start),
    };
  });
}

function priced(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING_PER_MTOK[model] ?? FALLBACK;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

type UsageChunk = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
};

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
  const timings: HopTiming[] = [];
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (ledger.over) {
      ledger.refused += 1;
      throw new Error(BUDGET_ERROR);
    }
    hops += 1;
    const requestBytes = typeof init?.body === "string" ? init.body.length : 0;
    const timing: HopTiming = {
      start: performance.now(),
      firstToken: null,
      end: 0,
    };
    timings.push(timing);
    const response = await base(input, init);
    // The clone streams alongside the caller's read, so its chunk times are the caller's.
    const read = async (): Promise<string> => {
      if (!response.body) return "";
      const reader = response.clone().body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (timing.firstToken === null && VISIBLE.test(text)) timing.firstToken = performance.now();
      }
      timing.end = performance.now();
      return text + decoder.decode();
    };
    pending.push(
      read().then((text) => {
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
    timings: () => timings,
    settled: async () => {
      await Promise.allSettled(pending);
      return trial;
    },
  };
}
