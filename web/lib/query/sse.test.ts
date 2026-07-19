import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { LAST_EVENT_ID_HEADER } from "@/lib/bff/types";
import type { JobResponse } from "@/lib/bff/types";
import { applyFrameWithReconcile } from "@/lib/query/optimize";
import { optimizeKeys } from "@/lib/query/keys";
import {
  createSseParser,
  CursorTracker,
  type SseFrame,
  streamOptimizeEvents,
} from "@/lib/query/sse";

// A minimal full JobResponse to pre-seed the durable cache when a test needs the
// partial-frame apply path (rather than the cache-absent reconcile path).
const seededJob = (over: Partial<JobResponse> = {}): JobResponse =>
  ({
    id: "opt_1",
    state: "running",
    terminal: false,
    queue_position: null,
    result: null,
    error: null,
    controls: { cancellable: true, early_completion_available: true },
    links: { schedule: null },
    ...over,
  }) as JobResponse;

describe("createSseParser", () => {
  it("parses id/event/data frames and ignores keepalive comments", () => {
    const parser = createSseParser();
    const frames = parser.push(
      'id: v1.j.1\nevent: job.state_changed\ndata: {"state":"queued"}\n\n' +
        ": keepalive\n\n" +
        'id: v1.j.2\nevent: job.progressed\ndata: {"score":1}\n\n',
    );
    expect(frames).toEqual<SseFrame[]>([
      { id: "v1.j.1", event: "job.state_changed", data: '{"state":"queued"}' },
      { id: "v1.j.2", event: "job.progressed", data: '{"score":1}' },
    ]);
  });

  it("yields a null id for id-less frames", () => {
    const parser = createSseParser();
    expect(parser.push('event: job.progressed\ndata: {"score":2}\n\n')).toEqual([
      { id: null, event: "job.progressed", data: '{"score":2}' },
    ]);
  });

  it("buffers frames split across chunk boundaries", () => {
    const parser = createSseParser();
    expect(parser.push("id: v1.j.9\nevent: job.progressed\nda")).toEqual([]);
    expect(parser.push('ta: {"score":2}\n\n')).toEqual([
      { id: "v1.j.9", event: "job.progressed", data: '{"score":2}' },
    ]);
  });

  it("keeps opaque non-numeric ids verbatim (never parsed as numbers)", () => {
    const parser = createSseParser();
    const [frame] = parser.push("id: v1.YWJj.ZGVm\nevent: job.state_changed\ndata: {}\n\n");
    expect(frame.id).toBe("v1.YWJj.ZGVm");
  });

  it("tolerates CRLF line endings", () => {
    const parser = createSseParser();
    expect(parser.push("id: v1.j.3\r\nevent: job.result_available\r\ndata: {}\r\n\r\n")).toEqual([
      { id: "v1.j.3", event: "job.result_available", data: "{}" },
    ]);
  });
});

describe("CursorTracker (opaque dedupe, apply-before-commit)", () => {
  it("commit advances the cursor; isDuplicate flags an exact repeat of the last applied id", () => {
    const tracker = new CursorTracker();
    const f1 = { id: "v1.j.1", event: "e", data: "{}" };
    expect(tracker.isDuplicate(f1)).toBe(false);
    tracker.commit(f1);
    expect(tracker.lastEventId).toBe("v1.j.1");
    expect(tracker.isDuplicate({ id: "v1.j.1", event: "e", data: "{}" })).toBe(true);
    expect(tracker.isDuplicate({ id: "v1.j.2", event: "e", data: "{}" })).toBe(false);
  });

  it("does NOT advance the cursor when a frame is only checked, not committed", () => {
    const tracker = new CursorTracker("v1.j.5");
    expect(tracker.isDuplicate({ id: "v1.j.6", event: "e", data: "{}" })).toBe(false);
    // No commit ⇒ the cursor stays put, so a reconnect resends from the prior id.
    expect(tracker.lastEventId).toBe("v1.j.5");
  });

  it("treats id-less frames as never-duplicate and leaves the cursor unchanged on commit", () => {
    const tracker = new CursorTracker("v1.j.5");
    const idless = { id: null, event: "e", data: "{}" };
    expect(tracker.isDuplicate(idless)).toBe(false);
    tracker.commit(idless);
    expect(tracker.lastEventId).toBe("v1.j.5");
  });

  it("resumes from a supplied cursor and resets to the floor", () => {
    const tracker = new CursorTracker("v1.j.7");
    expect(tracker.lastEventId).toBe("v1.j.7");
    tracker.reset();
    expect(tracker.lastEventId).toBeNull();
  });
});

