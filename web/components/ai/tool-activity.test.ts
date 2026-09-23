import { describe, expect, it } from "vitest";
import { TOOL_ACTIVITY } from "./assistant-conversation";
import {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  PARAMETERLESS_MODEL_VISIBLE_TOOLS,
} from "./model-visible-tools";

describe("tool activity labels", () => {
  it("names what every shipped tool is doing, in the user's words", () => {
    const shipped = [
      ...Object.keys(MODEL_VISIBLE_TOOL_SCHEMAS),
      ...PARAMETERLESS_MODEL_VISIBLE_TOOLS,
    ];
    for (const name of shipped) {
      expect(TOOL_ACTIVITY[name], `${name} has no activity label`).toMatch(/…$/);
    }
  });
});
