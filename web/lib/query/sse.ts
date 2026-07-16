import { TERMINAL_EVENT_NAMES } from "@/lib/bff/types";

// fetch-stream SSE consumption for `/api/optimize/{id}/events` (tech-plan §3).
// Two concerns handled here, both unit-tested:
//   1. Frame parsing — C2 frames are `event: <name>\n data: <json>\n\n`, with
//      `: keepalive\n\n` comment frames in between; no `id:` field.
//   2. Ordinal-skip replay dedupe — the backend replays its ordered event array
//      from index 0 on every (re)connect, and frames carry no id, so we dedupe by
//      POSITION, not value: track how many frames have been applied and skip the
//      first N on reconnect.

export interface SseFrame {
  event: string;
  data: string;
}

// Incremental SSE record parser. Feed decoded text; get back complete frames.
// Comment-only records (keepalives) yield nothing and are not counted as frames.
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

    if (field === "event") {
      event = value;
      hasField = true;
    } else if (field === "data") {
      dataLines.push(value);
      hasField = true;
      hasData = true;
    }
    // `id` / `retry` / unknown fields are ignored (C2 sends neither `id` nor `retry`).
  }

  if (!hasField) return null;
  return { event, data: hasData ? dataLines.join("\n") : "" };
}

// Position-based replay dedupe. `appliedCount` persists across reconnects; each
// new connection restarts at per-connection index 0.
export class OrdinalSkipTracker {
  private applied: number;

  constructor(initialApplied = 0) {
    this.applied = initialApplied;
  }

  get appliedCount(): number {
    return this.applied;
  }

  // Given a frame's 0-based index within the CURRENT connection, report whether
  // it is new (not yet applied) and advance the applied count when it is.
  accept(connectionIndex: number): boolean {
    if (connectionIndex < this.applied) return false;
    this.applied = connectionIndex + 1;
    return true;
  }
}

export type StreamOutcome =
  | { type: "terminal"; frame: SseFrame }
  | { type: "closed" }
  | { type: "error-response"; status: number; body: unknown };

export interface StreamOptions {
  signal: AbortSignal;
  tracker: OrdinalSkipTracker;
  onEvent: (frame: SseFrame) => void;
}

// Connect once, parse frames, dispatch only NEW frames (ordinal-skip), and report
// the outcome. Non-2xx returns `error-response` (so the caller can classify an
// expired 404 vs a 5xx) rather than throwing; a network/read failure throws.
export async function streamOptimizeEvents(
  url: string,
  options: StreamOptions,
): Promise<StreamOutcome> {
  const response = await fetch(url, {
    signal: options.signal,
    cache: "no-store",
    headers: { accept: "text/event-stream" },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { type: "error-response", status: response.status, body };
  }
  if (response.body === null) return { type: "closed" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let connectionIndex = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        const isNew = options.tracker.accept(connectionIndex);
        connectionIndex += 1;
        if (isNew) options.onEvent(frame);
        if (TERMINAL_EVENT_NAMES.has(frame.event)) {
          return { type: "terminal", frame };
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return { type: "closed" };
}