describe("streamOptimizeEvents", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function streamResponse(text: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("sends the last applied cursor as Last-Event-ID on reconnect", async () => {
    let sentHeader: string | null = null;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentHeader = new Headers(init?.headers).get(LAST_EVENT_ID_HEADER);
      return streamResponse("");
    }) as typeof fetch;

    const tracker = new CursorTracker("v1.j.42");
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: () => {},
    });
    expect(sentHeader).toBe("v1.j.42");
  });

  it("omits Last-Event-ID when there is no saved cursor", async () => {
    let hasHeader = true;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      hasHeader = new Headers(init?.headers).has(LAST_EVENT_ID_HEADER);
      return streamResponse("");
    }) as typeof fetch;

    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker: new CursorTracker(),
      onEvent: () => {},
    });
    expect(hasHeader).toBe(false);
  });

  it("dispatches new frames, dedupes exact-duplicate ids, and returns terminal on a terminal state frame", async () => {
    // A terminal frame must carry the FULL enriched state payload to be recognized.
    const terminalData =
      '{"state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}';
    globalThis.fetch = vi.fn(async () =>
      streamResponse(
        'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' +
          'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' + // exact duplicate → skipped
          `id: v1.j.2\nevent: job.state_changed\ndata: ${terminalData}\n\n`,
      ),
    ) as typeof fetch;

    const applied: string[] = [];
    const outcome = await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker: new CursorTracker(),
      onEvent: (f) => {
        applied.push(f.id ?? "∅");
      },
    });

    expect(applied).toEqual(["v1.j.1", "v1.j.2"]);
    expect(outcome).toEqual({
      type: "terminal",
      frame: { id: "v1.j.2", event: "job.state_changed", data: terminalData },
    });
  });

  it("returns error-response with the parsed body on a non-2xx (expired cursor)", async () => {
    const body = {
      error: {
        code: "event_cursor_expired",
        message: "Requested event history is no longer retained.",
        oldest_event_id: "v1.j.100",
      },
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const outcome = await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker: new CursorTracker(),
      onEvent: () => {},
    });
    expect(outcome).toEqual({ type: "error-response", status: 409, body });
  });

  it("does not commit the cursor when onEvent throws, so a reconnect resends and reapplies exactly once", async () => {
    const frameText = 'id: v1.j.7\nevent: job.progressed\ndata: {"p":1}\n\n';
    const sentCursors: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentCursors.push(new Headers(init?.headers).get(LAST_EVENT_ID_HEADER));
      return streamResponse(frameText);
    }) as typeof fetch;

    const tracker = new CursorTracker("v1.j.6");
    const applied: string[] = [];
    let shouldThrow = true;
    const onEvent = (frame: { id: string | null }) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("apply failed");
      }
      applied.push(frame.id ?? "∅");
    };

    // First connection: the frame handler throws → the cursor must NOT advance.
    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent,
      }),
    ).rejects.toThrow("apply failed");
    expect(tracker.lastEventId).toBe("v1.j.6");

    // Reconnect: the prior cursor is resent, the frame is reapplied successfully,
    // and only now does the cursor advance. No durable loss, no double apply.
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent,
    });
    expect(sentCursors).toEqual(["v1.j.6", "v1.j.6"]);
    expect(applied).toEqual(["v1.j.7"]);
    expect(tracker.lastEventId).toBe("v1.j.7");
  });

  it("returns closed when the stream ends without a terminal frame", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse('id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n'),
    ) as typeof fetch;

    const outcome = await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker: new CursorTracker(),
      onEvent: () => {},
    });
    expect(outcome).toEqual({ type: "closed" });
  });
});

