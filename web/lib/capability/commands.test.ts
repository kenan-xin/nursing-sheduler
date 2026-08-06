import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIO_COMMAND_TYPES } from "./commands";

// The drift gate for the one list the capability registry restates rather than
// imports. `lib/capability` may not import `lib/repository` -- the authority boundary
// permits only the projection adapter to -- so agreement is proven by reading the
// repository's command union as SOURCE TEXT. No import, no runtime coupling, and a new
// or renamed command arm still fails a test rather than silently leaving the registry
// describing a write path that no longer exists.

const REPOSITORY_COMMANDS = fileURLToPath(new URL("../repository/commands.ts", import.meta.url));

/** The `type: "..."` discriminants of `ScenarioCommandV1`, read from its source. */
function repositoryCommandTypes(): string[] {
  const source = readFileSync(REPOSITORY_COMMANDS, "utf8");
  const union = source.match(/export type ScenarioCommandV1 =([\s\S]*?);\n/);
  if (!union) throw new Error("could not locate the ScenarioCommandV1 union in its source");
  return [...union[1].matchAll(/\btype:\s*"([a-z_]+)"/g)].map((match) => match[1]);
}

describe("capability command types track the repository's command union", () => {
  it("finds the union it is asserting against", () => {
    // Without this, a refactor that moved or reshaped the union would make the
    // extraction return nothing and both directions below would pass vacuously.
    expect(repositoryCommandTypes().length).toBeGreaterThan(0);
  });

  it("lists every command the repository can apply", () => {
    for (const type of repositoryCommandTypes()) {
      expect(
        (SCENARIO_COMMAND_TYPES as readonly string[]).includes(type),
        `"${type}" is a repository command but is missing from lib/capability/commands.ts`,
      ).toBe(true);
    }
  });

  it("lists nothing the repository cannot apply", () => {
    const real = new Set(repositoryCommandTypes());
    for (const type of SCENARIO_COMMAND_TYPES) {
      expect(real.has(type), `"${type}" is not a repository command any more`).toBe(true);
    }
  });

  it("is unique", () => {
    expect(new Set(SCENARIO_COMMAND_TYPES).size).toBe(SCENARIO_COMMAND_TYPES.length);
  });
});
