import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { LAST_EVENT_ID_HEADER } from "@/lib/bff/types";
import type { JobResponse } from "@/lib/bff/types";
import { applyFrameWithReconcile } from "@/lib/query/optimize";
import { optimizeKeys } from "@/lib/query/keys";
import {
  createResumeCursor,
  type ResumeCursor,
  type SseFrame,
  streamOptimizeEvents,
  SseCursorOverflowError,
} from "@/lib/query/sse";
import { MAX_CURSOR_BYTES } from "@/lib/query/sse-limits";

// Build a resume-cursor handle from a restored cursor (the real public seam). A raw
// oversized string is rejected at runtime by `createResumeCursor` itself.
const track = (initial: string | null = null): ResumeCursor => createResumeCursor(initial).cursor;

// Observe the cursor a handle currently retains via the REAL surface: run one no-op
// stream and read back the `Last-Event-ID` header the transport would replay. Saves and
// restores the ambient fetch mock so it does not disturb the caller's own stubbing.
async function retainedCursor(tracker: ResumeCursor): Promise<string | null> {
  const prev = globalThis.fetch;
  let sent: string | null = null;
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent = new Headers(init?.headers).get(LAST_EVENT_ID_HEADER);
    return new Response(new ReadableStream<Uint8Array>({ start: (c) => c.close() }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: () => {},
    });
  } finally {
    globalThis.fetch = prev;
  }
  return sent;
}

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

const enc = (s: string) => new TextEncoder().encode(s);

function byteStreamResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// SSE SYNTAX/FRAMING is owned by `eventsource-parser`; these are the
// INTEGRATION behaviors the durable adapter depends on (not a re-run of the
// library's conformance suite): the bounded raw-byte feed + adapter must round
// -trip real frames, split delimiters, and multibyte sequences, and must NOT
// re-introduce the old custom framer's CRLF-split corruption.
describe("SSE framing through the maintained parser (integration)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function collect(chunks: Uint8Array[], initial: string | null = null) {
    globalThis.fetch = vi.fn(async () => byteStreamResponse(chunks)) as typeof fetch;
    const tracker = track(initial);
    const applied: SseFrame[] = [];
    const outcome = await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: (f) => {
        applied.push(f);
      },
    });
    return { applied, outcome, tracker };
  }

  it("parses id/event/data frames and ignores keepalive comments", async () => {
    const { applied } = await collect([
      enc(
        'id: v1.j.1\nevent: job.state_changed\ndata: {"state":"queued"}\n\n' +
          ": keepalive\n\n" +
          'id: v1.j.2\nevent: job.progressed\ndata: {"score":1}\n\n',
      ),
    ]);
    expect(applied).toEqual<SseFrame[]>([
      { id: "v1.j.1", event: "job.state_changed", data: '{"state":"queued"}' },
      { id: "v1.j.2", event: "job.progressed", data: '{"score":1}' },
    ]);
  });

  it('yields a null id for id-less frames and defaults a missing event name to "message"', async () => {
    const withEvent = await collect([enc('event: job.progressed\ndata: {"score":2}\n\n')]);
    expect(withEvent.applied).toEqual([{ id: null, event: "job.progressed", data: '{"score":2}' }]);
    const noEvent = await collect([enc('data: {"score":3}\n\n')]);
    expect(noEvent.applied).toEqual([{ id: null, event: "message", data: '{"score":3}' }]);
  });

  it("keeps opaque non-numeric cursors verbatim (never parsed as numbers)", async () => {
    const { applied } = await collect([
      enc("id: v1.YWJj.ZGVm\nevent: job.state_changed\ndata: {}\n\n"),
    ]);
    expect(applied[0].id).toBe("v1.YWJj.ZGVm");
  });

  it("handles CRLF line endings within a record", async () => {
    const { applied } = await collect([
      enc("id: v1.j.3\r\nevent: job.result_available\r\ndata: {}\r\n\r\n"),
    ]);
    expect(applied).toEqual([{ id: "v1.j.3", event: "job.result_available", data: "{}" }]);
  });

  // P1 regression: the old custom framer normalized each decoded chunk
  // independently, so a CRLF split between chunks turned the trailing `\r` into
  // a `\n` and the next chunk's leading `\n` into a phantom blank-line delimiter
  // — emitting a false id-only frame that committed an early cursor. The
  // maintained parser is stateful across feeds, so no phantom frame appears.
  it("does not corrupt framing when a CRLF is split across chunks (no phantom frame)", async () => {
    const { applied } = await collect([
      enc("id: c1\r"),
      enc('\nevent: job.progressed\r\ndata: {"x":1}\r\n\r\n'),
    ]);
    expect(applied).toEqual([{ id: "c1", event: "job.progressed", data: '{"x":1}' }]);
  });

  it("buffers a record split across chunk boundaries and emits it once complete", async () => {
    const { applied } = await collect([
      enc("id: v1.j.9\nevent: job.progressed\nda"),
      enc('ta: {"score":2}\n\n'),
    ]);
    expect(applied).toEqual([{ id: "v1.j.9", event: "job.progressed", data: '{"score":2}' }]);
  });

  it("reassembles a multibyte UTF-8 sequence split across the byte boundary", async () => {
    // U+3042 (あ) is 3 UTF-8 bytes; split the byte stream one byte into it. The
    // shared streaming decoder must carry the partial sequence to the next chunk.
    const full = 'id: v1.j.1\nevent: job.progressed\ndata: {"x":"あ"}\n\n';
    const bytes = enc(full);
    const byteOffset = enc(full.slice(0, full.indexOf("あ"))).length + 1;
    const { applied } = await collect([bytes.slice(0, byteOffset), bytes.slice(byteOffset)]);
    expect(applied).toEqual([{ id: "v1.j.1", event: "job.progressed", data: '{"x":"あ"}' }]);
  });

  it("applies arbitrarily many legal records from one large chunk (no per-record cap)", async () => {
    // ~110 KiB of small records in ONE chunk: the adapter applies every legal
    // record with no application-level record-size ceiling. SSE framing is owned
    // by the maintained parser; the adapter only orchestrates apply/commit.
    const count = 2000;
    const many = Array.from(
      { length: count },
      (_, i) => `id: v1.j.${i}\nevent: job.progressed\ndata: {"p":${i}}\n\n`,
    ).join("");
    expect(many.length).toBeGreaterThan(64 * 1024);
    const { applied, tracker } = await collect([enc(many)]);
    expect(applied).toHaveLength(count);
    expect(applied[0].id).toBe("v1.j.0");
    expect(applied[count - 1].id).toBe(`v1.j.${count - 1}`);
    expect(await retainedCursor(tracker)).toBe(`v1.j.${count - 1}`);
  });
});