// End-to-end fence: streamOptimizeEvents + the real applyFrameWithReconcile prove a
// malformed DURABLE frame reconciles (poll) before the cursor advances, and never
// advances when that reconcile fails.
describe("malformed durable event reconciliation through the stream fence", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function streamResponse(text: string): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  // A malformed non-terminal job.state_changed frame (invalid JSON).
  const malformedState = "id: v1.j.7\nevent: job.state_changed\ndata: {malformed\n\n";
  const onEvent = (client: QueryClient, reconcile: () => Promise<unknown>) => (frame: SseFrame) =>
    applyFrameWithReconcile(client, "opt_1", frame, reconcile);

  it("commits the cursor only AFTER a successful poll reconcile, exactly once (no infinite replay)", async () => {
    globalThis.fetch = vi.fn(async () => streamResponse(malformedState)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {});
    const tracker = new CursorTracker("v1.j.6");

    await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(tracker.lastEventId).toBe("v1.j.7"); // committed after reconcile
    // A permanently malformed retained event cannot loop forever: once committed, a
    // resend of the same id is an exact duplicate and is skipped.
    expect(
      tracker.isDuplicate({ id: "v1.j.7", event: "job.state_changed", data: "{malformed" }),
    ).toBe(true);
  });

  it("does NOT commit when the reconcile poll fails, so reconnect replays the prior cursor", async () => {
    globalThis.fetch = vi.fn(async () => streamResponse(malformedState)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const tracker = new CursorTracker("v1.j.6");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(tracker.lastEventId).toBe("v1.j.6"); // cursor unchanged → replay on reconnect
  });

  // Semantically invalid (but JSON-valid) durable payloads: unknown enum values,
  // out-of-domain queue, malformed supplied error. Each must reconcile, not apply.
  const frame = (id: string, event: string, data: object) =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const controls = { cancellable: false, early_completion_available: false };

  const invalidStateBase = {
    queue_position: null,
    cancel_requested: false,
    early_completion_requested: false,
    controls,
  };
  const semanticInvalids: Array<[string, string]> = [
    [
      "unknown state",
      frame("v1.s.1", "job.state_changed", {
        ...invalidStateBase,
        state: "bogus",
        terminal: false,
      }),
    ],
    [
      "negative queue_position",
      frame("v1.s.2", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
        queue_position: -1,
      }),
    ],
    [
      "fractional queue_position",
      frame("v1.s.3", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
        queue_position: 2.5,
      }),
    ],
    [
      "malformed error",
      frame("v1.s.4", "job.state_changed", {
        ...invalidStateBase,
        state: "failed",
        terminal: true,
        error: { code: "x" },
      }),
    ],
    [
      "live state marked terminal (running + terminal:true)",
      frame("v1.s.7", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: true,
      }),
    ],
    [
      "terminal state marked live (completed + terminal:false)",
      frame("v1.s.8", "job.state_changed", {
        ...invalidStateBase,
        state: "completed",
        terminal: false,
      }),
    ],
    [
      "unknown outcome",
      frame("v1.r.1", "job.result_available", {
        outcome: "bogus",
        score: 1,
        solver_status: "X",
        termination_reason: null,
        artifact_name: null,
      }),
    ],
    [
      "fractional score",
      frame("v1.r.2", "job.result_available", {
        outcome: "feasible",
        score: 1.5,
        solver_status: "X",
        termination_reason: null,
        artifact_name: null,
      }),
    ],
  ];

  it.each(semanticInvalids)(
    "a %s payload polls+replaces before committing the cursor (single commit)",
    async (_name, frameText) => {
      globalThis.fetch = vi.fn(async () => streamResponse(frameText)) as typeof fetch;
      const client = new QueryClient();
      const reconcile = vi.fn(async () => {});
      const tracker = new CursorTracker("v1.prev");

      const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      });

      expect(reconcile).toHaveBeenCalledOnce(); // reconciled, not applied
      expect(tracker.lastEventId).not.toBe("v1.prev"); // cursor advanced exactly once, after reconcile
      expect(outcome.type).not.toBe("terminal");
    },
  );

  it("an invalid state payload bearing terminal:true reconciles and does NOT close the stream", async () => {
    const invalidTerminal = frame("v1.s.5", "job.state_changed", {
      ...invalidStateBase,
      state: "bogus", // semantically invalid ⇒ terminal flag must NOT be trusted
      terminal: true,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(invalidTerminal)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {});
    const tracker = new CursorTracker("v1.prev");

    const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(outcome.type).toBe("closed"); // stream ended naturally, NOT a terminal close
    expect(tracker.lastEventId).toBe("v1.s.5"); // committed after reconcile
  });

  it("a failed reconcile on a semantically invalid frame retains the prior cursor for replay", async () => {
    const invalidOutcome = frame("v1.r.9", "job.result_available", {
      outcome: "bogus",
      score: 1,
      solver_status: "X",
      termination_reason: null,
      artifact_name: null,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(invalidOutcome)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const tracker = new CursorTracker("v1.prev");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(tracker.lastEventId).toBe("v1.prev"); // unchanged → replay on reconnect
  });

  it("a live state falsely bearing terminal:true reconciles and does NOT close the stream", async () => {
    // running + terminal:true is a state/terminal contradiction: the flag must not be
    // trusted to close the stream; true terminality comes from the authoritative poll.
    const liveMarkedTerminal = frame("v1.s.10", "job.state_changed", {
      ...invalidStateBase,
      state: "running",
      terminal: true,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(liveMarkedTerminal)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {});
    const tracker = new CursorTracker("v1.prev");

    const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(outcome.type).toBe("closed"); // NOT a terminal close from the bad frame
    expect(tracker.lastEventId).toBe("v1.s.10"); // committed once, after reconcile
  });

  it("a terminal state falsely marked non-terminal reconciles; a failed reconcile replays the prior cursor", async () => {
    // completed + terminal:false must reconcile (not apply as a live state); when the
    // reconcile poll fails, the cursor stays put so the frame replays on reconnect.
    const terminalMarkedLive = frame("v1.s.11", "job.state_changed", {
      ...invalidStateBase,
      state: "completed",
      terminal: false,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(terminalMarkedLive)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const tracker = new CursorTracker("v1.prev");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(tracker.lastEventId).toBe("v1.prev"); // unchanged → replay on reconnect
  });

  it("a VALID terminal state frame with an existing cache applies directly and closes terminal", async () => {
    const validTerminal = frame("v1.s.6", "job.state_changed", {
      ...invalidStateBase,
      state: "completed",
      terminal: true,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(validTerminal)) as typeof fetch;
    const client = new QueryClient();
    client.setQueryData(optimizeKeys.job("opt_1"), seededJob()); // full response present ⇒ partial patch applies
    const reconcile = vi.fn(async () => {});
    const tracker = new CursorTracker();

    const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).not.toHaveBeenCalled(); // valid + cached ⇒ applied, not reconciled
    expect(outcome.type).toBe("terminal");
    expect(tracker.lastEventId).toBe("v1.s.6");
    expect(client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.state).toBe("completed");
  });

  // Cache-absent durable frames: a valid partial frame cannot construct a full
  // JobResponse, so it MUST reconcile (poll + replace) before the cursor commits —
  // never a silent acknowledgement that strands the cache while the cursor advances.
  const noCacheDurables: Array<[string, string]> = [
    [
      "state_changed",
      frame("v1.n.1", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
      }),
    ],
    [
      "control_changed",
      frame("v1.n.2", "job.control_changed", { early_completion_requested: true }),
    ],
    [
      "result_available",
      frame("v1.n.3", "job.result_available", {
        outcome: "feasible",
        score: 42,
        solver_status: "FEASIBLE",
        termination_reason: null,
        artifact_name: "schedule.xlsx",
      }),
    ],
  ];

  it.each(noCacheDurables)(
    "a valid %s frame with NO cache polls+replaces before committing the cursor (single commit)",
    async (_name, frameText) => {
      globalThis.fetch = vi.fn(async () => streamResponse(frameText)) as typeof fetch;
      const client = new QueryClient(); // empty: no optimizeKeys.job("opt_1")
      const reconcile = vi.fn(async () => {
        client.setQueryData(optimizeKeys.job("opt_1"), seededJob());
      });
      const tracker = new CursorTracker("v1.prev");

      const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      });

      expect(reconcile).toHaveBeenCalledOnce(); // reconciled, not applied
      expect(tracker.lastEventId).not.toBe("v1.prev"); // cursor advanced exactly once, after reconcile
      expect(outcome.type).not.toBe("terminal");
    },
  );

  it("a valid TERMINAL state frame with NO cache and a FAILED poll cannot close and replays the prior cursor", async () => {
    // completed + terminal:true is a valid terminal frame, but with no cached response
    // it must reconcile first. When that poll fails, the frame handler rejects, the
    // cursor is NOT committed, and the stream cannot report a terminal close — the
    // frame replays on reconnect instead of permanently skipping the terminal state.
    const terminalNoCache = frame("v1.n.9", "job.state_changed", {
      ...invalidStateBase,
      state: "completed",
      terminal: true,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(terminalNoCache)) as typeof fetch;
    const client = new QueryClient(); // empty
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const tracker = new CursorTracker("v1.prev");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(tracker.lastEventId).toBe("v1.prev"); // unchanged → replay, no direct terminal close
  });
});
