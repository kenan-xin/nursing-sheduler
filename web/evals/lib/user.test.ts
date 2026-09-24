import { describe, expect, it } from "vitest";
import { parseUserLine, SIMULATED_USER_LABELS, simulatedUserSystem } from "./user";

describe("simulated user", () => {
  it("states persona, goal, facts and the stop rule", () => {
    const system = simulatedUserSystem({
      persona: "Busy ward manager",
      goal: "Set up August",
      facts: { staffCount: 12 },
      maxTurns: 8,
    });
    expect(system).toContain("Busy ward manager");
    expect(system).toContain("staffCount: 12");
    expect(system).toContain("###STOP###");
  });
  it("sees its own lines as You and the app's as Scheduling app, never the reverse", () => {
    expect(SIMULATED_USER_LABELS).toEqual({ user: "You", assistant: "Scheduling app" });
    const system = simulatedUserSystem({ persona: "p", goal: "g", facts: {}, maxTurns: 1 });
    expect(system).toMatch(/"You:" are yours/);
    expect(system).toMatch(/"Scheduling app:" are the app's/);
  });
  it("turns the stop marker or an empty line into null", () => {
    expect(parseUserLine("  Twelve nurses.  ")).toBe("Twelve nurses.");
    expect(parseUserLine("Thanks ###STOP###")).toBeNull();
    expect(parseUserLine("   ")).toBeNull();
  });
});
