import { describe, expect, it } from "vitest";
import { isAtRoutePath, normalizeRoutePath, waitForRouteArrival } from "./route-arrival";

/** A location whose pathname can be moved, the way a client transition moves it. */
function movableLocation(pathname: string) {
  const state = { pathname };
  return {
    location: {
      get pathname() {
        return state.pathname;
      },
    },
    moveTo(next: string) {
      state.pathname = next;
    },
  };
}

describe("normalising a route path", () => {
  it("treats a trailing slash as the same screen", () => {
    expect(normalizeRoutePath("/shift-counts/")).toBe("/shift-counts");
    expect(normalizeRoutePath("/")).toBe("/");
  });

  it("drops a query string and a fragment, which are not the screen's identity", () => {
    expect(normalizeRoutePath("/settings?tab=ai")).toBe("/settings");
    expect(normalizeRoutePath("/settings#assistant")).toBe("/settings");
  });

  it("keeps everything else exact, so a near miss stays a miss", () => {
    // The tempting loosening is prefix matching, which would make /shift-types answer
    // for /shift-type-requirements. Normalising is spelling, not tolerance.
    expect(isAtRoutePath({ pathname: "/shift-types" }, "/shift-type-requirements")).toBe(false);
    expect(isAtRoutePath({ pathname: "/shift-type-requirements" }, "/shift-type")).toBe(false);
  });
});

describe("waiting for a client transition to arrive", () => {
  it("returns immediately when the caller is already on the screen", async () => {
    const started = Date.now();
    const arrival = await waitForRouteArrival({ pathname: "/dates" }, "/dates", {
      timeoutMs: 5_000,
      intervalMs: 500,
    });
    expect(arrival).toEqual({ status: "arrived" });
    // No dead interval spent proving something already true.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("arrives once the transition commits the URL later", async () => {
    // The whole point: the pathname is the OLD screen for as long as the transition is
    // in flight, and that is a healthy navigation rather than a failed one.
    const { location, moveTo } = movableLocation("/dates");
    setTimeout(() => moveTo("/shift-counts"), 40);
    const arrival = await waitForRouteArrival(location, "/shift-counts", {
      timeoutMs: 1_000,
      intervalMs: 10,
    });
    expect(arrival).toEqual({ status: "arrived" });
  });

  it("reports the screen it landed on instead when the transition is redirected", async () => {
    const { location, moveTo } = movableLocation("/dates");
    setTimeout(() => moveTo("/"), 20);
    const arrival = await waitForRouteArrival(location, "/shift-counts", {
      timeoutMs: 120,
      intervalMs: 10,
    });
    expect(arrival).toEqual({ status: "not_reached", pathname: "/" });
  });

  it("gives up within the budget rather than hanging on a transition that never commits", async () => {
    const started = Date.now();
    const arrival = await waitForRouteArrival({ pathname: "/dates" }, "/shift-counts", {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(arrival).toEqual({ status: "not_reached", pathname: "/dates" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
