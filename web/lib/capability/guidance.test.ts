import { describe, expect, it } from "vitest";
import { suggestRuleCandidates } from "./guidance";
import { CAPABILITY_UNAVAILABLE, type CapabilityContext } from "./resolve";

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return { mode: "advanced", modeResolved: true, gates: [], ...overrides };
}

describe("rule guidance", () => {
  it("matches the succession rule for a night-to-day policy", () => {
    const result = suggestRuleCandidates(
      "nobody should work a day shift straight after a night shift",
      context(),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value[0]?.capabilityId).toBe("shift-successions");
    expect(result.value[0]?.matchedTerms.length).toBeGreaterThan(0);
  });

  it("matches staffing requirements for a minimum-cover policy", () => {
    const result = suggestRuleCandidates("at least two seniors on every night shift", context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.map((c) => c.capabilityId)).toContain("staffing-requirements");
  });

  it("returns an EMPTY list when the app cannot express the policy", () => {
    // The honest answer. Returning the closest unrelated rule is the approximation the
    // guided-setup contract explicitly forbids, so "no candidates" has to be a real,
    // reachable outcome rather than a case that never happens.
    const result = suggestRuleCandidates("automatically renegotiate everyone's salary", context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value).toEqual([]);
  });

  it("never suggests a rule hidden by the current mode", () => {
    const guided = suggestRuleCandidates(
      "no day shift straight after a night shift",
      context({ mode: "guided" }),
    );
    if (guided.status !== "ok") throw new Error("expected ok");
    expect(guided.value.map((c) => c.capabilityId)).not.toContain("shift-successions");
  });

  it("suggests only entries that opted into guidance", () => {
    // Save & Load matches the word "download" strongly, but it is not a rule and must
    // never be offered as one.
    const result = suggestRuleCandidates("download and anonymise the roster", context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.map((c) => c.capabilityId)).not.toContain("save-and-load");
  });

  it("is deterministic and bounded", () => {
    const goal = "limit nights and keep rest days between shifts for seniors";
    const first = suggestRuleCandidates(goal, context());
    const second = suggestRuleCandidates(goal, context());
    if (first.status !== "ok" || second.status !== "ok") throw new Error("expected ok");
    expect(first.value).toEqual(second.value);
    expect(first.value.length).toBeLessThanOrEqual(4);
  });

  it("ignores an empty or stop-word-only request", () => {
    const result = suggestRuleCandidates("what should we do", context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value).toEqual([]);
  });

  it("propagates a context refusal instead of guessing", () => {
    const result = suggestRuleCandidates("night after day", context({ modeResolved: false }));
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "mode_unresolved" });
  });

  it("carries the registry stamp on every answer", () => {
    const result = suggestRuleCandidates("night shift", context());
    expect(result.stamp.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
