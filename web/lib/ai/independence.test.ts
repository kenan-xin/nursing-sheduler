import { describe, expect, it } from "vitest";

import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";

// AI INDEPENDENCE — the residual after custom-AST ticket 2.
//
// The product promise is that AI is optional: with the feature off, no key stored, or
// OpenRouter unreachable, every manual workflow and ordinary Optimize keeps working. A
// functional test can only ever sample that; what guarantees it is that no scheduling
// code DEPENDS on assistant code.
//
// FOUR OF THE SEVEN RULES THAT USED TO LIVE HERE HAVE MOVED, because Oxlint expresses
// them on the resolved specifier rather than on a regular expression over file text:
//
//   • "referenced only by itself, its UI, and an explicit list of mount points" and
//     "kept out of the scheduling and optimize surfaces entirely" → a
//     `no-restricted-imports` pattern group over `@/lib/ai**` and `@/components/ai**`,
//     plus a regex over relative paths into `ai/`, with the former PERMITTED_REFERENCES
//     table encoded as the file list of one override. The old rules matched the string
//     `"@/(lib/ai|components/ai)/"`, so a relative import was invisible to them; the
//     replacement catches it.
//   • "lets the repository know the row shapes WITHOUT a runtime edge" → the same rule
//     with `allowTypeImports: true` scoped to `lib/repository/**`. This is a strictly
//     better mechanism: the old version regexed import STATEMENTS and reasoned about
//     where the `type` keyword sat, which is precisely the kind of hand-rolled parsing
//     this migration exists to remove.
//   • "holds no scenario commit path of its own" and "reaches durable state only
//     through the named assistant proposal commands" → `no-restricted-properties` with
//     `{ object: "assistantProposalCommands", allowProperties: […] }`, which is an
//     ALLOW-list and therefore the same shape as the guarantee, plus
//     `{ object: "scenarioCommands", allowProperties: [] }`. `createScenarioRepository`
//     and `commitAssistantProposal` need no rule of their own: they live in
//     `@/lib/repository`, which assistant code cannot import at all.
//
// WHAT IS LEFT, AND WHY. One family remains here, and it is not a source scan: it reads
// the canonical tool registry. Nothing below claims Oxlint parity.
//
// THE READER IS GONE (custom-AST ticket 6, reader-ledger row 16). This file used to walk
// the whole `web/` tree with `readdirSync` and read every `.ts`/`.tsx` file with
// `readFileSync`. By the end of ticket 3 nothing consumed the TEXT any more -- the two
// families that did had become `assistant-scenario-table-authorship` and
// `openrouter-host-literal` (see the footer) -- and the walk survived feeding a single
// "finds the sources it is guarding" premise test. That premise had become vacuous in the
// strict sense: it guarded a scan that no longer existed, so it could not fail for any
// reason connected to a real guarantee. Row 16 is classified `Migrate; no exception`, and
// a dead reader is the clearest possible case of one. The non-vacuity it used to provide
// now belongs to `ast-grep test`, which fails when a rule stops matching its own invalid
// fixtures, and to the `toolNames.length` assertion below.

describe("the assistant is a leaf, not a dependency", () => {
  it("registers no tool that could apply a change", () => {
    // Apply is a HOST action on a rendered card. A tool named for it -- however it
    // were implemented -- would let the model announce that it can make the change
    // itself, which is the one thing the whole Preview contract exists to prevent.
    //
    // Read from the CANONICAL REGISTRY rather than by regexing `name: "…"` out of the
    // registration modules. A tool can only reach the model through
    // `useModelVisibleTool`, which takes its schema from that registry, so this is the
    // shipped set rather than a set of literals that happened to match a pattern.
    const toolNames = [
      ...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS),
      ...PARAMETERLESS_MODEL_VISIBLE_TOOLS,
    ];
    expect(toolNames.length).toBeGreaterThan(0);

    const applyish = toolNames.filter((name) => /apply|commit|save|write|undo|delete/.test(name));
    expect(applyish).toEqual([]);
    // The one write-adjacent tool there IS prepares a proposal and nothing else.
    expect(toolNames).toContain("prepare_scenario_change");
  });
});

// MIGRATED IN TICKET 3. Two families that lived here are now declarative ast-grep rules,
// because both are authored-source shapes that no production API, type or lint rule can
// express:
//
//   • "writes only assistant tables, never a scenario-authority table" →
//     `ast-grep/rules/assistant-scenario-table-authorship.yml`. The forbidden shape is
//     `db.<table>.put(…)`, a two-level access whose receiver is itself a member
//     expression, and the SAME access with `.get(…)` is required -- so the rule must
//     separate reads from writes on one table, which `no-restricted-properties` cannot.
//   • "reaches OpenRouter from exactly one place" →
//     `ast-grep/rules/openrouter-host-literal.yml`. The subject is an authored literal,
//     not a specifier, and a hard-coded host that equals the constant is byte-identical
//     at runtime.
//
// Both rules carry valid/invalid fixtures and were mutation-proved against real
// production files before this file stopped checking them.
