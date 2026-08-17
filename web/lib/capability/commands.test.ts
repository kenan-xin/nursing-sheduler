import { describe, expect, it } from "vitest";
import { SCENARIO_COMMAND_TYPES_V1 } from "@/lib/repository/commands";
import { SCENARIO_COMMAND_TYPES } from "./commands";

// The drift gate for the one list the capability registry restates rather than derives.
//
// WHAT CHANGED (custom-AST ticket 2). This test used to read `lib/repository/commands.ts`
// as SOURCE TEXT and regex the `type: "…"` discriminants out of the union, because
// `lib/capability` may not import the repository. Two things were wrong with that: it was
// a hand-rolled parser over a type declaration, and a refactor that reshaped the union
// made the extraction return nothing rather than fail — which is why the old file needed
// a "finds the union it is asserting against" guard.
//
// The repository now EXPORTS its discriminants as a value, with two conditional-type
// predicates beside the union that fail `tsc --noEmit` if the value and the type ever
// disagree. So a new command arm is caught by the compiler, not by this file, and this
// file is left with the question it actually owns: does the capability registry's
// restatement still match?
//
// The import is a boundary crossing, and a deliberate one: this is a TEST, so it creates
// no production dependency from `lib/capability` into the repository, and it is listed by
// name in the Oxlint repository allow-list rather than admitted by a pattern.

describe("capability command types track the repository's command union", () => {
  it("lists every command the repository can apply", () => {
    for (const type of SCENARIO_COMMAND_TYPES_V1) {
      expect(
        (SCENARIO_COMMAND_TYPES as readonly string[]).includes(type),
        `"${type}" is a repository command but is missing from lib/capability/commands.ts`,
      ).toBe(true);
    }
  });

  it("lists nothing the repository cannot apply", () => {
    const real = new Set<string>(SCENARIO_COMMAND_TYPES_V1);
    for (const type of SCENARIO_COMMAND_TYPES) {
      expect(real.has(type), `"${type}" is not a repository command any more`).toBe(true);
    }
  });

  it("is unique, and is not comparing two empty lists", () => {
    expect(SCENARIO_COMMAND_TYPES.length).toBeGreaterThan(0);
    expect(SCENARIO_COMMAND_TYPES_V1.length).toBeGreaterThan(0);
    expect(new Set(SCENARIO_COMMAND_TYPES).size).toBe(SCENARIO_COMMAND_TYPES.length);
  });
});
