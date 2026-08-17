import { describe, expect, it } from "vitest";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "@/components/ai/model-visible-tools";
import { ASSISTANT_TOOL_NAMES, HELP_TOOL_NAMES } from "./tools";

// A registry entry's `toolAccess` claims that certain tools may serve it. That claim is
// worthless unless the names correspond to tools the app registers.
//
// WHAT CHANGED (custom-AST ticket 2). This test used to read the two registration
// modules' SOURCE and regex `name: "…"` literals out of them. The canonical registry
// ticket 1 introduced makes that unnecessary: `MODEL_VISIBLE_TOOL_SCHEMAS` plus
// `PARAMETERLESS_MODEL_VISIBLE_TOOLS` IS the shipped model-visible set, and a tool can
// only reach the model through `useModelVisibleTool`, which takes its schema from there.
// So the comparison is now against values rather than against text, and it can no longer
// pass because a registration was spelled in a way the regex did not anticipate.
//
// The mounted multiset — that the shipped session really registers these eight, under
// this agent id, with these exact schema objects — is proved separately by
// `components/ai/session-real-core.test.tsx` against a real `CopilotKitCore`.

const SHIPPED = [...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS), ...PARAMETERLESS_MODEL_VISIBLE_TOOLS];

/**
 * Shipped tools the capability registry deliberately does NOT govern, each with the
 * reason it is out of scope. Listing them is what keeps the "nothing registered is
 * undeclared" direction honest without silently widening it.
 */
const NOT_REGISTRY_GOVERNED: Record<string, string> = {
  test_feasibility_candidates: "T10 diagnostics: bounded infeasibility search, not a help answer",
  prepare_scenario_change: "T07 proposals: prepares a Preview the HOST applies",
};

describe("assistant tool names", () => {
  it("is comparing against a real shipped set", () => {
    expect(SHIPPED.length).toBeGreaterThan(0);
    expect(new Set(SHIPPED).size).toBe(SHIPPED.length);
  });

  it("every declared name is a tool the app registers", () => {
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(SHIPPED.includes(name), `"${name}" is declared but never registered`).toBe(true);
    }
  });

  it("every registered tool is declared, or is explicitly out of the registry's scope", () => {
    const declared = new Set<string>(ASSISTANT_TOOL_NAMES);
    for (const name of SHIPPED) {
      if (declared.has(name)) continue;
      expect(
        NOT_REGISTRY_GOVERNED[name],
        `"${name}" is registered but neither declared in tools.ts nor listed as out of scope`,
      ).toBeTypeOf("string");
    }
  });

  it("and nothing is excused that is no longer shipped", () => {
    // The other half of the excuse list: an entry that stops being registered has to
    // leave, or the exemption quietly outlives the tool it was written for.
    for (const name of Object.keys(NOT_REGISTRY_GOVERNED)) {
      expect(SHIPPED.includes(name), `"${name}" is excused but no longer registered`).toBe(true);
    }
  });

  it("names are unique", () => {
    expect(new Set(ASSISTANT_TOOL_NAMES).size).toBe(ASSISTANT_TOOL_NAMES.length);
  });

  it("the T06 group is exactly the help tools and contains nothing that can write", () => {
    expect([...HELP_TOOL_NAMES].sort()).toEqual([
      "explain_app_capability",
      "list_app_capabilities",
      "open_app_screen",
      "suggest_scheduling_rule",
    ]);
    // A guard on the ticket's boundary rather than on today's list: no mutation,
    // Apply, proposal or diagnostic tool may appear in the union while T06 owns it.
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(name).not.toMatch(/apply|mutate|write|update_|set_|delete|propose|diagnos/);
    }
  });
});
