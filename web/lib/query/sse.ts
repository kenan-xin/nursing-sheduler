import { createParser, type EventSourceMessage } from "eventsource-parser";
import { LAST_EVENT_ID_HEADER } from "@/lib/bff/types";
import { parseStrictTerminalFrame, type StrictTerminalFrame } from "@/lib/query/event-payloads";
import { MAX_CURSOR_BYTES, utf8ByteLength } from "@/lib/query/sse-limits";

// fetch-stream SSE consumption for `/api/optimize/{id}/events` (tech-plan §5). SSE syntax
// and framing (CR/LF/CRLF incl. split delimiters, BOM, `data:` multiline assembly,
// comments, field parsing) is delegated to the maintained, zero-dependency
// `eventsource-parser` (pinned 3.1.0); there is NO application record-size ceiling. This
// module owns only the durable-recovery additions: a runtime opaque-cursor boundary,
// exact-duplicate dedupe, and apply-before-commit orchestration.

export interface SseFrame {
  // The opaque, job-bound cursor for this event, or null for id-less frames.
  id: string | null;
  event: string;
  data: string;
}

// The single cursor boundary — a RUNTIME check, not an erased type brand: the string if it
// fits `MAX_CURSOR_BYTES`, else null. Every value entering the tracker passes through here.
function checkCursor(value: string): string | null {
  return utf8ByteLength(value) <= MAX_CURSOR_BYTES ? value : null;
}

// An `id` past `MAX_CURSOR_BYTES`. Thrown by `drain` after earlier valid frames commit
// and before the offending frame applies (never applied/committed/dropped-and-advanced).
// The backend never emits one; the throw takes the loop's ordinary recovery path.
export class SseCursorOverflowError extends Error {
  constructor(public readonly bytes: number) {
    super(`Optimize SSE cursor exceeded MAX_CURSOR_BYTES=${MAX_CURSOR_BYTES} (got ${bytes}).`);
    this.name = "SseCursorOverflowError";
  }
}

// One synchronously-parsed item, in emission order: an adapted frame with its checked
// cursor, or a cursor-boundary violation deferred to `drain` (never thrown in the callback).
type CollectedItem =
  | { kind: "frame"; frame: SseFrame; cursor: string | null }
  | { kind: "cursor-error"; error: SseCursorOverflowError };

// Adapt one library message WITHOUT throwing (oversized `id` → deferred `cursor-error`).
function adaptMessage(message: EventSourceMessage): CollectedItem {
  const id = message.id ?? null;
  const frame: SseFrame = { id, event: message.event ?? "message", data: message.data };
  if (id === null) return { kind: "frame", frame, cursor: null };
  const cursor = checkCursor(id);
  if (cursor === null)
    return { kind: "cursor-error", error: new SseCursorOverflowError(utf8ByteLength(id)) };
  return { kind: "frame", frame, cursor };
}

// The opaque resume-cursor handle held across reconnects; only `reset` (to the retained
// floor) is public, and `createResumeCursor` is the sole constructor.
export type ResumeCursor = { reset(): void };

// Module-private: it holds only `checkCursor`-validated values, so `lastEventId` (the
// replayed header) is always within cap and `commit` is infallible. The transport verifies
// handle identity by `instanceof`, so a forged `ResumeCursor` cannot substitute a raw cursor.
class CursorTracker implements ResumeCursor {
  private lastId: string | null;

  constructor(initial: string | null) {
    this.lastId = initial;
  }

  get lastEventId(): string | null {
    return this.lastId;
  }

  reset(): void {
    this.lastId = null;
  }

  isDuplicate(cursor: string | null): boolean {
    return cursor !== null && cursor === this.lastId;
  }

  commit(cursor: string): void {
    this.lastId = cursor;
  }
}

// Build a resume-cursor handle from a restored cursor, validating it at RUNTIME: an
// oversized value is rejected (never seeded as a header) and reported via `rejected` so
// the caller routes it through explicit invalid-cursor recovery.
export function createResumeCursor(initial: string | null): {
  cursor: ResumeCursor;
  rejected: boolean;
} {
  const rejected = initial !== null && checkCursor(initial) === null;
  return { cursor: new CursorTracker(rejected ? null : initial), rejected };
}

