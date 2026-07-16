import { describe, expect, it } from "vitest";
import { createSseParser, OrdinalSkipTracker, type SseFrame } from "@/lib/query/sse";

describe("createSseParser", () => {
  it("parses event/data frames and ignores keepalive comments", () => {
    const parser = createSseParser();
    const frames = parser.push(
      'event: status\ndata: {"status":"queued"}\n\n' +
        ": keepalive\n\n" +
        'event: progress\ndata: {"score":1}\n\n',
    );
    expect(frames).toEqual<SseFrame[]>([
      { event: "status", data: '{"status":"queued"}' },
      { event: "progress", data: '{"score":1}' },
    ]);
  });

  it("buffers frames split across chunk boundaries", () => {
    const parser = createSseParser();
    expect(parser.push("event: progress\nda")).toEqual([]);
    expect(parser.push('ta: {"score":2}\n\n')).toEqual([
      { event: "progress", data: '{"score":2}' },
    ]);
  });

  it("joins multi-line data payloads with newlines", () => {
    const parser = createSseParser();
    expect(parser.push("event: log\ndata: line1\ndata: line2\n\n")).toEqual([
      { event: "log", data: "line1\nline2" },
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const parser = createSseParser();
    expect(parser.push("event: complete\r\ndata: {}\r\n\r\n")).toEqual([
      { event: "complete", data: "{}" },
    ]);
  });
});

describe("OrdinalSkipTracker (replay dedupe)", () => {
  it("applies every frame on the first connection", () => {
    const tracker = new OrdinalSkipTracker();
    expect([0, 1, 2].map((i) => tracker.accept(i))).toEqual([true, true, true]);
    expect(tracker.appliedCount).toBe(3);
  });

  it("skips already-applied frames when the backend replays from index 0", () => {
    const tracker = new OrdinalSkipTracker();
    // First connection applies indices 0..2.
    [0, 1, 2].forEach((i) => tracker.accept(i));

    // Reconnect: backend replays 0..4 from the start. Only 3 and 4 are new.
    const applied = [0, 1, 2, 3, 4].map((i) => tracker.accept(i));
    expect(applied).toEqual([false, false, false, true, true]);
    expect(tracker.appliedCount).toBe(5);
  });

  it("resumes from a known applied count", () => {
    const tracker = new OrdinalSkipTracker(2);
    expect([0, 1, 2].map((i) => tracker.accept(i))).toEqual([false, false, true]);
  });
});
