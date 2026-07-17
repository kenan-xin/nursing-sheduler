import { describe, expect, it } from "vitest";
import { isReservedKeyword, validateFullEditId, validateInlineId } from "./validation";
import type { EntityDescriptor, EditorItemBase } from "./descriptor";

// A minimal descriptor shape is enough — validation only reads labels + reserved.
function descriptor(reserved: readonly string[]): EntityDescriptor<EditorItemBase> {
  return {
    domain: "shift",
    labels: {
      item: "Shift Type",
      itemPlural: "Shift Types",
      itemLower: "shift type",
      itemPluralLower: "shift types",
    },
    reservedKeywords: reserved,
    supportsWorkingTime: true,
    readItems: () => [],
    readGroups: () => [],
    writeState: (s) => s,
    createItem: ({ id }) => ({ id }),
    syntheticItems: [],
    syntheticGroups: [],
  };
}

const items = [{ id: "D" }, { id: "N" }];
const groups = [{ id: "SG1", members: ["D"] }];
const desc = descriptor(["ALL", "OFF", "LEAVE"]);

describe("isReservedKeyword", () => {
  it("matches case-insensitively", () => {
    expect(isReservedKeyword(["ALL", "OFF", "LEAVE"], "all")).toBe(true);
    expect(isReservedKeyword(["ALL", "OFF", "LEAVE"], "Leave")).toBe(true);
    expect(isReservedKeyword(["ALL", "OFF", "LEAVE"], "Day")).toBe(false);
  });
});

describe("validateFullEditId (V1/V2/V3)", () => {
  it("trims input and accepts a unique non-reserved id", () => {
    expect(validateFullEditId(desc, items, groups, "  E  ")).toEqual({ ok: true, id: "E" });
  });

  it("rejects an empty id with the entity label", () => {
    const res = validateFullEditId(desc, items, groups, "   ");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toBe("Shift Type ID cannot be empty");
  });

  it("rejects a reserved keyword (case-insensitive)", () => {
    const res = validateFullEditId(desc, items, groups, "off");
    expect(res.ok).toBe(false);
    expect(res.ok === false && /reserved keyword/i.test(res.message)).toBe(true);
  });

  it("rejects a duplicate item or group id (exact identity)", () => {
    expect(validateFullEditId(desc, items, groups, "D").ok).toBe(false);
    expect(validateFullEditId(desc, items, groups, "SG1").ok).toBe(false);
  });

  it("uses 'Group' label for an empty group id", () => {
    const res = validateFullEditId(desc, items, groups, "", true);
    expect(res.ok === false && res.message).toBe("Group ID cannot be empty");
  });

  it("excludes the entity currently being edited from the duplicate check", () => {
    expect(validateFullEditId(desc, items, groups, "D", false, "D")).toEqual({
      ok: true,
      id: "D",
    });
  });

  it("exact identity: numeric 1 and string '1' do not falsely collide", () => {
    const numericItems = [{ id: 1 }];
    expect(validateFullEditId(desc, numericItems, [], "1")).toEqual({ ok: true, id: "1" });
  });
});

describe("validateInlineId (V4/V5/V6)", () => {
  it("duplicate message names only the edited entity (no trailing 'or group')", () => {
    const res = validateInlineId(desc, items, groups, "D", false);
    expect(res.ok === false && res.message).toBe("This ID is already used by another shift type");
    const groupRes = validateInlineId(desc, items, groups, "SG1", true);
    expect(groupRes.ok === false && groupRes.message).toBe(
      "This ID is already used by another group",
    );
  });

  it("rejects reserved + empty with the same ordering as full-edit", () => {
    expect(validateInlineId(desc, items, groups, "leave").ok).toBe(false);
    expect(validateInlineId(desc, items, groups, "  ").ok).toBe(false);
  });
});
