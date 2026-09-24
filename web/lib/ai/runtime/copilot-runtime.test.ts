import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AI_DETACH_REASON_INSTANCE_MISMATCH,
  AI_ERROR_CREDENTIALS_REQUIRED,
  AI_KEY_HEADER,
  COPILOT_AGENT_ID,
  OPENROUTER_BASE_URL,
  RUNTIME_INSTANCE_HEADER,
} from "./containment";
import { createSchedulerCopilotRuntime, type SchedulerCopilotRuntime } from "./handler";
import {
  SENTINEL_KEY,
  TEST_MODEL,
  connectRequest,
  credentialHeaders,
  eventTypes,
  infoRequest,
  readSse,
  readSseUntil,
  recordingOpenRouter,
  routeUrl,
  runRequest,
  stopRequest,
  textCompletion,
  toolCallCompletion,
  type OpenRouterFixture,
  type OpenRouterFixtureOptions,
} from "./test-support";

// T01 runtime/deployment contract, exercised through the real mounted handler with
// the locked package family. Nothing here is mocked at the CopilotKit boundary: the
// only fixture is the OpenRouter endpoint itself, so every assertion is about the
// behaviour the shipped runtime actually produces.

// Any egress that is not the injected OpenRouter fixture is a containment failure
// (telemetry, license check, Scarf). Failing loudly beats a silently-networked suite.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new Error(`unexpected network egress from the AI runtime: ${url}`);
  }) as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// Console is captured so the credential-leak scan covers server logs, not just
// response bodies.
let consoleOutput: string[] = [];
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  consoleOutput = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(
          args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(" "),
        );
      }),
    );
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  consoleSpies.length = 0;
});

let runtimes: SchedulerCopilotRuntime[] = [];
afterEach(() => {
  runtimes = [];
});

function launch(options: OpenRouterFixtureOptions & { instanceId?: string } = {}): {
  runtime: SchedulerCopilotRuntime;
  provider: OpenRouterFixture;
} {
  const provider = recordingOpenRouter(options);
  const runtime = createSchedulerCopilotRuntime({
    fetch: provider.fetch,
    instanceId:
      options.instanceId ?? `instance-${runtimes.length}-${Math.random().toString(16).slice(2)}`,
  });
  runtimes.push(runtime);
  return { runtime, provider };
}

function assertContained(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
}

