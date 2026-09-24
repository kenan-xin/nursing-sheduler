import {
  AI_KEY_HEADER,
  AI_MODEL_HEADER,
  COPILOT_AGENT_ID,
  COPILOT_RUNTIME_BASE_PATH,
} from "./containment";

// Shared fixtures for the T01 runtime contract suite.
//
// The suite is deterministic and makes NO provider call: every OpenRouter request
// is served by `recordingOpenRouter`, which also records the exact outgoing payload
// so the credential/model/serial-tool-call contract is asserted against real bytes
// rather than against the call we intended to make.

/** Obviously-fake sentinel. Any appearance outside the recorded provider request is a leak. */
export const SENTINEL_KEY = "sk-or-v1-TEST-SENTINEL-DO-NOT-LEAK-0000000000";
export const TEST_MODEL = "anthropic/claude-sonnet-4.5";

export const ORIGIN = "https://ward.test";

export function routeUrl(suffix: string): string {
  return `${ORIGIN}${COPILOT_RUNTIME_BASE_PATH}${suffix}`;
}

export function infoRequest(headers: Record<string, string> = {}): Request {
  return new Request(routeUrl("/info"), { method: "GET", headers });
}

export type RunInput = {
  threadId: string;
  runId?: string;
  messages?: unknown[];
  tools?: unknown[];
  context?: { description: string; value: string }[];
};

export function runAgentInput(input: RunInput): Record<string, unknown> {
  return {
    threadId: input.threadId,
    runId: input.runId ?? `run-${input.threadId}`,
    state: {},
    messages: input.messages ?? [{ id: "m1", role: "user", content: "hello" }],
    tools: input.tools ?? [],
    context: input.context ?? [],
    forwardedProps: {},
  };
}

export function credentialHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    [AI_KEY_HEADER]: SENTINEL_KEY,
    [AI_MODEL_HEADER]: TEST_MODEL,
    ...extra,
  };
}

export function runRequest(
  input: RunInput,
  headers: Record<string, string> = credentialHeaders(),
  init: RequestInit = {},
): Request {
  return new Request(routeUrl(`/agent/${COPILOT_AGENT_ID}/run`), {
    method: "POST",
    headers,
    body: JSON.stringify(runAgentInput(input)),
    ...init,
  });
}

export function connectRequest(
  input: RunInput,
  headers: Record<string, string> = { "content-type": "application/json" },
): Request {
  return new Request(routeUrl(`/agent/${COPILOT_AGENT_ID}/connect`), {
    method: "POST",
    headers,
    body: JSON.stringify(runAgentInput(input)),
  });
}

export function stopRequest(threadId: string, headers: Record<string, string> = {}): Request {
  return new Request(routeUrl(`/agent/${COPILOT_AGENT_ID}/stop/${threadId}`), {
    method: "POST",
    headers,
  });
}

// --- SSE reading -----------------------------------------------------------

export type SseRead = {
  /** Raw response text, for leak scanning. */
  raw: string;
  /** Parsed AG-UI events. */
  events: Record<string, unknown>[];
};

/** Drains an SSE response to completion. */
export async function readSse(response: Response): Promise<SseRead> {
  const raw = await response.text();
  return { raw, events: parseSseEvents(raw) };
}

export function parseSseEvents(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    events.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return events;
}

export function eventTypes(events: Record<string, unknown>[]): string[] {
  return events.map((event) => String(event.type));
}

/**
 * Reads an SSE response incrementally, resolving once `predicate` is satisfied and
 * leaving the stream open. Used to observe a run mid-flight (connect, stop, abort)
 * without waiting for it to finish.
 */
export async function readSseUntil(
  response: Response,
  predicate: (events: Record<string, unknown>[]) => boolean,
  timeoutMs = 5_000,
): Promise<{ events: Record<string, unknown>[]; detach: () => void }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  while (!predicate(events)) {
    if (Date.now() > deadline) {
      await reader.cancel();
      throw new Error(`SSE predicate not satisfied; saw ${JSON.stringify(eventTypes(events))}`);
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const complete = buffer.lastIndexOf("\n");
    if (complete === -1) continue;
    events.push(...parseSseEvents(buffer.slice(0, complete)));
    buffer = buffer.slice(complete + 1);
  }

  return {
    events,
    // Fire-and-forget on purpose. `reader.cancel()` resolves only once the WHOLE
    // upstream chain has torn down, and a still-streaming provider run does not
    // tear down until it is stopped -- awaiting it here would deadlock the test
    // before it ever reaches the stop it is asserting on.
    detach: () => {
      void reader.cancel().catch(() => {});
    },
  };
}

// --- OpenRouter fixture ----------------------------------------------------

export type RecordedProviderCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ChatChunk = Record<string, unknown>;

/** One assistant text delta then a clean stop. */
export function textCompletion(text: string): ChatChunk[] {
  return [chunk({ role: "assistant", content: text }), chunk({}, "stop")];
}

/** One serial tool call, the shape a frontend tool round-trip starts with. */
export function toolCallCompletion(name: string, args: string, id = "call_1"): ChatChunk[] {
  return [
    chunk({
      role: "assistant",
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, "tool_calls"),
  ];
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): ChatChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: TEST_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export type OpenRouterFixture = {
  fetch: typeof globalThis.fetch;
  calls: RecordedProviderCall[];
  /** Resolves once the provider request has been received. */
  firstCall: Promise<RecordedProviderCall>;
};

export type OpenRouterFixtureOptions = {
  chunks?: ChatChunk[];
  /** Milliseconds between chunks, so a run can be observed mid-flight. */
  chunkDelayMs?: number;
  /** Never emit a terminal chunk, so the run stays active until stopped. */
  hang?: boolean;
};

/**
 * A fake OpenRouter Chat Completions endpoint. Records the exact outgoing request
 * and streams back canned SSE. Honours the AbortSignal it is handed, which is how
 * the suite proves abort propagation all the way from `stop` to the provider call.
 */
export function recordingOpenRouter(options: OpenRouterFixtureOptions = {}): OpenRouterFixture {
  const calls: RecordedProviderCall[] = [];
  let resolveFirst: (call: RecordedProviderCall) => void;
  const firstCall = new Promise<RecordedProviderCall>((resolve) => {
    resolveFirst = resolve;
  });

  const chunks = options.chunks ?? textCompletion("ok");
  const delay = options.chunkDelayMs ?? 0;

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    const call: RecordedProviderCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    resolveFirst(call);

    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      // Deliberately NOT an async `start`: a ReadableStream whose start() never
      // settles is never "started", so a `hang: true` fixture would stall the whole
      // pipeline instead of streaming its prefix and then holding the run open.
      start(controller) {
        void (async () => {
          const encoder = new TextEncoder();
          try {
            for (const c of chunks) {
              if (signal?.aborted) break;
              if (delay > 0) await sleep(delay, signal);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
            }
            if (options.hang) {
              await never(signal);
            } else if (!signal?.aborted) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            controller.close();
          } catch {
            // Abort is the expected exit; close rather than surfacing a spurious error.
            controller.close();
          }
        })();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  return { fetch: fetchImpl, calls, firstCall };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function never(signal?: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
