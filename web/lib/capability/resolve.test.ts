import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_UNAVAILABLE,
  listCapabilities,
  resolveCapability,
  resolveNavigationTarget,
  type CapabilityContext,
} from "./resolve";
import {
  capabilityRegistryStamp,
  getCapabilityRegistry,
  resetCapabilityRegistryForTest,
  stampMatchesLiveRegistry,
} from "./registry";

afterEach(() => {
  vi.unstubAllEnvs();
  resetCapabilityRegistryForTest();
});

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return { mode: "guided", modeResolved: true, gates: [], ...overrides };
}

describe("the shipped registry", () => {
  it("is stamped with the client build version and the generated manifest hash", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "v9.9.9-test");
    resetCapabilityRegistryForTest();
    const registry = getCapabilityRegistry();
    expect(registry.appBuildVersion).toBe("v9.9.9-test");
    expect(registry.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is frozen and memoized, so no consumer can edit shipped content", () => {
    const registry = getCapabilityRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries)).toBe(true);
    expect(getCapabilityRegistry()).toBe(registry);
  });

  it("carries no path, URL or selector anywhere in its content", () => {
    // Structural, not stylistic: if the shipped registry contained a path, an answer
    // could quote one without the host ever resolving a route.
    const serialized = JSON.stringify(getCapabilityRegistry().entries);
    expect(serialized).not.toMatch(/"\/[a-z-]/);
    expect(serialized).not.toMatch(/https?:/);
    expect(serialized).not.toContain("data-");
  });
});

describe("resolving against mode", () => {
  it("hides an Advanced-only capability from Guided", () => {
    const result = resolveCapability("shift-successions", context({ mode: "guided" }));
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "mode_hidden" });
  });

  it("offers the same capability in Advanced", () => {
    const result = resolveCapability("shift-successions", context({ mode: "advanced" }));
    expect(result.status).toBe("ok");
  });

  it("refuses while the stored mode preference has not been adopted", () => {
    // Guided is the server/first-paint default, so resolving before adoption would
    // hide every Advanced capability from an Advanced user. Refusing is the honest
    // answer; guessing is not.
    const result = resolveCapability("roster-period", context({ modeResolved: false }));
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "mode_unresolved" });
  });

  it("lists only what the current mode contains", () => {
    const guided = listCapabilities(context({ mode: "guided" }));
    const advanced = listCapabilities(context({ mode: "advanced" }));
    if (guided.status !== "ok" || advanced.status !== "ok") throw new Error("expected ok");
    const guidedIds = guided.value.map((c) => c.id);
    expect(guidedIds).not.toContain("shift-successions");
    expect(advanced.value.map((c) => c.id)).toContain("shift-successions");
    expect(advanced.value.length).toBeGreaterThan(guided.value.length);
  });
});

describe("resolving against feature gates", () => {
  it("withholds a gated capability while its gate is closed", () => {
    const result = resolveCapability("ai-assistant-conversation", context({ gates: [] }));
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "gate_closed" });
  });

  it("offers it once the gate is open", () => {
    const result = resolveCapability(
      "ai-assistant-conversation",
      context({ gates: ["aiAssistant"] }),
    );
    expect(result.status).toBe("ok");
  });

  it("keeps the entry that explains how to OPEN the gate ungated", () => {
    // Gating it would hide the only answer a user without the assistant needs.
    const result = resolveCapability("ai-assistant-setup", context({ gates: [] }));
    expect(result.status).toBe("ok");
  });

  it("omits gated entries from the list rather than marking them unavailable", () => {
    const listed = listCapabilities(context({ gates: [] }));
    if (listed.status !== "ok") throw new Error("expected ok");
    expect(listed.value.map((c) => c.id)).not.toContain("ai-assistant-conversation");
  });
});

describe("resolving an unknown or screenless capability", () => {
  it("refuses a capability the registry does not contain", () => {
    const result = resolveCapability("roster-repair", context());
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "unknown_capability" });
  });

  it("refuses to navigate a concept-only entry instead of picking a likely screen", () => {
    const result = resolveNavigationTarget("hard-and-soft-rules", context());
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "no_screen" });
  });

  it("never returns a route, anchor or path on any refusal", () => {
    for (const [id, ctx] of [
      ["roster-repair", context()],
      ["shift-successions", context({ mode: "guided" })],
      ["ai-assistant-conversation", context({ gates: [] })],
      ["hard-and-soft-rules", context()],
      ["roster-period", context({ modeResolved: false })],
    ] as const) {
      const result = resolveNavigationTarget(id, ctx);
      expect(result.status).toBe(CAPABILITY_UNAVAILABLE);
      expect(Object.keys(result).sort()).toEqual(["reason", "stamp", "status"]);
    }
  });
});

describe("navigation targets", () => {
  it("derives the path from the navigation registry at the moment of use", () => {
    const result = resolveNavigationTarget("roster-period", context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value).toMatchObject({
      routeId: "dates",
      path: "/dates",
      screenName: "Dates",
      anchorId: "dates.roster-period",
      controlLabel: "Roster period card",
    });
  });

  it("returns a null anchor for a screen with no anchored control", () => {
    const result = resolveNavigationTarget("shift-counts", context({ mode: "advanced" }));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.anchorId).toBeNull();
    expect(result.value.controlLabel).toBeNull();
  });
});

describe("build-version binding", () => {
  it("refuses when the caller resolved under a different build", () => {
    const stale = { appBuildVersion: "v0.0.1-old", manifestSha256: "0".repeat(64) };
    const result = resolveCapability("roster-period", context({ stamp: stale }));
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "registry_version_changed",
    });
  });

  it("refuses when only the manifest hash differs", () => {
    // The redeploy that keeps the version string (a `-dirty` rebuild, say) but changes
    // the content is exactly the case a version-only check would miss.
    const live = capabilityRegistryStamp();
    const result = resolveCapability(
      "roster-period",
      context({ stamp: { ...live, manifestSha256: "f".repeat(64) } }),
    );
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "registry_version_changed",
    });
  });

  it("accepts the live stamp", () => {
    const live = capabilityRegistryStamp();
    expect(stampMatchesLiveRegistry(live)).toBe(true);
    expect(resolveCapability("roster-period", context({ stamp: live })).status).toBe("ok");
  });

  it("stamps every result, available or not, so a display can retain it", () => {
    expect(resolveCapability("roster-period", context()).stamp).toEqual(capabilityRegistryStamp());
    expect(resolveCapability("nope", context()).stamp).toEqual(capabilityRegistryStamp());
    expect(listCapabilities(context()).stamp).toEqual(capabilityRegistryStamp());
  });
});
