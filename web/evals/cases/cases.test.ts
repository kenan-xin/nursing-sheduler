import { describe, expect, it } from "vitest";
import { ASSISTANT_COMMAND_TYPES } from "@/lib/proposal/commands";
import { buildSeed } from "../lib/harness";
import { ALL_CASES } from "./index";

const KNOWN_TAGS = new Set(["smoke", "repair", "flow", "sg", "safety", "grounding", "regression"]);
const TYPES: readonly string[] = ASSISTANT_COMMAND_TYPES;

describe("the eval case set", () => {
  it("has 29 cases with unique ids and known tags", () => {
    expect(ALL_CASES).toHaveLength(29);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    for (const c of ALL_CASES)
      for (const t of c.tags) expect(KNOWN_TAGS, `${c.id}: ${t}`).toContain(t);
  });

  it("marks exactly 8 smoke cases", () => {
    expect(ALL_CASES.filter((c) => c.tags.includes("smoke"))).toHaveLength(8);
  });

  it("builds every seed", () => {
    for (const c of ALL_CASES) expect(() => buildSeed(c.seed), c.id).not.toThrow();
  });

  it("names only real operation types", () => {
    for (const c of ALL_CASES) {
      for (const op of c.expect.proposalOps ?? []) expect(TYPES, c.id).toContain(op.type);
    }
  });
});
