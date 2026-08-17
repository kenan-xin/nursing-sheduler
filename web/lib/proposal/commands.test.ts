// The wire schema (T07).
//
// The property being pinned is NEGATIVE: there is no shape of argument -- however a
// model phrases it -- that gets scenario content, a patch, or an unsupported
// operation past this boundary. So most of these cases are payloads that must be
// refused.

import { describe, expect, it } from "vitest";
import {
  ASSISTANT_COMMAND_TYPES,
  assistantCommandListSchema,
  parseAssistantCommands,
} from "./commands";

describe("parseAssistantCommands", () => {
  it("accepts every supported arm", () => {
    const result = parseAssistantCommands([
      {
        type: "set_roster_range",
        start: "2026-04-01",
        end: "2026-04-30",
        importPublicHolidays: true,
      },
      { type: "set_rule_enabled", ruleKind: "counts", ruleId: "c1", enabled: false },
      { type: "set_staffing_requirement_people", ruleId: "r1", requiredNumPeople: 2 },
      { type: "move_leave", personId: 7, fromDate: "02", toDate: "03" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commands).toHaveLength(4);
  });

  it("keeps a numeric id numeric", () => {
    // `1` and `"1"` are DISTINCT ids in this model, so coercion would silently
    // retarget an operation at a different person.
    const result = parseAssistantCommands([
      { type: "move_leave", personId: 1, fromDate: 2, toDate: 3 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok && result.commands[0].type === "move_leave") {
      expect(result.commands[0].personId).toBe(1);
    }
  });

  it("refuses anything that is not one of the supported operations", () => {
    const refused: unknown[] = [
      // A raw patch, the thing this union exists to make unrepresentable.
      [{ type: "patch_scenario", patch: { rangeStart: "2026-01-01" } }],
      // A whole-document replacement.
      [{ type: "replace_scenario", scenario: { staff: [] } }],
      // A plausible-sounding operation the host has no transform for.
      [{ type: "add_person", person: { id: "new" } }],
      // A supported arm carrying content alongside its targets.
      [{ type: "set_rule_enabled", ruleKind: "counts", ruleId: "c", enabled: true, card: {} }],
      // A rule family that does not exist.
      [{ type: "set_rule_enabled", ruleKind: "holidays", ruleId: "c", enabled: true }],
      // A date in the wrong form.
      [
        {
          type: "set_roster_range",
          start: "1 April",
          end: "2026-04-30",
          importPublicHolidays: false,
        },
      ],
      // The consequential holiday choice omitted rather than stated.
      [{ type: "set_roster_range", start: "2026-04-01", end: "2026-04-30" }],
      // Nothing at all.
      [],
      "set_roster_range",
      null,
    ];
    for (const payload of refused) {
      const result = parseAssistantCommands(payload);
      expect(result.ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("bounds a batch, so one tool call cannot become an unreviewable change", () => {
    const many = Array.from({ length: 26 }, (_, index) => ({
      type: "set_rule_enabled" as const,
      ruleKind: "counts" as const,
      ruleId: `c${index}`,
      enabled: false,
    }));
    expect(assistantCommandListSchema.safeParse(many).success).toBe(false);
    expect(assistantCommandListSchema.safeParse(many.slice(0, 25)).success).toBe(true);
  });

  it("lists exactly the arms the schema admits", () => {
    // The tool description and the registry both read this list; a new arm that is
    // schema-only would be invisible to them.
    const admitted = new Set(ASSISTANT_COMMAND_TYPES);
    for (const type of admitted) {
      expect(typeof type).toBe("string");
    }
    expect(admitted.size).toBe(ASSISTANT_COMMAND_TYPES.length);
  });
});
