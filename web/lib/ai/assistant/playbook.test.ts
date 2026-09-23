import { describe, expect, it } from "vitest";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";
import { getNavGroupsForMode } from "@/components/shell/nav-config";
import { CAPABILITY_ENTRIES } from "@/lib/capability/help-content";
import { ASSISTANT_COMMAND_TYPES } from "@/lib/proposal/commands";
import { PLAYBOOK_VERSION, REPAIRS, REPAIR_ORDER, SAFETY_FLOOR, SETUP_STEPS } from "./playbook";

describe("setup steps", () => {
  it("follow the Home guided order, then review", () => {
    // The Home cards and the assistant must walk the same order, or the user sees two plans.
    const HOME_PATH: Record<string, string> = {
      "/dates": "dates",
      "/people": "people",
      "/shift-types": "shiftTypes",
      "/rules": "rules",
      "/shift-requests": "requests",
      "/optimize-and-export": "run",
    };
    const home = getNavGroupsForMode("guided")
      .flatMap((group) => group.items)
      .filter((item) => item.guidedStep != null)
      .sort((a, b) => (a.guidedStep ?? 0) - (b.guidedStep ?? 0))
      .map((item) => HOME_PATH[item.path]);
    expect(SETUP_STEPS.map((step) => step.id)).toEqual([...home, "review"]);
  });

  it("only name operations and tools the app ships", () => {
    // Fails until the dependency plans land with these exact names (see Preconditions).
    const shipped = new Set<string>([
      ...ASSISTANT_COMMAND_TYPES,
      ...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS),
      ...PARAMETERLESS_MODEL_VISIBLE_TOOLS,
    ]);
    for (const step of SETUP_STEPS) {
      for (const name of step.proposeWith)
        expect(shipped.has(name), `${step.id}: ${name}`).toBe(true);
    }
  });

  it("point at real capability ids, and only requests is optional", () => {
    const ids = new Set<string>(CAPABILITY_ENTRIES.map((entry) => entry.id));
    for (const step of SETUP_STEPS) expect(ids.has(step.capabilityId), step.id).toBe(true);
    expect(SETUP_STEPS.filter((step) => step.optional).map((step) => step.id)).toEqual([
      "requests",
    ]);
  });
});

describe("repair catalogue", () => {
  it("has a version, unique ids, and every ranked id exists", () => {
    expect(PLAYBOOK_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const ids = REPAIRS.map((repair) => repair.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const order of Object.values(REPAIR_ORDER)) {
      for (const id of order) expect(ids).toContain(id);
    }
  });

  it("asks a named nurse only through a host question", () => {
    for (const repair of REPAIRS) {
      if (
        repair.confirmation === "named_nurse" &&
        repair.opTypes.some((op) => op === "clear_requests")
      ) {
        expect(repair.enforcedBy).toBe("host_question");
      }
    }
  });

  it("never lists a rest, supervision or rule-removal operation", () => {
    const banned = [
      "set_rule_enabled",
      "remove_rule",
      "add_succession_rule",
      "edit_succession_rule",
    ];
    for (const repair of REPAIRS) {
      for (const op of repair.opTypes) expect(banned, `${repair.id}: ${op}`).not.toContain(op);
    }
  });

  it("states the safety floor in ward words", () => {
    const text = SAFETY_FLOOR.join(" ");
    expect(text).toMatch(/rest/i);
    expect(text).toMatch(/RN|skill/);
    expect(text).toMatch(/sick/i);
    expect(text).toMatch(/0|zero/);
  });
});
