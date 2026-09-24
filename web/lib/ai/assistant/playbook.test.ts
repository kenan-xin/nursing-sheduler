import { describe, expect, it } from "vitest";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";
import { getNavGroupsForMode } from "@/components/shell/nav-config";
import { CAPABILITY_ENTRIES } from "@/lib/capability/help-content";
import { ASSISTANT_COMMAND_TYPES } from "@/lib/proposal/commands";
import { paidMinutesFor } from "@/components/entity-editor/core";
import {
  FEASIBILITY_INSTRUCTIONS,
  MAX_DAILY_WORKING_MINUTES,
  PLAYBOOK_VERSION,
  REPAIRS,
  REPAIR_ORDER,
  REST_PRACTICE_WARNING,
  SAFETY_FLOOR,
  SETUP_INSTRUCTIONS,
  SETUP_STEPS,
  relaxesRestRule,
} from "./playbook";

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

  it("guesses only the spec's repairs when the cause is unknown", () => {
    // Spec "Ranking": Unexplained is 1, 3 as hypotheses. A blind borrow is not a guess to test.
    // Softening a rest rule (guidance, not law; 2026-09-24 user decision) comes last.
    expect(REPAIR_ORDER.unexplained).toEqual([
      "soften_hard_request",
      "relax_count_rule",
      "soften_rest_rule",
    ]);
    for (const [situation, order] of Object.entries(REPAIR_ORDER)) {
      if (situation !== "unexplained") expect(order, situation).not.toContain("soften_rest_rule");
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

  it("softens a rest rule only through its own repair, and never turns one off or deletes it", () => {
    const soften = REPAIRS.filter((repair) => repair.opTypes.includes("edit_succession_rule"));
    expect(soften.map((repair) => repair.id)).toEqual(["soften_rest_rule"]);
    expect(soften[0].opTypes).toEqual(["edit_succession_rule"]);
    expect(soften[0].guardrail).toMatch(/warning/);
  });

  it("never lists a turn-off, add-rest or rule-removal operation", () => {
    const banned = ["set_rule_enabled", "remove_rule", "add_succession_rule"];
    for (const repair of REPAIRS) {
      for (const op of repair.opTypes) expect(banned, `${repair.id}: ${op}`).not.toContain(op);
    }
  });

  it("states the safety floor in ward words", () => {
    const text = SAFETY_FLOOR.join(" ");
    // Rest rules are guidance: they may be softened or turned off, never deleted.
    expect(SAFETY_FLOOR[0]).toMatch(/Never delete .*rest rule/);
    expect(text).not.toMatch(/Never relax or turn off a rest rule/);
    expect(text).toMatch(/RN|skill/);
    expect(text).toMatch(/sick/i);
    expect(text).toMatch(/0|zero/);
  });
});

describe("rest rules are guidance, not law", () => {
  it("says so in one plain warning", () => {
    expect(REST_PRACTICE_WARNING).toBe(
      "This is a recommended rest practice, not a legal rule. Nurses may be more tired; consider a day off after nights.",
    );
  });

  it("spots a change that turns off, deletes or softens a rest rule", () => {
    const edit = (weight: string) => ({
      type: "edit_succession_rule" as const,
      ruleId: "r",
      description: "",
      people: ["ALL"],
      pattern: ["N", "D"],
      dates: ["ALL"],
      weight,
    });
    const off = { type: "set_rule_enabled", ruleKind: "successions", ruleId: "r" } as const;
    expect(relaxesRestRule([{ ...off, enabled: false }])).toBe(true);
    expect(relaxesRestRule([{ type: "remove_rule", ruleKind: "successions", ruleId: "r" }])).toBe(
      true,
    );
    expect(relaxesRestRule([edit("-10")])).toBe(true);
    expect(relaxesRestRule([{ ...off, enabled: true }])).toBe(false);
    expect(relaxesRestRule([edit("-infinity")])).toBe(false);
    expect(
      relaxesRestRule([
        { type: "set_rule_enabled", ruleKind: "counts", ruleId: "r", enabled: false },
      ]),
    ).toBe(false);
  });

  it("measures the 12-hour daily limit in working hours, not the clock span", () => {
    expect(MAX_DAILY_WORKING_MINUTES).toBe(12 * 60);
    // Long 08:00-20:30 is a 12.5 h span, but its 2 h break leaves 10.5 h worked.
    expect(paidMinutesFor("08:00", "20:30", 120)).toBe(630);
    expect(paidMinutesFor("08:00", "20:30", 120)!).toBeLessThanOrEqual(MAX_DAILY_WORKING_MINUTES);
    expect(paidMinutesFor("20:00", "08:30", 120)!).toBeLessThanOrEqual(MAX_DAILY_WORKING_MINUTES);
  });
});

describe("setup hints carry ward defaults, never invented law", () => {
  const ask = (id: string) => SETUP_STEPS.find((s) => s.id === id)?.ask.join(" ") ?? "";

  it("suggests common shift patterns to confirm", () => {
    expect(ask("shiftTypes")).toMatch(/three 8-hour shifts/);
    expect(ask("shiftTypes")).toMatch(/12-hour/);
  });
  it("suggests the usual rest and fairness rules, with off-after-nights as a preference", () => {
    const text = ask("rules");
    expect(text).toMatch(/no day shift straight after a night as a must/);
    expect(text).toMatch(/day off after nights as a preference/);
    expect(text).toMatch(/balance/);
  });
  it("frames ward habits as habits; the only law named is the Employment Act rest day", () => {
    const text = ask("rules");
    expect(text).toMatch(/many wards/i);
    expect(text).not.toMatch(/\b(law|MOH|MOM|required by)\b/);
    expect(text).toMatch(/1 rest day a week, which the Employment Act sets/);
  });
  it("builds the weekly rest day as a pattern, never a period total", () => {
    const text = ask("rules");
    expect(text).toMatch(/ALL 7 days in a row at -infinity/);
    expect(text).toMatch(/not a total over the period/);
  });
  it("sets up a skill mix, and never approximates it with a whole-shift group", () => {
    const text = ask("rules");
    expect(text).toMatch(/skill mix/);
    expect(text).toMatch(/set_skill_mix/);
    expect(text).not.toMatch(/not supported yet/);
    expect(text).toMatch(/never approximate/i);
    expect(SETUP_STEPS.find((s) => s.id === "rules")?.proposeWith).toContain("set_skill_mix");
  });
  it("no line says a skill mix cannot be created", () => {
    const all = [
      ...SETUP_STEPS.flatMap((s) => s.ask),
      ...SAFETY_FLOOR,
      ...FEASIBILITY_INSTRUCTIONS,
    ].join(" ");
    expect(all).not.toMatch(/cannot create|never create|not supported yet/i);
  });
  it("asks a step's pick-one questions on one card, never as plain text (dt9)", () => {
    expect(SETUP_INSTRUCTIONS[0]).toMatch(/offer_choices/);
    expect(SETUP_INSTRUCTIONS[0]).toMatch(/moreQuestions/);
    expect(SETUP_INSTRUCTIONS[0]).not.toMatch(/all at once, in plain words/);
  });
  it("was versioned", () => {
    expect(PLAYBOOK_VERSION).toBe("2026-09-24.9");
  });
});
