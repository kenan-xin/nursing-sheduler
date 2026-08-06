// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CAPABILITY_ANCHOR_ATTRIBUTE } from "@/lib/capability/anchor-contract";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useModeStore } from "@/lib/mode/mode";
import { HELP_TOOL_NAMES } from "@/lib/capability/tools";
import { useHelpTools } from "./use-help-tools";

// The tools are exercised through their REGISTERED definitions rather than by
// importing their handlers: what matters is the object the model is offered -- its
// name, its description, its parameters and what its handler answers. Mocking
// `useFrontendTool` to capture that object keeps CopilotKit's runtime, transport and
// stylesheet out of a suite that is about the help contract.

interface CapturedTool {
  name: string;
  description: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}

const captured: CapturedTool[] = [];

vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

const TURN = 7;

function Host({ turnEpoch = TURN }: { turnEpoch?: number }) {
  useHelpTools("scheduler:thread-1", turnEpoch);
  return null;
}

function tool(name: string): CapturedTool {
  const found = captured.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found;
}

/** Put an anchored element in the document, as a mounted route would. */
function mountAnchor(anchorId: string): void {
  const button = document.createElement("button");
  button.setAttribute(CAPABILITY_ANCHOR_ATTRIBUTE, anchorId);
  document.body.append(button);
}

beforeEach(() => {
  captured.length = 0;
  push.mockClear();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
  useAssistantStore.setState({ turnEpoch: TURN });
  useModeStore.setState({ mode: "guided", adoption: "ready" });
  render(<Host />);
});

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
});

describe("the registered help tool surface", () => {
  it("registers exactly the four read-only help tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual([...HELP_TOOL_NAMES].sort());
  });

  it("describes no tool that could change the schedule", () => {
    for (const { description } of captured) {
      expect(description.toLowerCase()).not.toMatch(/\b(apply|save|create|delete|change it)\b/);
    }
  });
});

describe("list_app_capabilities", () => {
  it("returns ids and summaries with the registry stamp, and no link of any kind", async () => {
    const result = (await tool("list_app_capabilities").handler({}, {})) as {
      capabilities: { id: string }[];
      registry: { manifestSha256: string };
    };
    expect(result.capabilities.map((c) => c.id)).toContain("roster-period");
    expect(result.registry).toEqual(capabilityRegistryStamp());

    // The load-bearing assertion of this whole ticket: what reaches the model has no
    // path, href or URL, so it cannot compose a link the host has not verified.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/https?:/);
    expect(serialized).not.toMatch(/"\/[a-z-]/);
    expect(serialized).not.toContain("href");
    expect(serialized).not.toContain(CAPABILITY_ANCHOR_ATTRIBUTE);
  });

  it("hides Advanced-only capabilities from a Guided user", async () => {
    const result = (await tool("list_app_capabilities").handler({}, {})) as {
      capabilities: { id: string }[];
    };
    expect(result.capabilities.map((c) => c.id)).not.toContain("shift-successions");
  });

  it("refuses while the stored mode preference has not been adopted", async () => {
    useModeStore.setState({ adoption: "unhydrated" });
    const result = await tool("list_app_capabilities").handler({}, {});
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "mode_unresolved",
    });
  });
});

describe("explain_app_capability", () => {
  it("explains a capability and states that changes are user-applied", async () => {
    const result = await tool("explain_app_capability").handler(
      { capabilityId: "leave-and-requests" },
      {},
    );
    expect(result).toMatchObject({
      id: "leave-and-requests",
      hasScreen: true,
      hasExactControl: true,
      changesAreUserApplied: true,
      registry: capabilityRegistryStamp(),
    });
  });

  it("fails closed on an invented capability id", async () => {
    const result = await tool("explain_app_capability").handler(
      { capabilityId: "repair-the-roster" },
      {},
    );
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "unknown_capability",
    });
    expect(Object.keys(result as object).sort()).toEqual(["reason", "registry", "status"]);
  });

  it("fails closed on a gated capability while its gate is closed", async () => {
    const result = await tool("explain_app_capability").handler(
      { capabilityId: "ai-assistant-conversation" },
      {},
    );
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "gate_closed" });
  });
});

