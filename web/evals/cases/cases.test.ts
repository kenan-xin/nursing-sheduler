import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ASSISTANT_COMMAND_TYPES } from "@/lib/proposal/commands";
import { buildSeed } from "../lib/harness";
import { seedSavedRoster } from "../lib/saved-roster";
import type { ScenarioUiState } from "@/lib/scenario";
import { ALL_CASES } from "./index";

/**
 * A `holdout` case runs on a schedule that is not one of the shared tuning fixtures (the
 * `small` / `complete` / `sixNurses` / `mna` builders, the named SCENARIOS and the flow YAMLs).
 * Run them to check generalization, but never rewrite the playbook to fit one held-out
 * trajectory: promote a recurring failure into a tuning case first (v1 ai_eval README,
 * `cases/basics/09-holdout/`).
 */
const KNOWN_TAGS = new Set([
  "smoke",
  "repair",
  "flow",
  "sg",
  "safety",
  "grounding",
  "regression",
  "holdout",
]);
const TYPES: readonly string[] = ASSISTANT_COMMAND_TYPES;

describe("the eval case set", () => {
  it("has 42 cases with unique ids and known tags", () => {
    expect(ALL_CASES).toHaveLength(42);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    for (const c of ALL_CASES)
      for (const t of c.tags) expect(KNOWN_TAGS, `${c.id}: ${t}`).toContain(t);
  });

  it("marks exactly 8 smoke cases", () => {
    expect(ALL_CASES.filter((c) => c.tags.includes("smoke"))).toHaveLength(8);
  });

  it("keeps the holdout cases off the shared tuning fixtures", () => {
    expect(ALL_CASES.filter((c) => c.tags.includes("holdout")).map((c) => c.id)).toEqual([
      "safety-stored-injection",
    ]);
  });

  it("expects a rest rule to be relaxed with the warning, never refused", () => {
    const off = ALL_CASES.find((c) => c.id === "safety-turn-off-rest-rule");
    expect(off?.expect.restWarning).toBe(true);
    expect(off?.expect.neverTouchRuleUids ?? []).not.toContain("no-day-after-night");
    expect(off?.expect.judge?.join(" ")).not.toMatch(/Declines/);
    const check = off?.expect.proposalCheck;
    expect(
      check?.([
        {
          type: "set_rule_enabled",
          ruleKind: "successions",
          ruleId: "no-day-after-night",
          enabled: false,
        },
      ]),
    ).toBeNull();
    expect(check?.([])).not.toBeNull();
  });

  it("has a case that the long 08:00-20:30 shift is within the 12-hour limit", () => {
    const long = ALL_CASES.find((c) => c.id === "sg-long-shift-hours");
    expect(long?.expect.noProposal).toBe(true);
    expect(long?.expect.judge?.join(" ")).toMatch(/illegal/);
  });

  it("asks a ratio question for the ward's own numbers on a card, never a default (7xw)", () => {
    const c = ALL_CASES.find((x) => x.id === "sg-ratio");
    expect(c?.expect.noProposal).toBe(true);
    expect(c?.expect.toolsCalled).toContain("offer_choices");
    const rubric = c?.expect.judge?.join(" ") ?? "";
    expect(rubric).toMatch(/ward decides its own numbers/);
    expect(rubric).toMatch(/Does not invent or give a default ratio number/);
  });

  it("builds every seed", () => {
    for (const c of ALL_CASES) expect(() => buildSeed(c.seed), c.id).not.toThrow();
  });

  it("saves every case's roster through the app's capture path", async () => {
    expect(ALL_CASES.find((c) => c.id === "sg-mc-cover")?.savedRoster).toBeDefined();
    for (const c of ALL_CASES)
      if (c.savedRoster) await seedSavedRoster(buildSeed(c.seed) as ScenarioUiState, c.savedRoster);
  });

  it("names only real operation types", () => {
    for (const c of ALL_CASES) {
      for (const op of c.expect.proposalOps ?? []) expect(TYPES, c.id).toContain(op.type);
      for (const type of c.expect.onlyOpTypes ?? []) expect(TYPES, c.id).toContain(type);
    }
  });
});
