import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";

import { toCanonical, toTransport, toUserContent } from "./messages";
import type { AssistantMessageV1 } from "./records";

const png = {
  kind: "image" as const,
  filename: "ward.png",
  mimeType: "image/png",
  data: "iVBORw0KGgo=",
};
const csv = {
  kind: "text" as const,
  filename: "leave.csv",
  mimeType: "text/csv",
  data: "QW5hLDMgTm92",
};
const ctx = {
  threadId: "t",
  scenarioId: "s",
  modelId: null,
  turnId: "turn",
  createdAt: "x",
  globalGeneration: 0,
  scenarioGeneration: 0,
};

describe("attachments through the transport adapter (2by.10)", () => {
  it("builds text + image + document parts, and a plain string when there are none", () => {
    expect(toUserContent("hi", null)).toBe("hi");
    expect(toUserContent("hi", [])).toBe("hi");
    expect(toUserContent("What is this?", [png, csv])).toEqual([
      { type: "text", text: "What is this?" },
      {
        type: "image",
        source: { type: "data", value: png.data, mimeType: "image/png" },
        metadata: { filename: "ward.png" },
      },
      {
        type: "document",
        source: { type: "data", value: csv.data, mimeType: "text/csv" },
        metadata: { filename: "leave.csv" },
      },
    ]);
  });

  it("round-trips a user message with attachments through the durable record", () => {
    const message = {
      id: "m1",
      role: "user",
      content: toUserContent("What is this?", [png, csv]),
    } as Message;
    const record = { ...toCanonical(message, ctx)!, seq: 0 } as AssistantMessageV1;
    expect(record.content).toBe("What is this?");
    expect(record.attachments).toEqual([png, csv]);
    expect(toTransport(record)).toEqual(message);
  });

  it("keeps an old record with no attachments field as plain text", () => {
    const record = {
      ...toCanonical({ id: "m2", role: "user", content: "hi" } as Message, ctx)!,
      seq: 1,
    } as AssistantMessageV1;
    delete (record as Partial<AssistantMessageV1>).attachments;
    expect(toTransport(record)).toEqual({ id: "m2", role: "user", content: "hi" });
  });
});