describe("suggest_scheduling_rule", () => {
  it("suggests only supported rules and states its limits", async () => {
    useModeStore.setState({ mode: "advanced" });
    const result = (await tool("suggest_scheduling_rule").handler(
      { policy: "no day shift straight after a night shift" },
      {},
    )) as { candidates: { capabilityId: string }[]; note: string };
    expect(result.candidates[0]?.capabilityId).toBe("shift-successions");
    expect(result.note).toMatch(/cannot confirm employment, legal or clinical-safety policy/);
  });

  it("returns nothing rather than the nearest rule for an unsupported policy", async () => {
    const result = (await tool("suggest_scheduling_rule").handler(
      { policy: "automatically renegotiate everyone's salary" },
      {},
    )) as { candidates: unknown[] };
    expect(result.candidates).toEqual([]);
  });
});

describe("open_app_screen", () => {
  it("navigates and confirms the exact live anchor before reporting focus", async () => {
    mountAnchor("dates.roster-period");
    const result = await tool("open_app_screen").handler({ capabilityId: "roster-period" }, {});
    expect(push).toHaveBeenCalledWith("/dates");
    expect(result).toMatchObject({
      status: "focused",
      capabilityId: "roster-period",
      routeId: "dates",
      screenName: "Dates",
      controlLabel: "Roster period card",
    });
  });

  it("reports neither a URL nor a focus result when the anchor is not in the DOM", async () => {
    // The stale-registry / did-not-mount case. No URL, no focus, no nearby screen.
    const result = await tool("open_app_screen").handler({ capabilityId: "roster-period" }, {});
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "anchor_missing",
    });
    expect(JSON.stringify(result)).not.toMatch(/"\/[a-z-]/);
  });

  it("refuses when two elements claim the same anchor", async () => {
    mountAnchor("dates.roster-period");
    mountAnchor("dates.roster-period");
    const result = await tool("open_app_screen").handler({ capabilityId: "roster-period" }, {});
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "anchor_ambiguous",
    });
  });

  it("refuses a screen hidden by the current mode, without navigating", async () => {
    const result = await tool("open_app_screen").handler({ capabilityId: "shift-successions" }, {});
    expect(push).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "mode_hidden" });
  });

  it("refuses a concept-only capability instead of opening a plausible screen", async () => {
    const result = await tool("open_app_screen").handler(
      { capabilityId: "hard-and-soft-rules" },
      {},
    );
    expect(push).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "no_screen" });
  });

  it("reports arrival for a screen with no anchored control", async () => {
    useModeStore.setState({ mode: "advanced" });
    window.history.replaceState({}, "", "/shift-counts");
    const result = await tool("open_app_screen").handler({ capabilityId: "shift-counts" }, {});
    expect(result).toMatchObject({
      status: "navigated",
      routeId: "shift-counts",
      screenName: "Shift Counts",
    });
  });

  it("does not report a route it never reached", async () => {
    // The mocked router does not actually change the location, which is exactly the
    // shape of a push that fails: arrival is a claim, and an unreached route must not
    // be reported as reached.
    useModeStore.setState({ mode: "advanced" });
    const result = await tool("open_app_screen").handler({ capabilityId: "shift-counts" }, {});
    expect(result).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "route_not_reached",
    });
  });
});

describe("turn authorization", () => {
  it("answers nothing once the live epoch has moved past the authorized one", async () => {
    // The interruption case. The comparison is live-epoch against the epoch handed
    // down by the session; this module never re-reads the store to re-arm a baseline.
    useAssistantStore.setState({ turnEpoch: TURN + 1 });
    for (const { handler } of captured) {
      await expect(
        handler({ capabilityId: "roster-period", policy: "night" }, {}),
      ).resolves.toMatch(/^superseded:/);
    }
  });

  it("stays closed for a cleared authorization rather than re-arming", async () => {
    // T05 passes a cleared value on interruption. It must never match a live epoch.
    cleanup();
    captured.length = 0;
    render(<Host turnEpoch={-1} />);
    await expect(tool("list_app_capabilities").handler({}, {})).resolves.toMatch(/^superseded:/);
  });

  it("answers nothing for an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool("list_app_capabilities").handler({}, { signal: controller.signal }),
    ).resolves.toMatch(/^superseded:/);
  });

  it("does not report a navigation to a turn that was interrupted mid-flight", async () => {
    mountAnchor("dates.roster-period");
    const controller = new AbortController();
    const pending = tool("open_app_screen").handler(
      { capabilityId: "roster-period" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toMatch(/^superseded:/);
  });
});
