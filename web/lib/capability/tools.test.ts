import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOL_NAMES, HELP_TOOL_NAMES } from "./tools";

// A registry entry's `toolAccess` claims that certain tools may serve it. That claim
// is worthless unless the names correspond to tools the app registers, so this reads
// the two registration modules' SOURCE and checks the sets agree in both directions.
//
// Reading source rather than importing them is deliberate: importing pulls in
// CopilotKit, the scenario store and Next's router for what is a naming question, and
// the registration call is a literal in both files.
const REGISTRATION_MODULES = [
  "../../components/ai/use-context-tools.ts",
  "../../components/ai/use-help-tools.ts",
];

function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const relative of REGISTRATION_MODULES) {
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    for (const match of source.matchAll(/^\s*name:\s*"([a-z_]+)",$/gm)) {
      names.add(match[1]);
    }
  }
  return names;
}

describe("assistant tool names", () => {
  it("every declared name is a tool the app registers", () => {
    const registered = registeredToolNames();
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(registered.has(name), `"${name}" is declared but never registered`).toBe(true);
    }
  });

  it("every registered tool is declared, so the registry governs all of them", () => {
    const declared = new Set<string>(ASSISTANT_TOOL_NAMES);
    for (const name of registeredToolNames()) {
      expect(declared.has(name), `"${name}" is registered but not declared in tools.ts`).toBe(true);
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
