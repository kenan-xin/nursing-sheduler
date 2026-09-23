import { describe, expect, it } from "vitest";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";
import { CAPABILITY_ENTRIES } from "@/lib/capability/help-content";
import { ASSISTANT_COMMAND_TYPES } from "@/lib/proposal/commands";
import {
  ASSISTANT_WRITE_TABLES,
  NurseSchedulerDb,
  SCENARIO_WRITE_TABLES,
} from "@/lib/repository/schema";

// This file reads NO source text. Every claim below is asked of a production export or of
// the constructed Dexie schema; the three regex/`indexOf` parsers it used to run (a Zod
// union, a help-registry object, and the repository schema) are gone, and the repository
// import that replaced the last of them is named as one exact entry in `.oxlintrc.json`.

// PHASE-2 ABSENCE, as a source-level property rather than a reading of the diff.
//
// The product index splits delivery in two: Phase 1 is setup, help and
// infeasibility diagnosis over the SCENARIO; Phase 2 is minimal-change repair of a
// working ROSTER, and it is gated on a stable roster document plus a
// minimal-change re-optimisation capability that does not exist. The deferred
// roster-assistance flow is explicit that the current fresh-roster optimizer cannot
// validate a specific swap or preserve unaffected assignments.
//
// So the release gate for T11 is not "we did not mean to build Phase 2". It is that
// the model-visible surface CANNOT express a roster mutation: every tool the agent
// can call and every operation a proposal can carry is enumerated here, and a new
// one cannot appear without this file changing. That makes a Phase-2 leak a
// deliberate edit under review rather than something to notice later.

/**
 * Every tool the model may call, across all of T04, T06, T07 and T10.
 *
 * All of them read the scenario, read the versioned help registry, ask the HOST to
 * navigate, prepare a host-owned Preview, or test copied candidates against the real
 * optimizer. None of them mutates anything, and none of them names a roster.
 */
const MODEL_VISIBLE_TOOLS = [
  // T04 — read the current scenario.
  "get_schedule_overview",
  "get_schedule_section",
  // T06 — read the versioned help/capability registry, and host-owned navigation.
  "list_app_capabilities",
  "explain_app_capability",
  "suggest_scheduling_rule",
  "open_app_screen",
  // T07 — prepare a host-rendered Preview. Apply is structurally not a tool.
  "prepare_scenario_change",
  // T10 — submit bounded copied candidates to the optimizer.
  "test_feasibility_candidates",
] as const;

/**
 * Every operation a prepared proposal may carry. All four address the SCENARIO
 * (its date range, its rules, its staffing numbers, its leave), never assignments
 * in a produced roster.
 */
// WIDENED DELIBERATELY (2026-09-23, plan assistant-add-shift-types): shift setup is
// Phase-1 scenario authoring, not roster repair, and both arms compile to the Shifts
// page's own primitives. A Phase-2 verb here would still be caught by PHASE_2_VERBS.
// WIDENED DELIBERATELY (2026-09-24, plan assistant-rule-ops): creating and editing
// rules is Phase-1 scenario authoring. Each arm fills a rule editor's own form draft
// and runs its own validator/builder; none acts on a produced roster.
const PROPOSAL_OPERATIONS = [
  "set_roster_range",
  "set_rule_enabled",
  "set_staffing_requirement_people",
  "move_leave",
  "add_shift_type",
  "add_shift_group",
  "add_succession_rule",
  "edit_succession_rule",
] as const;

/**
 * Vocabulary that would only appear in a name if Phase-2 roster assistance had
 * started. `set_roster_range` is deliberately NOT caught by this: it sets the
 * scheduling period on the scenario, which is Phase-1 setup — the tell is a verb
 * that acts on assignments, not the noun "roster".
 */
const PHASE_2_VERBS = /repair|swap|reassign|minimal[_-]?change|disrupt|shortage|re[_-]?optimi/i;

/**
 * The model-visible surface, taken from the CANONICAL REGISTRY rather than from a scan
 * of the source tree.
 *
 * This suite used to walk the tree itself, then delegated to a custom TypeScript
 * inventory. Neither is needed any more: registration goes through one wrapper, only that
 * wrapper may import `useFrontendTool` (Oxlint `no-restricted-imports`), and that the
 * shipped session actually mounts these names is proven at runtime by the provider-backed
 * proof in `components/ai/session-real-core.test.tsx`.
 */
function registeredToolNames(): string[] {
  return [...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS), ...PARAMETERLESS_MODEL_VISIBLE_TOOLS];
}

