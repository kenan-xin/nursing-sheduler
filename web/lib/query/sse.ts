import { LAST_EVENT_ID_HEADER } from "@/lib/bff/types";
import { parseStrictTerminalFrame, type StrictTerminalFrame } from "@/lib/query/event-payloads";

// fetch-stream SSE consumption for `/api/optimize/{id}/events` (tech-plan §5).
// Two concerns handled here, both unit-tested:
//   1. Frame parsing — revised backend frames are
//      `id: <opaque cursor>\n event: <name>\n data: <json>\n\n`, with
//      `: keepalive\n\n` comment frames in between. The `id` is the persisted,
//      job-bound cursor.
//   2. Opaque-cursor dedupe — the backend replays strictly AFTER the client's
//      `Last-Event-ID` and owns ordering, so we no longer dedupe by position.
//      Instead we remember the last applied cursor and skip only an exact
//      duplicate id (a defensive net; ordinal replay is gone).

export interface SseFrame {
  // The opaque, job-bound cursor for this event, or null for id-less frames.
  id: string | null;
  event: string;
  data: string;
}

// Incremental SSE record parser. Feed decoded text; get back complete frames.
// Comment-only records (keepalives) yield nothing.
export function createSseParser() {
  let buffer = "";

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const frames: SseFrame[] = [];
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const record = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame = parseRecord(record);
        if (frame !== null) frames.push(frame);
        separator = buffer.indexOf("\n\n");
      }
      return frames;
    },
  };
}

function parseRecord(record: string): SseFrame | null {
  let id: string | null = null;
  let event = "message";
  const dataLines: string[] = [];
  let hasField = false;
  let hasData = false;

  for (const line of record.split("\n")) {
    // Blank lines and comments (`:` prefix, e.g. `: keepalive`) carry no field.
    if (line === "" || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "id") {
      // The cursor is opaque: keep it as the exact string the server sent, never
      // parse or compare it as a number.
      id = value;
      hasField = true;
    } else if (field === "event") {
      event = value;
      hasField = true;
    } else if (field === "data") {
      dataLines.push(value);
      hasField = true;
      hasData = true;
    }
    // `retry` / unknown fields are ignored.
  }

  if (!hasField) return null;
  return { id, event, data: hasData ? dataLines.join("\n") : "" };
}

// Opaque-cursor tracker. Remembers the last APPLIED cursor so it can (a) supply it
// as `Last-Event-ID` on reconnect and (b) skip an exact duplicate id. It never
// interprets the cursor's structure.
//
// Duplicate detection and cursor commit are deliberately SEPARATE operations. The
// cursor advances only via `commit(frame)`, which callers invoke strictly AFTER the
// frame has been fully applied (cache write + all consumer callbacks). If
// application throws, the cursor is not advanced, so reconnect resends the prior
// cursor and the failed event is replayed and reapplied — no silent durable loss.
export class CursorTracker {
  private lastId: string | null;

  constructor(initial: string | null = null) {
    this.lastId = initial;
  }

  // The last applied cursor, sent as `Last-Event-ID` on reconnect (null → none).
  get lastEventId(): string | null {
    return this.lastId;
  }

  // Discard the saved cursor so the next connection resumes from the retained
  // floor. Used after `event_cursor_expired` / `invalid_event_cursor` recovery.
  reset(): void {
    this.lastId = null;
  }

  // Whether this frame is an exact duplicate of the last applied cursor. An id-less
  // frame is never a duplicate (nothing to compare); this performs NO commit.
  isDuplicate(frame: SseFrame): boolean {
    return frame.id !== null && frame.id === this.lastId;
  }

  // Advance the cursor to this frame's id. Call ONLY after the frame has been fully
  // applied. An id-less frame leaves the cursor unchanged.
  commit(frame: SseFrame): void {
    if (frame.id !== null) this.lastId = frame.id;
  }
}

export type StreamOutcome =
  | { type: "terminal"; frame: StrictTerminalFrame }
  | { type: "closed" }
  | { type: "error-response"; status: number; body: unknown };

export interface StreamOptions {
  signal: AbortSignal;
  tracker: CursorTracker;
  // May be async: the cursor commits only AFTER this resolves, so per-frame
  // reconciliation (poll + cache replace) of a malformed durable payload completes
  // before the cursor advances. A rejection leaves the cursor at the prior id.
  onEvent: (frame: SseFrame) => void | Promise<void>;
  // Fired with the just-committed opaque cursor, STRICTLY AFTER `onEvent` resolved
  // (cache reconcile + consumer application) and `tracker.commit` advanced the id.
  // It never fires when `onEvent` throws (cursor unchanged), for an exact-duplicate
  // id (skipped before apply), or for an id-less frame (nothing committed) — so a
  // consumer persisting the resume point stores only fully applied cursors, exactly
  // once each. The value is opaque: never parse or compare it.
  onCommit?: (cursor: string) => void;
  // Strict terminal source evidence, emitted before cache/consumer application and
  // cursor commit. This survives an abort that wins after the frame was parsed.
  onTerminalObserved?: (frame: StrictTerminalFrame) => void;
}

// A `job.state_changed` frame whose FULLY VALIDATED payload marks the lifecycle
// terminal is the in-stream terminal signal (there is no terminal event NAME
// anymore). Terminal recognition reuses the same strict parser as cache
// application: a semantically invalid state/error/queue payload — even one bearing
// `terminal: true` — is NOT trusted to close the stream. It reconciles (poll)
// instead, and true terminality is then observed via the authoritative poll.
// Connect once, parse frames, dispatch only NEW frames (exact-duplicate dedupe by
// cursor), and report the outcome. The last applied cursor is sent as
// `Last-Event-ID` so the BFF forwards it upstream for replay. Non-2xx returns
// `error-response` (so the caller can classify expired/invalid cursor vs gone job
// vs 5xx) rather than throwing; a network/read failure throws.
export async function streamOptimizeEvents(
  url: string,
  options: StreamOptions,
): Promise<StreamOutcome> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const cursor = options.tracker.lastEventId;
  if (cursor !== null) headers[LAST_EVENT_ID_HEADER] = cursor;

  const response = await fetch(url, {
    signal: options.signal,
    cache: "no-store",
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { type: "error-response", status: response.status, body };
  }
  if (response.body === null) return { type: "closed" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        if (options.tracker.isDuplicate(frame)) continue; // exact-duplicate id
        const terminal = parseStrictTerminalFrame(frame);
        if (terminal !== null) options.onTerminalObserved?.(terminal);
        // Apply (and reconcile, if the durable payload was malformed) BEFORE
        // committing the cursor. If `onEvent` throws/rejects — a cache, consumer, or
        // reconcile-poll failure — the cursor stays at the prior id so reconnect
        // replays and reapplies this exact frame instead of skipping it.
        await options.onEvent(frame);
        options.tracker.commit(frame);
        // Post-commit: notify only when a real cursor advanced (id-less frames commit
        // nothing). Fires after apply + commit, so a persisted resume point never runs
        // ahead of a frame the cache/consumer actually received.
        if (frame.id !== null) options.onCommit?.(frame.id);
        if (terminal !== null) return { type: "terminal", frame: terminal };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { type: "closed" };
}
