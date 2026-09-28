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
  CHOICE_OPTION_RULES,
  FEASIBILITY_INSTRUCTIONS,
  MAX_DAILY_WORKING_MINUTES,
  PLAYBOOK_VERSION,
  REPAIRS,
  REPAIR_ORDER,
  BALANCE_RULE_NOTE,
  REST_PRACTICE_WARNING,
  SAFETY_FLOOR,
  SETUP_INSTRUCTIONS,
  TRUTHFUL_SUMMARY_RULE,
  SETUP_STEPS,
  relaxesRestRule,
  setsBalanceRule,
} from "./playbook";
import type { AssistantCommandV1 } from "@/lib/proposal/commands";

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

describe("after a fix is applied (bead 2vtv)", () => {
  it("offers a run through the card and reports whether the schedule can now be built", () => {
    const line = FEASIBILITY_INSTRUCTIONS.find((l) => l.includes("request_optimize_run"));
    expect(line).toMatch(/After the user applies a fix/);
    expect(line).toMatch(/never say a run has started/);
    expect(line).toMatch(/get_optimize_result/);
    expect(line).toMatch(/whether the schedule can now be built/);
  });
});

describe("repair catalogue", () => {
  it("adds a regular staff member only for a chronic shortage, as the manager's Apply", () => {
    const add = REPAIRS.find((repair) => repair.id === "add_staff_member")!;
    expect(add).toMatchObject({
      confirmation: "manager",
      enforcedBy: "apply",
      opTypes: ["add_person"],
    });
    expect(REPAIR_ORDER.chronic).toEqual([
      "align_overlapping_requirements",
      "borrow_temporary_nurse",
      "add_staff_member",
      "run_one_short",
      "split_long_shift",
    ]);
    for (const situation of ["capped", "acute", "unexplained"] as const) {
      expect(REPAIR_ORDER[situation]).not.toContain("add_staff_member");
    }
  });

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
    // A hard contracted minimum comes first when one exists (4h5a): it is a floor the
    // static check cannot see in the staffing findings.
    expect(REPAIR_ORDER.unexplained).toEqual([
      "relax_contracted_hours",
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
    const soften = REPAIRS.filter((repair) => repair.opTypes.includes("edit_shift_sequence_rule"));
    expect(soften.map((repair) => repair.id)).toEqual(["soften_rest_rule"]);
    expect(soften[0].opTypes).toEqual(["edit_shift_sequence_rule"]);
    expect(soften[0].guardrail).toMatch(/warning/);
  });

  it("never shows the model the 'succession rule' jargon (bead nj3q)", () => {
    const shown = JSON.stringify([SETUP_STEPS, SETUP_INSTRUCTIONS, REPAIRS]);
    expect(shown).not.toMatch(/succession[_ ]rule/i);
  });

  it("never lists a turn-off, add-rest or rule-removal operation", () => {
    const banned = ["set_rule_enabled", "remove_rule", "add_shift_sequence_rule"];
    for (const repair of REPAIRS) {
      for (const op of repair.opTypes) expect(banned, `${repair.id}: ${op}`).not.toContain(op);
    }
  });

  it("books a temporary cover, agreed in chat, and never a roster person", () => {
    const borrow = REPAIRS.find((repair) => repair.id === "borrow_temporary_nurse")!;
    expect(borrow.enforcedBy).toBe("chat");
    expect(borrow.confirmation).toBe("lending_ward");
    expect(borrow.opTypes).toEqual(["add_temporary_cover"]);
    expect(borrow.title).toMatch(/temporary cover/i);
    expect(borrow.guardrail).toMatch(/group/);
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
      type: "edit_shift_sequence_rule" as const,
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

  it("spots a change that adds or sets a balance rule, and nothing else", () => {
    // bead hnd: a fairness rule can slow the run or end it without proof it is the best.
    const count = (expression: string, type = "add_count_rule") =>
      ({
        type,
        ruleId: "r",
        description: "Fair nights",
        people: ["ALL"],
        shiftTypes: ["N"],
        dates: ["ALL"],
        expression,
        target: 1,
        weight: "-5",
      }) as unknown as AssistantCommandV1;
    expect(setsBalanceRule([count("|x - T|^2")])).toBe(true);
    expect(setsBalanceRule([count("|x - T|^2", "edit_count_rule")])).toBe(true);
    for (const linear of ["x <= T", "x >= T", "x = T", "x < T", "x > T"])
      expect(setsBalanceRule([count(linear)]), linear).toBe(false);
    expect(BALANCE_RULE_NOTE).toMatch(/take longer/);
    expect(BALANCE_RULE_NOTE).toMatch(/not proven the best/);
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

  it("recommends a 28-day roster period first and the calendar month second (cei5)", () => {
    const text = ask("dates");
    expect(text).toMatch(/28 days \(4 weeks\)/);
    expect(text).toMatch(/4 weeks: 1-28 Oct/);
    // With history, continue the cycle from the day after the last period.
    expect(text).toMatch(/day after the last period \+ 27 days/);
    expect(text).toMatch(/calendar month as the second option/);
    // 28 days is the first option, never the only one.
    expect(text).toMatch(/Never present 28 days as "only"/);
  });
  it("asks the leave question on a choice card with the two common answers (cei5)", () => {
    const text = ask("requests");
    expect(text).toMatch(/offer_choices/);
    expect(text).toMatch(/Nobody has leave or days off/);
    expect(text).toMatch(/Yes, I will list them/);
    // The free-text box stays for the days themselves.
    expect(text).toMatch(/free-text box/);
  });
  it("sends every setup question with a short, common answer set to a choice card (cei5)", () => {
    expect(SETUP_INSTRUCTIONS[0]).toMatch(/short, common answer set/);
    expect(SETUP_INSTRUCTIONS[0]).toMatch(/always goes on a choice card/);
  });
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
  it("suggests 2 rest days in any 7 days in a row as a strong preference, rolling, with history", () => {
    const text = ask("rules");
    expect(text).toMatch(/2 rest days in any 7 days in a row/);
    expect(text).toMatch(/add_rest_days_rule/);
    expect(text).toMatch(/strong preference/);
    expect(text).toMatch(/any 7 days in a row, not Monday to Sunday/);
    // The legal floor stays a must, labelled so on the card.
    expect(text).toMatch(/label.*a must/);
    // Without history the first days of the roster cannot look back.
    expect(text).toMatch(/last 6 days of the previous month/);
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
  it("sends working together, apart, and supervision to their own ops (31og)", () => {
    const rules = SETUP_STEPS.find((s) => s.id === "rules")!;
    expect(rules.proposeWith).toEqual(
      expect.arrayContaining(["add_pairing_rule", "add_supervision_rule"]),
    );
    const ask = rules.ask.join(" ");
    expect(ask).toMatch(/together or apart/);
    expect(ask).toMatch(/add_pairing_rule/);
    expect(ask).toMatch(/add_supervision_rule/);
    const help = CAPABILITY_ENTRIES.find((e) => e.id === "ai-assistant-conversation");
    expect(help?.nurseFacingSummary).not.toMatch(/cannot yet create pairing/);
  });
  it("asks on a card about any shift with no staffing requirement (4h5a)", () => {
    const text = ask("rules");
    expect(text).toMatch(/no staffing requirement, on a choice card/);
    expect(text).toMatch(/never guess/);
  });
  it("checks capacity against demand and spends spare shifts in the ward's order (4h5a)", () => {
    const rules = SETUP_STEPS.find((s) => s.id === "rules")!;
    const text = rules.ask.join(" ");
    expect(text).toMatch(/staffingBalance/);
    expect(text).toMatch(/spareShifts/);
    // Senior lead slot first, then a 3rd morning, then a 3rd afternoon, by weight.
    expect(text).toMatch(/optional senior lead slot.*3rd nurse on mornings.*3rd on afternoons/);
    expect(text).toMatch(/-300, -200 and -100/);
    expect(text).toMatch(/add_contracted_hours/);
    expect(rules.proposeWith).toContain("add_contracted_hours");
  });
  it("prefers a contracted target over a days-off cap, and never an impossible cap (4h5a)", () => {
    const text = ask("rules");
    expect(text).toMatch(/Prefer a contracted working target over a cap on days off/);
    expect(text).toMatch(/fewestOffDaysEach/);
    expect(text).toMatch(/show the arithmetic/);
    // A hard contract floor above what the numbers allow has no roster.
    expect(text).toMatch(/mostShifts/);
  });
  it("says 'about' when the capacity rests on an assumption (4h5a)", () => {
    const text = ask("rules");
    expect(text).toMatch(/staffingBalance.estimated/);
    expect(text).toMatch(/say 'about'/);
  });
  it("suggests lowering a contracted minimum after an infeasible run (4h5a)", () => {
    const text = FEASIBILITY_INSTRUCTIONS.join(" ");
    expect(text).toMatch(/contracted minimum/);
    expect(REPAIRS.find((r) => r.id === "relax_contracted_hours")?.opTypes).toEqual([
      "edit_contracted_hours",
    ]);
  });
  it("never calls a rule over any 7 days in a row impossible (4h5a)", () => {
    const text = ask("rules");
    expect(text).toMatch(/Never say a rule over any 7 days in a row is impossible/);
  });
  it("maps 'optional, ideally N' to a preferred count, never to required 0 alone (hg9v)", () => {
    const ask = SETUP_STEPS.find((s) => s.id === "rules")!.ask.join(" ");
    expect(ask).toMatch(/ideally N/);
    expect(ask).toMatch(/preferredNumPeople/);
    expect(ask).toMatch(/required count alone is exact/);
    expect(ask).toMatch(/0 alone forbids the shift/);
  });
  it("holds every summary to what its operations do (hg9v)", () => {
    expect(SETUP_INSTRUCTIONS).toContain(TRUTHFUL_SUMMARY_RULE);
  });
  it("was versioned", () => {
    expect(PLAYBOOK_VERSION).toBe("2026-09-28.3");
  });
});

describe("choice cards carry concrete answers (tpt2)", () => {
  it("tells the model to write each option as a complete answer with concrete values", () => {
    const text = CHOICE_OPTION_RULES.join(" ");
    expect(text).toMatch(/complete, self-explanatory answer/);
    expect(text).toMatch(/concrete numbers with their unit/);
    expect(text).toMatch(/free-text box/);
    expect(text).toMatch(/'Set a number'/);
    expect(text).toMatch(/'Choose a value'/);
    expect(text).toMatch(/'Custom'/);
    expect(text).toMatch(/'Other value'/);
    expect(text).toMatch(/'Enter a number'/);
  });

  it("forbids re-asking a question the user already answered", () => {
    expect(CHOICE_OPTION_RULES.join(" ")).toMatch(
      /Never re-ask a question the user already answered/,
    );
  });
});