describe("streamOptimizeEvents cursor-bound + abort fencing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("throws SseCursorOverflowError for an oversized FIRST in-stream cursor, applying nothing and never skipping ahead", async () => {
    // `adaptMessage` measures the cursor (non-allocating) during the synchronous feed
    // and defers an oversized one as a `cursor-error` sentinel. `drain` throws it
    // before applying that frame, so it is never applied/committed/dropped-and-advanced.
    // The throw takes the loop's ordinary recovery path (no special protocol handling).
    const hugeCursor = "c".repeat(MAX_CURSOR_BYTES + 1);
    const text =
      `id: ${hugeCursor}\nevent: job.state_changed\ndata: {"p":1}\n\n` +
      'id: v1.j.2\nevent: job.progressed\ndata: {"p":2}\n\n';
    globalThis.fetch = vi.fn(async () => byteStreamResponse([enc(text)])) as typeof fetch;

    const tracker = track("v1.j.0");
    const applied: SseFrame[] = [];
    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: (f) => {
          applied.push(f);
        },
      }),
    ).rejects.toBeInstanceOf(SseCursorOverflowError);

    expect(applied).toEqual([]); // never applied
    expect(await retainedCursor(tracker)).toBe("v1.j.0"); // never advanced past the dropped frame
  });

  it("same-feed A + invalid-cursor B + C: A applies/commits, B never applies, C is ignored, retry begins from A", async () => {
    // All three records arrive in ONE synchronous feed. A valid frame collected before
    // an oversized-cursor sentinel must fully drain (apply + commit + onCommit) BEFORE
    // the sentinel throws; the offending B and everything after it (C) are ignored, and
    // the next reconnect resumes from A's committed cursor — not the prior floor.
    const hugeCursor = "c".repeat(MAX_CURSOR_BYTES + 1);
    const text =
      'id: v1.A\nevent: job.progressed\ndata: {"p":1}\n\n' + // A: valid
      `id: ${hugeCursor}\nevent: job.progressed\ndata: {"p":2}\n\n` + // B: oversized cursor
      'id: v1.C\nevent: job.progressed\ndata: {"p":3}\n\n'; // C: later, must be ignored
    const sentCursors: (string | null)[] = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentCursors.push(new Headers(init?.headers).get(LAST_EVENT_ID_HEADER));
      return byteStreamResponse([enc(text)]);
    }) as typeof fetch;

    const tracker = track("v1.floor");
    const applied: string[] = [];
    const committed: string[] = [];
    const run = () =>
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: (f) => {
          applied.push(f.id ?? "∅");
        },
        onCommit: (cursor) => committed.push(cursor),
      });

    await expect(run()).rejects.toBeInstanceOf(SseCursorOverflowError);
    expect(applied).toEqual(["v1.A"]); // A applied; B and C never applied
    expect(committed).toEqual(["v1.A"]); // A committed; the sentinel fired after
    expect(await retainedCursor(tracker)).toBe("v1.A"); // advanced to A, not stuck at the floor

    // The next reconnect resumes strictly after A (the last committed cursor).
    await expect(run()).rejects.toBeInstanceOf(SseCursorOverflowError);
    expect(sentCursors).toEqual(["v1.floor", "v1.A"]);
  });

  it("fences later frames collected by the SAME synchronous feed when onEvent throws on revocation/abort", async () => {
    // `eventsource-parser` emits every complete record in one chunk synchronously,
    // so a single feed collects multiple frames. Abort/revocation fencing is the
    // awaited consumer's responsibility (exactly as the wrapped loop's canApplyFrame
    // throw supplies): once `onEvent` throws, every later already-collected frame
    // must NOT apply or commit, and the cursor stays put for replay.
    const text =
      'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' +
      'id: v1.j.2\nevent: job.progressed\ndata: {"p":2}\n\n' +
      'id: v1.j.3\nevent: job.progressed\ndata: {"p":3}\n\n';
    globalThis.fetch = vi.fn(async () => byteStreamResponse([enc(text)])) as typeof fetch;

    const controller = new AbortController();
    const tracker = track();
    const applied: string[] = [];
    // A direct caller that mirrors the loop's revocation predicate: apply the first
    // frame, revoke, then throw for the next — fencing the remaining collected feed.
    const onEvent = (f: SseFrame) => {
      if (controller.signal.aborted) throw new Error("attachment revoked mid-feed");
      applied.push(f.id ?? "∅");
      controller.abort(); // revoke after the FIRST frame applies
    };

    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: controller.signal,
        tracker,
        onEvent,
      }),
    ).rejects.toThrow("attachment revoked mid-feed");

    // Only the first collected frame applied/committed; the throw fenced the rest.
    expect(applied).toEqual(["v1.j.1"]);
    expect(await retainedCursor(tracker)).toBe("v1.j.1");
  });

  it("flushes the decoder at end of stream so a complete final record still emits", async () => {
    const bytes = enc('id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n');
    globalThis.fetch = vi.fn(async () => byteStreamResponse([bytes])) as typeof fetch;

    const tracker = track();
    const applied: SseFrame[] = [];
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: (f) => {
        applied.push(f);
      },
    });
    expect(applied).toEqual([{ id: "v1.j.1", event: "job.progressed", data: '{"p":1}' }]);
    expect(await retainedCursor(tracker)).toBe("v1.j.1");
  });

  it("propagates an abort from fetch rather than swallowing it", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      }
      return byteStreamResponse([]);
    }) as typeof fetch;

    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: controller.signal,
        tracker: track(),
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