describe("runtime info", () => {
  it("reports the locked agent, disabled telemetry, and the launch instance id", async () => {
    const { runtime } = launch();

    const response = await runtime.handler(infoRequest());
    expect(response.status).toBe(200);
    assertContained(response);
    expect(response.headers.get(RUNTIME_INSTANCE_HEADER)).toBe(runtime.instanceId);

    const info = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(info.agents as object)).toEqual([COPILOT_AGENT_ID]);
    expect(info.telemetryDisabled).toBe(true);
    expect(info.mode).toBe("sse");
    expect(info.runtimeInstanceId).toBe(runtime.instanceId);
    // The transient runner deliberately does not implement local thread endpoints,
    // so the runtime advertises no server-side thread list or inspection surface.
    expect(info.threadEndpoints).toEqual({
      list: false,
      inspect: false,
      mutations: false,
      realtimeMetadata: false,
    });
  });

  it("is callable without a credential", async () => {
    const { runtime, provider } = launch();
    const response = await runtime.handler(infoRequest());
    expect(response.status).toBe(200);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("run", () => {
  it("rejects a keyless run at the HTTP boundary without calling the provider", async () => {
    const { runtime, provider } = launch();

    const response = await runtime.handler(
      runRequest({ threadId: "t1" }, { "content-type": "application/json" }),
    );

    expect(response.status).toBe(400);
    assertContained(response);
    expect(await response.json()).toEqual({ error: AI_ERROR_CREDENTIALS_REQUIRED });
    expect(provider.calls).toHaveLength(0);
    expect(runtime.runner.activeRunCount()).toBe(0);
  });

  it("streams a run on the caller's explicit thread id and settles terminally", async () => {
    const { runtime, provider } = launch({ chunks: textCompletion("hello ward") });

    const response = await runtime.handler(
      runRequest({ threadId: "thread-explicit", runId: "run-7" }),
    );
    expect(response.status).toBe(200);
    assertContained(response);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const { events } = await readSse(response);
    expect(eventTypes(events)).toContain("RUN_STARTED");
    expect(eventTypes(events)).toContain("RUN_FINISHED");
    expect(eventTypes(events)).not.toContain("RUN_ERROR");

    const started = events.find((e) => e.type === "RUN_STARTED")!;
    expect(started.threadId).toBe("thread-explicit");
    expect(started.runId).toBe("run-7");

    // Terminal settlement erases the entry and its buffered events.
    expect(runtime.runner.activeRunCount()).toBe(0);
    expect(await runtime.runner.isRunning({ threadId: "thread-explicit" })).toBe(false);

    expect(provider.calls).toHaveLength(1);
  });

  it("builds the transient OpenRouter client from the request headers", async () => {
    const { runtime, provider } = launch();

    await readSse(await runtime.handler(runRequest({ threadId: "t2" })));

    const call = provider.calls[0];
    expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(call.headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    expect(call.body.model).toBe(TEST_MODEL);
    // Serial tool calling: the plan's `parallel_tool_calls: false`, proven on the wire.
    expect(call.body.parallel_tool_calls).toBe(false);
    expect(call.body.stream).toBe(true);
  });

  it("sends the turn's context to the model as the system prompt", async () => {
    // THE DEFECT THIS PINS. The browser attaches the assistant's standing instructions,
    // the scenario document and the current screen as AG-UI `context` on every hop, but
    // factory mode hands the run input to our own `streamText` call, and that call used
    // to convert only `messages`. The model ran with no system prompt at all -- no
    // authority statement, no schedule -- and after a feasibility tool result it ended
    // the turn with no text.
    const { runtime, provider } = launch();

    await readSse(
      await runtime.handler(
        runRequest({
          threadId: "t-context",
          context: [
            { description: "How to behave", value: "propose-then-apply" },
            { description: "The scenario", value: '{"staff":["Ana"]}' },
          ],
        }),
      ),
    );

    const messages = provider.calls[0].body.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("How to behave");
    expect(messages[0].content).toContain("propose-then-apply");
    expect(messages[0].content).toContain('{"staff":["Ana"]}');
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "hello" });
  });

  it("sends no system prompt when the turn carries no context", async () => {
    const { runtime, provider } = launch();
    await readSse(await runtime.handler(runRequest({ threadId: "t-no-context" })));
    const messages = provider.calls[0].body.messages as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("converts frontend tools into provider tool definitions and streams the call back", async () => {
    const { runtime, provider } = launch({
      chunks: toolCallCompletion("previewStaffingChange", '{"cardId":"c1"}'),
    });

    const response = await runtime.handler(
      runRequest({
        threadId: "t-tools",
        tools: [
          {
            name: "previewStaffingChange",
            description: "Prepare a typed proposal",
            parameters: {
              type: "object",
              properties: { cardId: { type: "string", description: "card" } },
              required: ["cardId"],
            },
          },
        ],
      }),
    );

    const { events } = await readSse(response);
    const types = eventTypes(events);
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_END");

    const start = events.find((e) => e.type === "TOOL_CALL_START")!;
    expect(start.toolCallName).toBe("previewStaffingChange");

    const tools = provider.calls[0].body.tools as { function: { name: string } }[];
    expect(tools.map((t) => t.function.name)).toEqual(["previewStaffingChange"]);
  });
});

describe("connect", () => {
  it("replays the live buffer of a currently active run and then follows it", async () => {
    const { runtime } = launch({
      chunks: textCompletion("streaming"),
      chunkDelayMs: 30,
      hang: true,
    });

    const runResponse = await runtime.handler(runRequest({ threadId: "t-live" }));
    const live = await readSseUntil(runResponse, (events) =>
      eventTypes(events).includes("TEXT_MESSAGE_CHUNK"),
    );

    const connectResponse = await runtime.handler(connectRequest({ threadId: "t-live" }));
    expect(connectResponse.status).toBe(200);
    assertContained(connectResponse);

    const attached = await readSseUntil(connectResponse, (events) =>
      eventTypes(events).includes("RUN_STARTED"),
    );
    // The buffer replays from the start of the still-active run.
    expect(eventTypes(attached.events)[0]).toBe("RUN_STARTED");

    live.detach();
    attached.detach();
    await runtime.handler(stopRequest("t-live"));
  });

  it("returns an empty non-leaking stream for an unknown or cleared thread", async () => {
    const { runtime, provider } = launch();

    const response = await runtime.handler(connectRequest({ threadId: "never-existed" }));

    // Explicitly NOT a 404, and explicitly not another thread's history.
    expect(response.status).toBe(200);
    assertContained(response);
    const { events } = await readSse(response);
    expect(events).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("returns nothing after the run has terminally settled", async () => {
    const { runtime } = launch();

    await readSse(await runtime.handler(runRequest({ threadId: "t-settled" })));
    const { events } = await readSse(
      await runtime.handler(connectRequest({ threadId: "t-settled" })),
    );

    expect(events).toEqual([]);
  });

  it("detaches a connect that claims a different launch instance", async () => {
    const { runtime } = launch({ hang: true, chunks: textCompletion("x") });

    const runResponse = await runtime.handler(runRequest({ threadId: "t-mismatch" }));
    const live = await readSseUntil(runResponse, (e) => eventTypes(e).includes("RUN_STARTED"));

    const stale = await runtime.handler(
      connectRequest(
        { threadId: "t-mismatch" },
        { "content-type": "application/json", [RUNTIME_INSTANCE_HEADER]: "a-previous-launch" },
      ),
    );
    const { events } = await readSse(stale);
    expect(events).toEqual([]);

    // The run itself is untouched by another instance's stale connect.
    expect(await runtime.runner.isRunning({ threadId: "t-mismatch" })).toBe(true);

    live.detach();
    await runtime.handler(stopRequest("t-mismatch"));
  });
});

describe("stop", () => {
  it("aborts the in-flight provider call and is idempotent", async () => {
    const { runtime, provider } = launch({ hang: true, chunks: textCompletion("partial") });

    const runResponse = await runtime.handler(runRequest({ threadId: "t-stop" }));
    const live = await readSseUntil(runResponse, (e) => eventTypes(e).includes("RUN_STARTED"));
    const providerCall = await provider.firstCall;

    expect(await runtime.runner.isRunning({ threadId: "t-stop" })).toBe(true);
    expect(providerCall.signal?.aborted).toBe(false);

    const first = await runtime.handler(stopRequest("t-stop"));
    expect(first.status).toBe(200);
    assertContained(first);
    expect(await first.json()).toMatchObject({ stopped: true });

    // AbortSignal propagation: CopilotKit's abort reached the application's provider call.
    expect(providerCall.signal?.aborted).toBe(true);
    expect(runtime.runner.activeRunCount()).toBe(0);

    const second = await runtime.handler(stopRequest("t-stop"));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ stopped: false });

    live.detach();
  });

  it("reports a missing run as a settled not-stopped outcome, never a 404", async () => {
    const { runtime } = launch();

    const response = await runtime.handler(stopRequest("no-such-thread"));

    expect(response.status).toBe(200);
    assertContained(response);
    expect(await response.json()).toMatchObject({ stopped: false });
  });

  it("detaches a stop that claims a different launch instance without touching the run", async () => {
    const { runtime } = launch({ hang: true, chunks: textCompletion("x") });

    const runResponse = await runtime.handler(runRequest({ threadId: "t-stop-mismatch" }));
    const live = await readSseUntil(runResponse, (e) => eventTypes(e).includes("RUN_STARTED"));

    const response = await runtime.handler(
      stopRequest("t-stop-mismatch", { [RUNTIME_INSTANCE_HEADER]: "a-previous-launch" }),
    );

    expect(response.status).toBe(200);
    assertContained(response);
    expect(await response.json()).toEqual({
      stopped: false,
      detached: true,
      reason: AI_DETACH_REASON_INSTANCE_MISMATCH,
    });
    expect(await runtime.runner.isRunning({ threadId: "t-stop-mismatch" })).toBe(true);

    await live.detach();
    await runtime.handler(stopRequest("t-stop-mismatch"));
  });
});

describe("restart and instance identity", () => {
  it("detaches a thread from a previous launch without replay, retry, or 404", async () => {
    const first = launch();
    await readSse(await first.runtime.handler(runRequest({ threadId: "t-restart" })));

    // A restart is a fresh process: new runtime, new runner, new instance id.
    const second = launch();
    expect(second.runtime.instanceId).not.toBe(first.runtime.instanceId);

    const connect = await second.runtime.handler(
      connectRequest(
        { threadId: "t-restart" },
        { "content-type": "application/json", [RUNTIME_INSTANCE_HEADER]: first.runtime.instanceId },
      ),
    );
    expect(connect.status).toBe(200);
    expect((await readSse(connect)).events).toEqual([]);

    const stop = await second.runtime.handler(
      stopRequest("t-restart", { [RUNTIME_INSTANCE_HEADER]: first.runtime.instanceId }),
    );
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ stopped: false });

    // No model retry was triggered by any detachment path.
    expect(second.provider.calls).toHaveLength(0);
  });

  it("stamps the launch instance id on every runtime response", async () => {
    const { runtime } = launch();

    for (const request of [infoRequest(), stopRequest("anything")]) {
      const response = await runtime.handler(request);
      expect(response.headers.get(RUNTIME_INSTANCE_HEADER)).toBe(runtime.instanceId);
    }
  });
});

describe("credential containment", () => {
  it("never emits the key in a response, a stream, a cookie, or a log", async () => {
    const { runtime, provider } = launch({
      chunks: toolCallCompletion("previewStaffingChange", '{"cardId":"c1"}'),
    });

    const responses: Response[] = [
      await runtime.handler(infoRequest(credentialHeaders())),
      await runtime.handler(runRequest({ threadId: "t-leak" })),
      await runtime.handler(connectRequest({ threadId: "t-leak-unknown" })),
      await runtime.handler(stopRequest("t-leak", credentialHeaders())),
    ];

    const surfaces: string[] = [];
    for (const response of responses) {
      assertContained(response);
      surfaces.push(JSON.stringify([...response.headers.entries()]));
      surfaces.push(await response.text());
    }
    surfaces.push(consoleOutput.join("\n"));

    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL_KEY);
    }

    // The key did reach the provider request -- that is the whole point of BYO --
    // and nowhere else.
    expect(provider.calls[0].headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    expect(JSON.stringify(provider.calls[0].body)).not.toContain(SENTINEL_KEY);
  });

  it("denies the key header from CopilotKit's inbound header forwarding", async () => {
    const { runtime } = launch({ hang: true, chunks: textCompletion("x") });
    const forwarded: (Record<string, string> | undefined)[] = [];
    const realConnect = runtime.runner.connect.bind(runtime.runner);
    vi.spyOn(runtime.runner, "connect").mockImplementation((request) => {
      forwarded.push(request.headers);
      return realConnect(request);
    });

    const runResponse = await runtime.handler(runRequest({ threadId: "t-forward" }));
    const live = await readSseUntil(runResponse, (e) => eventTypes(e).includes("RUN_STARTED"));

    const connect = await runtime.handler(
      connectRequest({ threadId: "t-forward" }, credentialHeaders({ "x-ward-trace": "trace-1" })),
    );

    expect(forwarded).toHaveLength(1);
    const headers = forwarded[0] ?? {};
    expect(Object.keys(headers)).not.toContain(AI_KEY_HEADER);
    expect(JSON.stringify(headers)).not.toContain(SENTINEL_KEY);
    // Ordinary custom headers still forward, so the denial is targeted, not blanket.
    expect(headers["x-ward-trace"]).toBe("trace-1");

    void connect.body?.cancel().catch(() => {});
    live.detach();
    await runtime.handler(stopRequest("t-forward"));
  });
});

describe("routing surface", () => {
  it("does not expose server-side thread history endpoints", async () => {
    const { runtime } = launch();

    // The SSE runtime has no thread backend; these must not return stored history.
    const list = await runtime.handler(new Request(routeUrl("/threads"), { method: "GET" }));
    expect(list.status).toBeGreaterThanOrEqual(400);

    const messages = await runtime.handler(
      new Request(routeUrl("/threads/t-any/messages"), { method: "GET" }),
    );
    expect(messages.status).toBeGreaterThanOrEqual(400);
  });

  it("contains unmatched paths too", async () => {
    const { runtime } = launch();
    const response = await runtime.handler(new Request(routeUrl("/nope"), { method: "GET" }));
    expect(response.status).toBe(404);
    assertContained(response);
  });
});
