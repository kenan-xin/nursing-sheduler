// @vitest-environment jsdom

// C2F2 — the arrival contract for host navigation (T06).
//
// The bug this suite exists to prevent: `router.push` STARTS a client transition and
// returns, so the pathname read on the next line is still the screen being left. The
// old code read it there and refused every route-only capability invoked from anywhere
// else. Every test below therefore drives a router mock whose URL commits LATE, which
// is the shape of a real App Router transition rather than a synchronous stub.
//
// The mirror obligation is the one the old code got right and must keep: a refusal
// stays a refusal. Waiting must not turn a redirect, a bounce or a stalled transition
// into an arrival, and no outcome may name a path the user is not on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CAPABILITY_ANCHOR_ATTRIBUTE } from "@/lib/capability/anchor-contract";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { emptyAssistantSettings } from "@/lib/ai/assistant/records";
import { useModeStore } from "@/lib/mode/mode";
import { useNavGuardStore } from "@/components/shell/nav-guard-store";
import { useCapabilityNavigation, type NavigateToCapability } from "./use-capability-navigation";

/** What the mocked router does with the next push. Reassigned per test. */
let onPush: (path: string) => void = () => {};
const push = vi.fn((path: string) => onPush(path));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
}));

const pendingTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * Commit the URL after a delay, the way a transition commits once the router has what
 * the destination needs. The DELAY is the point: a mock that moves the URL
 * synchronously would let the old, broken code pass.
 */
function commitsTo(path: string, delayMs = 20): (pushed: string) => void {
  return () => {
    pendingTimers.push(
      setTimeout(() => {
        window.history.replaceState({}, "", path);
      }, delayMs),
    );
  };
}

/** A push that is never honoured: a transition that stalls or is rejected outright. */
const neverCommits = () => {};

let navigate!: NavigateToCapability;

function Host() {
  navigate = useCapabilityNavigation();
  return null;
}

/** Put an anchored element in the document, as a mounted route would. */
function mountAnchor(anchorId: string): void {
  const element = document.createElement("button");
  element.setAttribute(CAPABILITY_ANCHOR_ATTRIBUTE, anchorId);
  document.body.append(element);
}

/** Open the single shipped feature gate by making the assistant Ready. */
function openAssistantGate(open: boolean): void {
  useAssistantStore.setState({
    hydrated: true,
    settings: {
      ...emptyAssistantSettings(new Date(0)),
      enabled: open,
      apiKey: open ? "sk-or-test" : null,
      modelId: open ? "openai/gpt-4o-mini" : null,
      modelSource: open ? "catalog" : null,
    },
  });
}

/** Bounded waits keep these fast; the defaults are seconds. */
const FAST = { routeTimeoutMs: 400, anchorTimeoutMs: 400 } as const;

beforeEach(() => {
  push.mockClear();
  onPush = commitsTo("/");
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
  useModeStore.setState({ mode: "advanced", adoption: "ready" });
  render(<Host />);
});

afterEach(() => {
  for (const timer of pendingTimers.splice(0)) clearTimeout(timer);
  cleanup();
  assistantActions.resetForTest();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
});

/** Every shipped capability that names a screen and no control. */
const ROUTE_ONLY = [
  { capabilityId: "staffing-requirements", path: "/shift-type-requirements" },
  { capabilityId: "shift-counts", path: "/shift-counts" },
  { capabilityId: "shift-affinities", path: "/shift-affinities" },
  { capabilityId: "shift-type-coverings", path: "/shift-type-coverings" },
  { capabilityId: "ai-assistant-setup", path: "/settings" },
] as const;

describe("arriving at a route-only screen from another screen", () => {
  for (const { capabilityId, path } of ROUTE_ONLY) {
    it(`reports arrival for ${capabilityId} once the transition commits`, async () => {
      window.history.replaceState({}, "", "/dates");
      onPush = commitsTo(path, 30);

      const outcome = await navigate(capabilityId, FAST);

      expect(push).toHaveBeenCalledWith(path);
      expect(outcome).toMatchObject({ status: "navigated", capabilityId });
      expect(window.location.pathname).toBe(path);
    });
  }

  it("reports arrival for a gated route-only capability while its gate is open", async () => {
    openAssistantGate(true);
    window.history.replaceState({}, "", "/dates");
    onPush = commitsTo("/settings", 30);

    const outcome = await navigate("ai-assistant-conversation", FAST);

    expect(outcome).toMatchObject({ status: "navigated", routeId: "settings" });
  });

  it("answers without waiting when the user is already on the screen", async () => {
    window.history.replaceState({}, "", "/shift-counts");

    const outcome = await navigate("shift-counts", FAST);

    expect(push).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "navigated", routeId: "shift-counts" });
  });
});