describe("the model-visible surface cannot express a Phase-2 roster change", () => {
  it("registers exactly the enumerated tools, and no others", () => {
    const registered = registeredToolNames();
    // Sensitivity: an empty registry would satisfy a subset assertion for the wrong reason.
    expect(registered.length).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual([...MODEL_VISIBLE_TOOLS].sort());
  });

  it("names no tool after a roster-repair capability", () => {
    for (const name of registeredToolNames()) {
      expect(PHASE_2_VERBS.test(name), `${name} reads as Phase-2 work`).toBe(false);
    }
  });

  it("accepts exactly the enumerated proposal operations", () => {
    // WHAT CHANGED (custom-AST ticket 3). This used to regex `z.literal("...")` out of
    // `lib/proposal/commands.ts` as TEXT, on the argument that the assertion was about
    // what the SOURCE declares and an import would only prove a value equals itself.
    // That argument was wrong in a specific way: the source read proved nothing about the
    // SCHEMA either -- it proved something about the file's spelling, and a reshaped union
    // would have yielded an empty list and passed vacuously.
    //
    // The list is now exported, and two conditional-type predicates beside the union make
    // it exhaustive in BOTH directions. So "a new arm exists that this file does not know
    // about" is caught by `tsc --noEmit`, and what is left here is the question this file
    // actually owns: are the operations the ones Phase 1 is allowed to have?
    expect([...ASSISTANT_COMMAND_TYPES].sort()).toEqual([...PROPOSAL_OPERATIONS].sort());
  });

  it("can point at roster generation, but has no way to start one", () => {
    // The "could you generate the roster?" journey is deliberately a HELP answer plus
    // a host navigation, not an action: `generate-roster` is a registry entry with a
    // route and a control anchor and an EMPTY `supportedCommands`, so the assistant
    // can explain it and take the user there while the run itself stays the user's.
    // A non-empty command list here would be the first step toward the assistant
    // starting official runs on its own.
    //
    // WHAT CHANGED (custom-AST ticket 3). This used to `indexOf` the entry's id in the
    // help-content SOURCE and slice forward to the next `},` -- a hand-rolled object
    // parser that a trailing comment, a nested object or a reordered field would have
    // silently mis-sliced, producing a block that satisfied `toContain` for the wrong
    // reason. The registry is an ordinary exported value; reading it is both simpler and
    // exact.
    const entry = CAPABILITY_ENTRIES.find((candidate) => candidate.id === "generate-roster");
    expect(entry, "the generate-roster entry is missing").toBeDefined();
    expect(entry?.routeId).toBe("optimize-and-export");
    expect(entry?.controlAnchor).toBe("optimize.run-options");
    expect(entry?.supportedCommands).toEqual([]);
  });

  it("can reach no roster table from any transaction the assistant may start", () => {
    // Phase 2 is gated on a versioned working roster the assistant can read and revise.
    //
    // WHAT CHANGED, AND WHY IT HAD TO. This used to assert that the database declares no
    // table matching /roster/ AT ALL. That claim was true only while the roster feature
    // did not exist. It does now: the roster storage foundation owns `roster`, `snapshot`
    // and `meta`, and the two Dexie ladders that used to fight over this database name
    // were merged into the single one in `lib/repository/schema.ts`. Keeping the old
    // assertion would have meant either refusing that merge or deleting the check.
    //
    // Neither is right, because the old assertion was a PROXY. What Phase-2 absence needs
    // is not "no roster bytes exist anywhere in the origin" -- it is that the ASSISTANT
    // cannot address them. So the check now names the two table sets that bound every
    // durable transaction assistant code can open, and asserts a roster table is in
    // neither. That is strictly closer to the property, and it is not vacuous: adding
    // `roster` to either constant to let an assistant tool touch a roster document fails
    // here, which is exactly the first step a Phase-2 leak would take.
    //
    // The other half of the guarantee is enforced elsewhere and asserted above: the
    // model-visible tool list, the proposal operation union, and `generate-roster`
    // carrying an empty `supportedCommands`. `.oxlintrc.json` closes the import edge in
    // both directions.
    const rosterTables = (names: readonly string[]): string[] =>
      names.filter((name) => /^(roster|snapshot|meta)$/.test(name));

    // Sensitivity: both sets must be the real, populated things, or the negative below
    // would hold for entirely the wrong reason.
    expect(ASSISTANT_WRITE_TABLES).toContain("assistantMessages");
    expect(SCENARIO_WRITE_TABLES).toContain("scenarioEnvelopes");

    expect(rosterTables(ASSISTANT_WRITE_TABLES), "an assistant write may touch a roster").toEqual(
      [],
    );
    expect(
      rosterTables(SCENARIO_WRITE_TABLES),
      "a fenced scenario write may touch a roster",
    ).toEqual([]);

    // And the assistant's own durable tables are still exactly the enumerated set, so a
    // NEW assistant-owned roster table cannot appear without this list changing.
    const db = new NurseSchedulerDb("phase-2-absence-schema-probe");
    try {
      const declared = db.tables.map((table) => table.name);
      // Non-vacuity: the schema really parsed.
      expect(declared).toContain("scenarioEnvelopes");
      expect(declared.filter((name) => /^assistant|^diagnostic/.test(name)).sort()).toEqual([
        "assistantClearOperations",
        "assistantGenerations",
        "assistantMessages",
        "assistantProposals",
        "assistantReceipts",
        "assistantSettings",
        "assistantThreads",
        "assistantTurns",
        "diagnosticSearches",
      ]);
    } finally {
      db.close();
    }
  });
});