// The cursor boundary is a RUNTIME check exercised through the only public seams: the
// `createResumeCursor` factory and the actual `Last-Event-ID` header the transport
// sends. There is no exported tracker class, so no raw string can be typed/asserted past
// the boundary — these tests use raw 4,097-byte strings, not `checkCursor(...) === null`.
describe("createResumeCursor + the real Last-Event-ID header (runtime cursor boundary)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // Run one stream through the handle and return the Last-Event-ID header actually sent.
  async function sentHeaderFor(tracker: ResumeCursor, streamText = ""): Promise<string | null> {
    let sent: string | null = null;
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent = new Headers(init?.headers).get(LAST_EVENT_ID_HEADER);
      return byteStreamResponse(streamText ? [enc(streamText)] : []);
    }) as typeof fetch;
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: () => {},
    });
    return sent;
  }

  it("replays a valid restored cursor as the Last-Event-ID header", async () => {
    const { cursor, rejected } = createResumeCursor("v1.j.42");
    expect(rejected).toBe(false);
    expect(await sentHeaderFor(cursor)).toBe("v1.j.42");
  });

  it("sends no Last-Event-ID header when there is no restored cursor", async () => {
    const { cursor, rejected } = createResumeCursor(null);
    expect(rejected).toBe(false);
    expect(await sentHeaderFor(cursor)).toBeNull();
  });

  it("REJECTS a raw 4,097-byte restored cursor at runtime and never replays it as a header", async () => {
    const oversized = "c".repeat(MAX_CURSOR_BYTES + 1); // a plain, untyped string over the cap
    const { cursor, rejected } = createResumeCursor(oversized);
    expect(rejected).toBe(true); // runtime rejection reported to the caller (route to recovery)
    expect(await sentHeaderFor(cursor)).toBeNull(); // the poison value never reaches the wire
  });

  it("REJECTS an `any`/asserted oversized cursor — the boundary is a runtime check, not an erased brand", async () => {
    // A JS or `any`-typed caller cannot smuggle an oversized cursor into the header: the
    // factory measures bytes at runtime regardless of the static type it was handed.
    const smuggled = "c".repeat(MAX_CURSOR_BYTES + 1) as unknown as string;
    const { cursor, rejected } = createResumeCursor(smuggled);
    expect(rejected).toBe(true);
    expect(await sentHeaderFor(cursor)).toBeNull();
  });

  it("REJECTS a FORGED structural handle (JS/any) with an oversized lastEventId BEFORE any request/header", async () => {
    // The emitted public API accepts a structural `ResumeCursor`; a JS/`any` caller could
    // forge one carrying an oversized `lastEventId` and its own `commit`/`isDuplicate`. The
    // transport must verify handle IDENTITY (only a `createResumeCursor` tracker) and throw
    // before it ever reads state, fetches, or builds the header.
    const forged = {
      reset() {},
      lastEventId: "x".repeat(MAX_CURSOR_BYTES + 1),
      isDuplicate: () => false,
      commit() {},
    } as unknown as ResumeCursor;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker: forged,
        onEvent: () => {},
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchSpy).not.toHaveBeenCalled(); // no request, so no oversized Last-Event-ID header
  });

  it("reset() discards the cursor so the next request resumes from the floor (no header)", async () => {
    const { cursor } = createResumeCursor("v1.j.7");
    expect(await sentHeaderFor(cursor)).toBe("v1.j.7");
    cursor.reset();
    expect(await sentHeaderFor(cursor)).toBeNull();
  });

  it("a committed valid in-stream cursor becomes the Last-Event-ID on the next reconnect", async () => {
    // The only way a value reaches the header besides construction is committing a
    // validated frame; there is no public raw-commit seam. An oversized in-stream cursor
    // is a `cursor-error` (never committed) — see the same-feed A+B+C test.
    const { cursor } = createResumeCursor(null);
    const first = await sentHeaderFor(
      cursor,
      'id: v1.applied\nevent: job.progressed\ndata: {"p":1}\n\n',
    );
    expect(first).toBeNull(); // first request had no prior cursor
    expect(await sentHeaderFor(cursor)).toBe("v1.applied"); // committed cursor replayed
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

    const tracker = track("v1.j.42");
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
      tracker: track(),
      onEvent: () => {},
    });
    expect(hasHeader).toBe(false);
  });

  it("dispatches new frames, dedupes exact-duplicate ids, and returns terminal on a terminal state frame", async () => {
    // A terminal frame must carry the FULL enriched state payload to be recognized.
    const terminalData =
      '{"occurred_at":"2026-07-20T00:01:00+00:00","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}';
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
      tracker: track(),
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

  it("reports strict terminal source proof before a cancelled apply and does not commit", async () => {
    const terminalData =
      '{"occurred_at":"2026-07-20T00:01:00+00:00","state":"completed","queue_position":null,"cancel_requested":false,"early_completion_requested":false,"terminal":true,"controls":{"cancellable":false,"early_completion_available":false}}';
    globalThis.fetch = vi.fn(async () =>
      streamResponse(`id: v1.j.2\nevent: job.state_changed\ndata: ${terminalData}\n\n`),
    ) as typeof fetch;
    const tracker = track("v1.j.1");
    const onTerminalObserved = vi.fn();

    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker,
        onTerminalObserved,
        onEvent: () => {
          throw new Error("attachment revoked");
        },
      }),
    ).rejects.toThrow("attachment revoked");

    expect(onTerminalObserved).toHaveBeenCalledWith({
      id: "v1.j.2",
      event: "job.state_changed",
      data: terminalData,
    });
    expect(await retainedCursor(tracker)).toBe("v1.j.1");
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
      tracker: track(),
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

    const tracker = track("v1.j.6");
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
    expect(await retainedCursor(tracker)).toBe("v1.j.6");

    // Reconnect: the prior cursor is resent, the frame is reapplied successfully,
    // and only now does the cursor advance. No durable loss, no double apply.
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent,
    });
    expect(sentCursors).toEqual(["v1.j.6", "v1.j.6"]);
    expect(applied).toEqual(["v1.j.7"]);
    expect(await retainedCursor(tracker)).toBe("v1.j.7");
  });

  it("fires onCommit with each committed opaque cursor, once, only after apply", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse(
        'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' +
          'id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n' + // exact duplicate → no commit
          'event: job.progressed\ndata: {"p":2}\n\n' + // id-less → nothing to commit
          'id: v1.j.2\nevent: job.progressed\ndata: {"p":3}\n\n',
      ),
    ) as typeof fetch;

    const committed: string[] = [];
    const appliedAt: number[] = [];
    let applyCount = 0;
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker: track(),
      onEvent: () => {
        applyCount += 1;
      },
      onCommit: (cursor) => {
        committed.push(cursor);
        appliedAt.push(applyCount);
      },
    });

    // Only real, newly-applied cursors are reported — no duplicate, no id-less frame.
    expect(committed).toEqual(["v1.j.1", "v1.j.2"]);
    // Each commit was observed strictly after its frame's apply ran (never before).
    expect(appliedAt).toEqual([1, 3]);
  });

  it("does NOT fire onCommit when onEvent throws (cursor stays put for replay)", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse('id: v1.j.7\nevent: job.progressed\ndata: {"p":1}\n\n'),
    ) as typeof fetch;

    const tracker = track("v1.j.6");
    const onCommit = vi.fn();
    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: () => {
          throw new Error("apply failed");
        },
        onCommit,
      }),
    ).rejects.toThrow("apply failed");

    expect(onCommit).not.toHaveBeenCalled();
    expect(await retainedCursor(tracker)).toBe("v1.j.6");
  });

  it("awaits an async onEvent: a rejection leaves the cursor uncommitted, replays, then commits once", async () => {
    const frameText = 'id: v1.j.7\nevent: job.progressed\ndata: {"p":1}\n\n';
    globalThis.fetch = vi.fn(async () => streamResponse(frameText)) as typeof fetch;

    const tracker = track("v1.j.6");
    const onCommit = vi.fn();
    const applied: string[] = [];
    let shouldReject = true;
    // A promise-returning consumer: it must be awaited, so a REJECTION is observed
    // before the commit — identical to the synchronous throw path.
    const onEvent = async (frame: SseFrame) => {
      if (shouldReject) {
        shouldReject = false;
        throw new Error("async apply failed");
      }
      applied.push(frame.id ?? "∅");
    };

    await expect(
      streamOptimizeEvents("/api/optimize/x/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent,
        onCommit,
      }),
    ).rejects.toThrow("async apply failed");
    expect(await retainedCursor(tracker)).toBe("v1.j.6"); // not advanced
    expect(onCommit).not.toHaveBeenCalled();

    // Reconnect resends the prior cursor and reapplies the frame exactly once.
    await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent,
      onCommit,
    });
    expect(applied).toEqual(["v1.j.7"]);
    expect(await retainedCursor(tracker)).toBe("v1.j.7");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("v1.j.7");
  });

  it("returns closed when the stream ends without a terminal frame", async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse('id: v1.j.1\nevent: job.progressed\ndata: {"p":1}\n\n'),
    ) as typeof fetch;

    const outcome = await streamOptimizeEvents("/api/optimize/x/events", {
      signal: new AbortController().signal,
      tracker: track(),
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
    const authoritative = seededJob({ state: "cancelling" });
    const reconcile = vi.fn(async () => {
      client.setQueryData(optimizeKeys.job("opt_1"), authoritative);
      return authoritative;
    });
    const tracker = track("v1.j.6");

    await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.state).toBe("cancelling");
    expect(await retainedCursor(tracker)).toBe("v1.j.7"); // committed after reconcile
    // A permanently malformed retained event cannot loop forever: once committed, a
    // resend of the same id is an exact duplicate and is skipped (onEvent never re-runs).
    const reapplied = vi.fn();
    globalThis.fetch = vi.fn(async () => streamResponse(malformedState)) as typeof fetch;
    await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: reapplied,
    });
    expect(reapplied).not.toHaveBeenCalled();
  });

  it("does NOT commit when the reconcile poll fails, so reconnect replays the prior cursor", async () => {
    globalThis.fetch = vi.fn(async () => streamResponse(malformedState)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const tracker = track("v1.j.6");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(await retainedCursor(tracker)).toBe("v1.j.6"); // cursor unchanged → replay on reconnect
  });

  // Semantically invalid (but JSON-valid) durable payloads: unknown enum values,
  // out-of-domain queue, malformed supplied error. Each must reconcile, not apply.
  const frame = (id: string, event: string, data: object) =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const controls = { cancellable: false, early_completion_available: false };

  const invalidStateBase = {
    occurred_at: "2026-07-20T00:00:00+00:00",
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
        worker_id: "worker-1",
        queue_position: -1,
      }),
    ],
    [
      "fractional queue_position",
      frame("v1.s.3", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
        worker_id: "worker-1",
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
        worker_id: "worker-1",
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
      "queued state without a queue position",
      frame("v1.s.9", "job.state_changed", {
        ...invalidStateBase,
        state: "queued",
        terminal: false,
        controls: { cancellable: true, early_completion_available: false },
      }),
    ],
    [
      "running state with terminal controls",
      frame("v1.s.12", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
        worker_id: "worker-1",
      }),
    ],
    [
      "failed state without an error",
      frame("v1.s.13", "job.state_changed", {
        ...invalidStateBase,
        state: "failed",
        terminal: true,
      }),
    ],
    [
      "control_changed false",
      frame("v1.c.1", "job.control_changed", {
        occurred_at: "2026-07-20T00:00:00+00:00",
        early_completion_requested: false,
      }),
    ],
    [
      "unknown outcome",
      frame("v1.r.1", "job.result_available", {
        occurred_at: "2026-07-20T00:00:00+00:00",
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
        occurred_at: "2026-07-20T00:00:00+00:00",
        outcome: "feasible",
        score: 1.5,
        solver_status: "X",
        termination_reason: null,
        artifact_name: null,
      }),
    ],
    [
      "feasible result without an artifact",
      frame("v1.r.3", "job.result_available", {
        occurred_at: "2026-07-20T00:00:00+00:00",
        outcome: "feasible",
        score: 1,
        solver_status: "FEASIBLE",
        termination_reason: "limit_or_stop",
        artifact_name: null,
      }),
    ],
    [
      "optimal result with a feasible solver status",
      frame("v1.r.4", "job.result_available", {
        occurred_at: "2026-07-20T00:00:00+00:00",
        outcome: "optimal",
        score: 1,
        solver_status: "FEASIBLE",
        termination_reason: "optimality_proven",
        artifact_name: "schedule.xlsx",
      }),
    ],
    [
      "running state with an unknown key",
      frame("v1.s.14", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
        worker_id: "worker-1",
        mystery: true,
      }),
    ],
    [
      "running state without worker_id",
      frame("v1.s.15", "job.state_changed", {
        ...invalidStateBase,
        state: "running",
        terminal: false,
        controls: { cancellable: true, early_completion_available: true },
      }),
    ],
  ];

  it.each(semanticInvalids)(
    "a %s payload polls+replaces before committing the cursor (single commit)",
    async (_name, frameText) => {
      globalThis.fetch = vi.fn(async () => streamResponse(frameText)) as typeof fetch;
      const client = new QueryClient();
      client.setQueryData(optimizeKeys.job("opt_1"), seededJob());
      const authoritative = seededJob({ state: "cancelling" });
      const reconcile = vi.fn(async () => {
        client.setQueryData(optimizeKeys.job("opt_1"), authoritative);
        return authoritative;
      });
      const committed: string[] = [];
      const tracker = track("v1.prev");

      const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
        onCommit: (cursor) => {
          expect(client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.state).toBe(
            "cancelling",
          );
          committed.push(cursor);
        },
      });

      expect(reconcile).toHaveBeenCalledOnce(); // reconciled, not applied
      expect(client.getQueryData<JobResponse>(optimizeKeys.job("opt_1"))?.state).toBe("cancelling");
      const retained = await retainedCursor(tracker);
      expect(retained).not.toBe("v1.prev"); // cursor advanced exactly once, after reconcile
      expect(committed).toEqual([retained]);
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
    const tracker = track("v1.prev");

    const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(outcome.type).toBe("closed"); // stream ended naturally, NOT a terminal close
    expect(await retainedCursor(tracker)).toBe("v1.s.5"); // committed after reconcile
  });

  it("a failed reconcile for malformed running runtime retains the prior cursor for replay", async () => {
    const invalidRuntime = frame("v1.s.16", "job.state_changed", {
      ...invalidStateBase,
      state: "running",
      terminal: false,
      worker_id: "worker-1",
      controls: { cancellable: true, early_completion_available: true },
      runtime: {
        service_name: "nurse-scheduling-api",
        api_version: "alpha",
        app_version: "v-test",
        deployment_id: "deployment-test",
        instance_id: "instance-test",
        started_at: "not-an-iso-timestamp",
        job_backend: "memory",
        job_store_id: "store-test",
      },
    });
    globalThis.fetch = vi.fn(async () => streamResponse(invalidRuntime)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {
      throw new Error("poll failed");
    });
    const onCommit = vi.fn();
    const tracker = track("v1.prev");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
        onCommit,
      }),
    ).rejects.toThrow("poll failed");
    expect(await retainedCursor(tracker)).toBe("v1.prev"); // unchanged → replay on reconnect
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a live state falsely bearing terminal:true reconciles and does NOT close the stream", async () => {
    // running + terminal:true is a state/terminal contradiction: the flag must not be
    // trusted to close the stream; true terminality comes from the authoritative poll.
    const liveMarkedTerminal = frame("v1.s.10", "job.state_changed", {
      ...invalidStateBase,
      state: "running",
      terminal: true,
      worker_id: "worker-1",
    });
    globalThis.fetch = vi.fn(async () => streamResponse(liveMarkedTerminal)) as typeof fetch;
    const client = new QueryClient();
    const reconcile = vi.fn(async () => {});
    const tracker = track("v1.prev");

    const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(outcome.type).toBe("closed"); // NOT a terminal close from the bad frame
    expect(await retainedCursor(tracker)).toBe("v1.s.10"); // committed once, after reconcile
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
    const tracker = track("v1.prev");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(await retainedCursor(tracker)).toBe("v1.prev"); // unchanged → replay on reconnect
  });

  it("a VALID terminal state frame with an existing cache applies directly and closes terminal", async () => {
    const validTerminal = frame("v1.s.6", "job.state_changed", {
      ...invalidStateBase,
      occurred_at: "2026-07-20T00:01:00+00:00",
      state: "completed",
      terminal: true,
    });
    globalThis.fetch = vi.fn(async () => streamResponse(validTerminal)) as typeof fetch;
    const client = new QueryClient();
    client.setQueryData(optimizeKeys.job("opt_1"), seededJob()); // full response present ⇒ partial patch applies
    const reconcile = vi.fn(async () => {});
    const tracker = track();

    const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
      signal: new AbortController().signal,
      tracker,
      onEvent: onEvent(client, reconcile),
    });

    expect(reconcile).not.toHaveBeenCalled(); // valid + cached ⇒ applied, not reconciled
    expect(outcome.type).toBe("terminal");
    expect(await retainedCursor(tracker)).toBe("v1.s.6");
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
        worker_id: "worker-1",
      }),
    ],
    [
      "control_changed",
      frame("v1.n.2", "job.control_changed", {
        occurred_at: "2026-07-20T00:00:00+00:00",
        early_completion_requested: true,
      }),
    ],
    [
      "result_available",
      frame("v1.n.3", "job.result_available", {
        occurred_at: "2026-07-20T00:00:00+00:00",
        outcome: "feasible",
        score: 42,
        solver_status: "FEASIBLE",
        termination_reason: "limit_or_stop",
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
      const tracker = track("v1.prev");

      const outcome = await streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      });

      expect(reconcile).toHaveBeenCalledOnce(); // reconciled, not applied
      expect(await retainedCursor(tracker)).not.toBe("v1.prev"); // cursor advanced exactly once, after reconcile
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
    const tracker = track("v1.prev");

    await expect(
      streamOptimizeEvents("/api/optimize/opt_1/events", {
        signal: new AbortController().signal,
        tracker,
        onEvent: onEvent(client, reconcile),
      }),
    ).rejects.toThrow("poll failed");
    expect(await retainedCursor(tracker)).toBe("v1.prev"); // unchanged → replay, no direct terminal close
  });
});
