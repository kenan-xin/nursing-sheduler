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

  it("accepts the shift-setup arms with HH:MM times", () => {
    const result = parseAssistantCommands([
      {
        type: "add_shift_type",
        code: "N",
        name: "Night shift",
        startTime: "20:00",
        endTime: "08:30",
        restMinutes: 60,
      },
      { type: "add_shift_group", groupId: "Night shifts", members: ["N"] },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses shift-setup payloads the model must fix itself", () => {
    const refused: unknown[] = [
      // Time not converted to HH:MM.
      [
        {
          type: "add_shift_type",
          code: "am1",
          name: "",
          startTime: "0800",
          endTime: "15:00",
          restMinutes: 0,
        },
      ],
      // A required field omitted (name).
      [
        {
          type: "add_shift_type",
          code: "am1",
          startTime: "08:00",
          endTime: "15:00",
          restMinutes: 0,
        },
      ],
      // Rest omitted: the model must send 0 for no break.
      [{ type: "add_shift_type", code: "am1", name: "", startTime: "08:00", endTime: "15:00" }],
      // Rest that is not whole minutes.
      [
        {
          type: "add_shift_type",
          code: "am1",
          name: "",
          startTime: "08:00",
          endTime: "15:00",
          restMinutes: 12.5,
        },
      ],
      // Content alongside targets: paid minutes are the host's to derive.
      [
        {
          type: "add_shift_type",
          code: "am1",
          name: "",
          startTime: "08:00",
          endTime: "15:00",
          restMinutes: 0,
          durationMinutes: 420,
        },
      ],
      // A group with nothing in it.
      [{ type: "add_shift_group", groupId: "AM", members: [] }],
    ];
    for (const payload of refused) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("accepts the leave and request arms with calendar dates", () => {
    const result = parseAssistantCommands([
      { type: "add_leave", personId: "Ana", startDate: "2026-10-10", endDate: "2026-10-16" },
      {
        type: "set_shift_request",
        personId: "Ben",
        shiftType: "N",
        startDate: "2026-10-19",
        endDate: "2026-10-25",
        weight: -5,
      },
      {
        type: "set_shift_request",
        personId: "Chris",
        shiftType: "L",
        startDate: "2026-10-20",
        endDate: "2026-10-20",
        weight: "must",
      },
      {
        type: "set_off_request",
        personId: 7,
        startDate: "2026-10-21",
        endDate: "2026-10-21",
        weight: 0,
      },
      { type: "clear_requests", personId: "Ana", startDate: "2026-10-14", endDate: "2026-10-14" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses leave/request payloads the model must fix itself", () => {
    const refused: unknown[] = [
      // A roster date id instead of a calendar date.
      [{ type: "add_leave", personId: "Ana", startDate: "14", endDate: "14" }],
      // Words instead of a date.
      [{ type: "add_leave", personId: "Ana", startDate: "10 Oct", endDate: "16 Oct" }],
      // An end date omitted.
      [{ type: "add_leave", personId: "Ana", startDate: "2026-10-10" }],
      // Infinity spelled as a string: the hard values are "must" / "never".
      [
        {
          type: "set_shift_request",
          personId: "Ben",
          shiftType: "N",
          startDate: "2026-10-19",
          endDate: "2026-10-25",
          weight: "-Infinity",
        },
      ],
      // Weight omitted: the model must say how strongly.
      [
        {
          type: "set_off_request",
          personId: "Ben",
          startDate: "2026-10-21",
          endDate: "2026-10-21",
        },
      ],
      // Fractional weight: a weight is a whole number, or "must"/"never".
      [
        {
          type: "set_off_request",
          personId: "Ben",
          startDate: "2026-10-21",
          endDate: "2026-10-21",
          weight: 2.5,
        },
      ],
      // Content alongside targets: a leave type or note is not a field.
      [
        {
          type: "add_leave",
          personId: "Ana",
          startDate: "2026-10-10",
          endDate: "2026-10-16",
          description: "annual leave",
        },
      ],
    ];
    for (const payload of refused) {
      expect(parseAssistantCommands(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });
});
