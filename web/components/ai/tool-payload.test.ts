import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseToolPayload } from "./tool-payload";

const schema = z.object({
  operations: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          type: z.enum(["add_shift_type"]),
          startTime: z.string().regex(/^\d{2}:\d{2}$/, "a time must be written HH:MM, e.g. 08:00"),
          restMinutes: z.number(),
        }),
        z.strictObject({
          type: z.enum(["remove_rule"]),
          ruleKind: z.enum(["counts", "requirements"]),
        }),
      ]),
    )
    .max(2),
});

function refusal(raw: unknown): string {
  const result = parseToolPayload(schema, raw);
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
}

describe("the schema refusal", () => {
  it("names the field and the expected format, and invites one corrected call", () => {
    const text = refusal({
      operations: [{ type: "add_shift_type", startTime: "0800", restMinutes: 0 }],
    });
    expect(text).toContain("not a valid call to this tool");
    expect(text).toContain("operations.0.startTime: a time must be written HH:MM, e.g. 08:00");
    expect(text).toContain("call this tool again once");
    expect(text).not.toContain("0800");
  });

  it("says the limit and to split when there are too many operations", () => {
    const op = { type: "remove_rule", ruleKind: "counts" };
    expect(refusal({ operations: [op, op, op] })).toContain("operations: at most 2 items");
  });

  it("names the allowed values of an enum", () => {
    const text = refusal({ operations: [{ type: "remove_rule", ruleKind: "payroll" }] });
    expect(text).toContain('operations.0.ruleKind: must be one of "counts", "requirements"');
    expect(text).not.toContain("payroll");
  });

  it("never says 'undefined' for a missing field, and never echoes an unknown key", () => {
    const missing = refusal({});
    expect(missing).toContain("operations: expected array");
    expect(missing).not.toContain("undefined");
    const extra = refusal({
      operations: [{ type: "remove_rule", ruleKind: "counts", secretField: 1 }],
    });
    expect(extra).toContain("remove the fields this does not take");
    expect(extra).not.toContain("secretField");
  });

  it("says an unknown operation type is not one of the supported forms", () => {
    const text = refusal({ operations: [{ type: "replace_everything" }] });
    expect(text).toContain("operations.0.type:");
    expect(text).not.toContain("replace_everything");
  });
});
