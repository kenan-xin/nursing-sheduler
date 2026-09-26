// The transcript builder's own suite (bead 2by.9).
//
// PURE: no DOM, no IndexedDB, no settings row. That is deliberate -- the builder is
// where the "what does the file contain" contract lives, so every content claim is
// made against a plain function rather than through a mounted panel. The mounted
// path (and the mounted proof that the credential never reaches a file) lives in
// `components/ai/assistant-transcript.test.tsx`.

import { describe, expect, it } from "vitest";

import { buildTranscriptMarkdown, transcriptFilename } from "./transcript";

const EXPORTED_AT = new Date("2026-09-26T14:30:00.000Z");

function base(overrides: Partial<Parameters<typeof buildTranscriptMarkdown>[0]> = {}) {
  return buildTranscriptMarkdown({
    appVersion: "1.4.0-abc123",
    exportedAt: EXPORTED_AT,
    messages: [],
    receipts: [],
    ...overrides,
  });
}

describe("buildTranscriptMarkdown", () => {
  it("names itself, and carries the build version and the export timestamp", () => {
    const markdown = base();

    expect(markdown).toContain("# Schedule assistant transcript");
    expect(markdown).toContain("App version: 1.4.0-abc123");
    expect(markdown).toContain("Exported: 2026-09-26T14:30:00.000Z");
  });

  it("names the schedule when one is known, and omits the line when it is not", () => {
    expect(base({ scenarioName: "Ward 4 · September" })).toContain("Schedule: Ward 4 · September");
    expect(base({ scenarioName: "   " })).not.toContain("Schedule:");
    expect(base()).not.toContain("Schedule:");
  });

  it("renders the user and assistant turns with their own timestamps and text", () => {
    const markdown = base({
      messages: [
        {
          role: "user",
          content: "why is the 15th short?",
          toolCalls: null,
          createdAt: "2026-09-26T14:00:00.000Z",
        },
        {
          role: "assistant",
          content: "Two nurses are on leave that day.",
          toolCalls: null,
          createdAt: "2026-09-26T14:00:05.000Z",
        },
      ],
    });

    expect(markdown).toContain("## You · 2026-09-26T14:00:00.000Z");
    expect(markdown).toContain("why is the 15th short?");
    expect(markdown).toContain("## Assistant · 2026-09-26T14:00:05.000Z");
    expect(markdown).toContain("Two nurses are on leave that day.");
  });

  it("summarises tool calls (name and arguments) and their results", () => {
    const markdown = base({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              toolCallId: "call-1",
              name: "get_schedule_overview",
              args: '{"section":"roster"}',
            },
          ],
          createdAt: "2026-09-26T14:00:06.000Z",
        },
        {
          role: "tool",
          content: '{"shifts":3}',
          toolCalls: null,
          createdAt: "2026-09-26T14:00:07.000Z",
        },
      ],
    });

    expect(markdown).toContain("### Tool: get_schedule_overview");
    expect(markdown).toContain('{"section":"roster"}');
    expect(markdown).toContain("### Tool result · 2026-09-26T14:00:07.000Z");
    expect(markdown).toContain('{"shifts":3}');
  });

  it("carries a reasoning trace as a sub-section of the turn it belongs to", () => {
    const markdown = base({
      messages: [
        {
          role: "reasoning",
          content: "The 15th is short because two nurses are on leave.",
          toolCalls: null,
          createdAt: "2026-09-26T14:00:05.500Z",
        },
      ],
    });

    expect(markdown).toContain("### Reasoning · 2026-09-26T14:00:05.500Z");
    expect(markdown).toContain("The 15th is short because two nurses are on leave.");
  });

  it("renders a tool result with no preceding call as its own turn", () => {
    const markdown = base({
      messages: [
        {
          role: "tool",
          content: "an orphaned result",
          toolCalls: null,
          createdAt: "2026-09-26T14:00:08.000Z",
        },
      ],
    });

    expect(markdown).toContain("### Tool result · 2026-09-26T14:00:08.000Z");
    expect(markdown).toContain("an orphaned result");
  });

  it("summarises each receipt: when it happened, and each change it committed", () => {
    const markdown = base({
      receipts: [
        {
          createdAt: "2026-09-26T14:01:00.000Z",
          summary: [
            {
              key: "shift-counts:day",
              scope: "shift-counts",
              label: "Day shift cover",
              before: "Nothing",
              after: "2",
              kind: "created",
            },
            {
              key: "leave:ana",
              scope: "leave-and-requests",
              label: "Ana Lim leave",
              before: "Approved",
              after: "Removed",
              kind: "removed",
            },
          ],
        },
      ],
    });

    expect(markdown).toContain("## Changes applied");
    expect(markdown).toContain("### 2026-09-26T14:01:00.000Z");
    expect(markdown).toContain("Day shift cover");
    expect(markdown).toContain("(Shift counts)");
    expect(markdown).toContain("Nothing → 2");
    expect(markdown).toContain("Ana Lim leave");
    expect(markdown).toContain("Approved → Removed");
  });

  it("omits the receipts section entirely when nothing was applied", () => {
    expect(base()).not.toContain("## Changes applied");
  });

  it("fences content that itself contains backticks without breaking the block", () => {
    const markdown = base({
      messages: [
        {
          role: "tool",
          content: "```\nnot a real fence\n```",
          toolCalls: null,
          createdAt: "2026-09-26T14:00:09.000Z",
        },
      ],
    });

    // A wider fence than anything in the content is what keeps the block closed.
    expect(markdown).toContain("````text\n```\nnot a real fence\n```\n````");
  });

  it("ends with exactly one trailing newline", () => {
    const markdown = base({
      messages: [
        { role: "user", content: "hi", toolCalls: null, createdAt: "2026-09-26T14:00:00.000Z" },
      ],
    });

    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("transcriptFilename", () => {
  it("stamps the export date and the Markdown extension", () => {
    expect(transcriptFilename(EXPORTED_AT)).toBe("schedule-assistant-transcript-2026-09-26.md");
  });
});