describe("an open unsaved draft gets the same confirm as a manual jump", () => {
  let unregister: () => void = () => {};
  beforeEach(() => {
    window.history.replaceState({}, "", "/dates");
    onPush = commitsTo("/shift-counts", 20);
    unregister = useNavGuardStore.getState().registerDraft({ id: "t", label: "Draft" });
  });
  afterEach(() => {
    useNavGuardStore.getState().cancel();
    unregister();
  });

  it("asks first and moves nothing until the user decides", async () => {
    const pending = navigate("shift-counts", FAST);
    await Promise.resolve();

    expect(useNavGuardStore.getState().open).toBe(true);
    expect(push).not.toHaveBeenCalled();

    useNavGuardStore.getState().confirm();
    expect(await pending).toMatchObject({ status: "navigated", routeId: "shift-counts" });
    expect(push).toHaveBeenCalledWith("/shift-counts");
  });

  it("stays put and says so when the user keeps their draft", async () => {
    const pending = navigate("shift-counts", FAST);
    await Promise.resolve();
    useNavGuardStore.getState().cancel();

    expect(await pending).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "navigation_cancelled",
    });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/dates");
  });

  it("does not push for a turn that lost authority while the confirm was open", async () => {
    let allowed = true;
    const pending = navigate("shift-counts", { ...FAST, authorize: () => allowed });
    await Promise.resolve();
    allowed = false;
    useNavGuardStore.getState().confirm();

    expect(await pending).toMatchObject({ reason: "authority_revoked" });
    expect(push).not.toHaveBeenCalled();
  });
});

describe("a navigation that does not arrive stays a refusal", () => {
  it("refuses when the transition is redirected to another screen", async () => {
    window.history.replaceState({}, "", "/dates");
    // Asked for /shift-counts, landed on Home — a guard bounce, and not the screen we
    // would be claiming to have opened.
    onPush = commitsTo("/", 20);

    const outcome = await navigate("shift-counts", FAST);

    expect(outcome).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "route_not_reached",
    });
    // The refusal must not leak the path it was aiming at, or the model can compose
    // the link the host just declined to stand behind.
    expect(JSON.stringify(outcome)).not.toMatch(/"\/[a-z-]/);
  });

  it("refuses, bounded, when the transition never commits", async () => {
    window.history.replaceState({}, "", "/dates");
    onPush = neverCommits;

    const started = Date.now();
    const outcome = await navigate("shift-counts", { routeTimeoutMs: 80 });

    expect(outcome).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "route_not_reached",
    });
    // Bounded: a help answer that never returns is not an acceptable outcome.
    expect(Date.now() - started).toBeLessThan(2_000);
    // And the claim is judged against where the user IS, never the old pathname.
    expect(window.location.pathname).toBe("/dates");
  });

  it("refuses a near-miss path rather than accepting a related screen", async () => {
    window.history.replaceState({}, "", "/dates");
    // /shift-types is a real screen and a plausible-looking prefix of the target. It
    // is still the wrong screen.
    onPush = commitsTo("/shift-types", 20);

    const outcome = await navigate("staffing-requirements", FAST);

    expect(outcome).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "route_not_reached",
    });
  });
});

describe("re-resolving against what is true after arrival", () => {
  it("refuses when the mode changed mid-transition and hid the destination", async () => {
    window.history.replaceState({}, "", "/dates");
    onPush = (path) => {
      commitsTo(path, 30)(path);
      // Guided hides every Advanced-only screen. Authorized in Advanced, arrived in
      // Guided: the refusal must describe the mode that is live NOW.
      pendingTimers.push(setTimeout(() => useModeStore.setState({ mode: "guided" }), 10));
    };

    const outcome = await navigate("shift-counts", FAST);

    expect(outcome).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "mode_hidden" });
  });

  it("refuses when a feature gate closed mid-transition", async () => {
    openAssistantGate(true);
    window.history.replaceState({}, "", "/dates");
    onPush = (path) => {
      commitsTo(path, 30)(path);
      pendingTimers.push(setTimeout(() => openAssistantGate(false), 10));
    };

    const outcome = await navigate("ai-assistant-conversation", FAST);

    expect(outcome).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "gate_closed" });
  });

  it("refuses when the registry the answer was produced under is no longer the live one", async () => {
    // A redeploy between the answer and the action. Nothing is navigated: the entry
    // being acted on may no longer mean what it meant.
    const outcome = await navigate("shift-counts", {
      ...FAST,
      stamp: { appBuildVersion: "v0.0.0-stale", manifestSha256: "0".repeat(64) },
    });

    expect(push).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "registry_version_changed",
    });
  });
});

describe("an anchored capability is held to arrival as well as to its control", () => {
  it("confirms the control after the route commits and the chunk mounts", async () => {
    window.history.replaceState({}, "", "/shift-counts");
    onPush = (path) => {
      commitsTo(path, 20)(path);
      // The chunk lands after the URL commits, which is the ordinary lazy-route case.
      pendingTimers.push(setTimeout(() => mountAnchor("dates.roster-period"), 40));
    };

    const outcome = await navigate("roster-period", FAST);

    expect(outcome).toMatchObject({
      status: "focused",
      routeId: "dates",
      controlLabel: "Roster period card",
    });
  });

  it("refuses a control it can see while the route it belongs to was never reached", async () => {
    // The strict case: the element is in the DOM, so the anchor check alone would say
    // yes. Arrival is a separate claim, and reporting a screen the user is not on
    // would be false even when the control is findable.
    window.history.replaceState({}, "", "/shift-counts");
    mountAnchor("dates.roster-period");
    onPush = neverCommits;

    const outcome = await navigate("roster-period", { routeTimeoutMs: 80 });

    expect(outcome).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "route_not_reached",
    });
  });

  it("still refuses an absent control after a successful arrival", async () => {
    window.history.replaceState({}, "", "/shift-counts");
    onPush = commitsTo("/dates", 20);

    const outcome = await navigate("roster-period", FAST);

    expect(outcome).toMatchObject({
      status: CAPABILITY_UNAVAILABLE,
      reason: "anchor_missing",
    });
  });
});