export type StreamOutcome =
  | { type: "terminal"; frame: StrictTerminalFrame }
  | { type: "closed" }
  | { type: "error-response"; status: number; body: unknown };

export interface StreamOptions {
  signal: AbortSignal;
  tracker: ResumeCursor;
  // May be async: the cursor commits only AFTER this resolves, so per-frame reconcile of a
  // malformed durable payload completes first. A rejection leaves the prior cursor and fences
  // the rest of the current feed.
  onEvent: (frame: SseFrame) => void | Promise<void>;
  // Fired with the just-committed opaque cursor, STRICTLY AFTER `onEvent` resolved and the id
  // advanced. Never on a throw, an exact duplicate, or an id-less frame — so a resume-point
  // consumer stores only fully applied cursors, once each. Opaque.
  onCommit?: (cursor: string) => void;
  // Strict terminal source evidence, emitted before application/commit (survives a late abort).
  onTerminalObserved?: (frame: StrictTerminalFrame) => void;
}

// Connect once, adapt and dispatch only NEW frames (exact-duplicate dedupe), and report the
// outcome. A `job.state_changed` with a FULLY VALIDATED terminal payload is the in-stream
// terminal signal; a semantically invalid one (even bearing `terminal: true`) is reconciled
// (poll), never trusted to close. A non-2xx returns `error-response`; a read failure throws.
export async function streamOptimizeEvents(
  url: string,
  options: StreamOptions,
): Promise<StreamOutcome> {
  // Reject a forged structural handle by RUNTIME IDENTITY before any fetch/header: only the
  // module-private `CursorTracker` passes `instanceof`, which also narrows the type (no cast).
  if (!(options.tracker instanceof CursorTracker)) {
    throw new TypeError("streamOptimizeEvents requires a ResumeCursor from createResumeCursor().");
  }
  const tracker = options.tracker;
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const cursor = tracker.lastEventId;
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

  // `eventsource-parser` invokes `onEvent` inline during `feed()`, so we buffer the
  // synchronously-emitted items in emission order and drain them (async apply + commit)
  // afterward. The callback never throws, so a late oversized cursor cannot starve an earlier one.
  const collected: CollectedItem[] = [];
  const parser = createParser({
    onEvent(message) {
      collected.push(adaptMessage(message));
    },
  });

  // Drain in emission order: apply/commit each valid frame (skipping duplicates, surfacing
  // terminal proof); a deferred cursor error throws AFTER every earlier frame committed and
  // BEFORE the offending frame applies, so all later items are ignored. Abort/revocation
  // fencing is the awaited `onEvent`'s job (the wrapped loop supplies it via `canApplyFrame`,
  // so the raw signal is not consulted here — see `event-stream.ts`).
  const drain = async (): Promise<StreamOutcome | null> => {
    for (const item of collected) {
      if (item.kind === "cursor-error") throw item.error;
      const { frame, cursor } = item;
      if (tracker.isDuplicate(cursor)) continue; // exact-duplicate id
      const terminal = parseStrictTerminalFrame(frame);
      if (terminal !== null) options.onTerminalObserved?.(terminal);
      // Apply (reconciling a malformed durable payload) BEFORE committing; a
      // throw/reject leaves the prior cursor, so reconnect replays it.
      await options.onEvent(frame);
      if (cursor !== null) {
        tracker.commit(cursor); // validated by `checkCursor` before application
        options.onCommit?.(cursor);
      }
      if (terminal !== null) return { type: "terminal", frame: terminal };
    }
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.length = 0;
      parser.feed(decoder.decode(value, { stream: true }));
      const outcome = await drain();
      if (outcome !== null) return outcome;
    }

    // Final flush emits any withheld trailing multibyte sequence; an unterminated final
    // record is NOT dispatched (SSE needs a blank line).
    const flushed = decoder.decode();
    if (flushed.length > 0) {
      collected.length = 0;
      parser.feed(flushed);
      const outcome = await drain();
      if (outcome !== null) return outcome;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { type: "closed" };
}
