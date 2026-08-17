// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITY_ANCHOR_ATTRIBUTE } from "./anchor-contract";
import { findLiveAnchor, revealAnchor, waitForLiveAnchor } from "./live-anchor";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe("finding an anchor in the live DOM", () => {
  it("resolves the single matching element", () => {
    mount(`<button ${CAPABILITY_ANCHOR_ATTRIBUTE}="people.add-person">Add</button>`);
    const lookup = findLiveAnchor(document, "people.add-person");
    expect(lookup.status).toBe("ok");
  });

  it("reports a MISSING anchor rather than the nearest element", () => {
    // The stale/renamed case, and the not-yet-mounted case. Either way there is no
    // substitute to offer.
    mount(`<button ${CAPABILITY_ANCHOR_ATTRIBUTE}="people.add-person">Add</button>`);
    expect(findLiveAnchor(document, "people.add-nurse")).toEqual({ status: "missing" });
  });

  it("reports AMBIGUOUS separately when two elements claim one anchor", () => {
    // A code defect that would make every navigation to it a coin flip, so it must not
    // be collapsed into "found the first one".
    mount(`
      <button ${CAPABILITY_ANCHOR_ATTRIBUTE}="people.add-person">Add</button>
      <button ${CAPABILITY_ANCHOR_ATTRIBUTE}="people.add-person">Add again</button>
    `);
    expect(findLiveAnchor(document, "people.add-person")).toEqual({
      status: "ambiguous",
      count: 2,
    });
  });

  it("scopes to the given root", () => {
    mount(`<div id="a"><i ${CAPABILITY_ANCHOR_ATTRIBUTE}="x.y"></i></div><div id="b"></div>`);
    const b = document.querySelector("#b")!;
    expect(findLiveAnchor(b, "x.y")).toEqual({ status: "missing" });
  });
});

describe("waiting for a lazily mounted anchor", () => {
  it("resolves once a late-rendering route inserts it", async () => {
    // A client navigation can resolve before the route's chunk mounts, so a single
    // synchronous look would report a lazily-loaded screen's control as missing.
    mount('<div id="host"></div>');
    setTimeout(() => {
      document.querySelector("#host")!.innerHTML =
        `<button ${CAPABILITY_ANCHOR_ATTRIBUTE}="optimize.run-options"></button>`;
    }, 40);
    const lookup = await waitForLiveAnchor(document, "optimize.run-options", {
      timeoutMs: 1_000,
      intervalMs: 10,
    });
    expect(lookup.status).toBe("ok");
  });

  it("gives up within the budget rather than hanging", async () => {
    const started = Date.now();
    const lookup = await waitForLiveAnchor(document, "never.arrives", {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(lookup).toEqual({ status: "missing" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("short-circuits on ambiguity instead of waiting it out", async () => {
    mount(`
      <i ${CAPABILITY_ANCHOR_ATTRIBUTE}="dup.anchor"></i>
      <i ${CAPABILITY_ANCHOR_ATTRIBUTE}="dup.anchor"></i>
    `);
    const started = Date.now();
    const lookup = await waitForLiveAnchor(document, "dup.anchor", {
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    expect(lookup.status).toBe("ambiguous");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("revealing an anchor", () => {
  it("focuses a natively focusable control", () => {
    mount(`<button ${CAPABILITY_ANCHOR_ATTRIBUTE}="people.add-person">Add</button>`);
    const element = document.querySelector<HTMLElement>("button")!;
    expect(revealAnchor(element)).toBe("focused");
    expect(document.activeElement).toBe(element);
  });

  it("focuses the first focusable child of a container anchor", () => {
    mount(
      `<section ${CAPABILITY_ANCHOR_ATTRIBUTE}="rules.rule-library"><button>On</button></section>`,
    );
    const element = document.querySelector<HTMLElement>("section")!;
    expect(revealAnchor(element)).toBe("focused");
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("reveals without focusing when nothing inside can take focus", () => {
    // Deliberately does NOT add a tabindex: mutating a screen's tab order as a side
    // effect of asking a question would change the app to answer a question about it.
    mount(`<section ${CAPABILITY_ANCHOR_ATTRIBUTE}="rules.rule-library"><p>Empty</p></section>`);
    const element = document.querySelector<HTMLElement>("section")!;
    expect(revealAnchor(element)).toBe("revealed");
    expect(element.hasAttribute("tabindex")).toBe(false);
  });

  it("does not claim focus on a disabled control", () => {
    mount(`<button disabled ${CAPABILITY_ANCHOR_ATTRIBUTE}="x.y">Add</button>`);
    const element = document.querySelector<HTMLElement>("button")!;
    expect(revealAnchor(element)).toBe("revealed");
  });
});
