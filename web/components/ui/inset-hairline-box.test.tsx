// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { surfaceVariants } from "@/components/ui/surface";
import {
  InsetHairlineReadout,
  InsetHairlineTile,
  type InsetHairlineReadoutProps,
  type InsetHairlineTileProps,
} from "./inset-hairline-box";

// The BEHAVIOURAL half of inset-hairline ownership (custom-AST ticket 5).
//
// This suite replaces the live-source half of the deleted 2,002-line
// `components/shift-types/inset-hairline-ownership.test.ts` analyzer. What the
// analyzer proved by resolving each governed node's className expression through
// `cn`, const aliases and control flow, the production API now makes true by
// construction: a caller has no class or style channel to reach the box with.
// So the assertions here are about what the OWNER emits, and about the fact that
// a hostile caller cannot change it.
//
// NOTHING here restates a token. Every class claim is asked of the recipe, so if
// the ladder's definition of `well/control/hairline` changes this suite follows
// it instead of pinning yesterday's class list. The resolved paint — the actual
// `--panel` tone, the 12px radius, the `--line2` border colour and the `--sh-well`
// cast — is measured in a real browser by `e2e/shift-types.spec.ts`, because
// jsdom applies no stylesheet.

afterEach(cleanup);

const TUPLE = { role: "well", geometry: "control", emphasis: "hairline" } as const;

/** Every class the governed tuple emits, asked of the recipe. */
function recipeTokens(): string[] {
  return surfaceVariants(TUPLE).split(/\s+/).filter(Boolean);
}

function tokensOf(element: Element): string[] {
  return [...new Set((element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))].sort();
}

/**
 * The element's class list is CLOSED over the recipe's own output plus the
 * declared layout utilities — nothing else rides along.
 */
function expectClosedOverRecipe(element: Element, layout: readonly string[]): void {
  expect(tokensOf(element), "class list closed over the recipe plus declared layout").toEqual(
    [...new Set([...layout, ...recipeTokens()])].sort(),
  );
}

describe("the governed tuple is non-vacuous", () => {
  // THE NON-VACUITY CONTROL. Every assertion below compares a rendered class
  // list against `surfaceVariants(TUPLE)`. If the recipe ever emitted nothing —
  // a renamed axis silently dropped by CVA, a variant deleted — the closed-list
  // checks would still pass while the boxes rendered unpainted. Pinning that the
  // tuple actually carries a tone, an edge, a radius and an inset cast is what
  // stops this whole suite from succeeding for the wrong reason.
  it("emits a tone, a hairline edge, the control radius and the inset cast", () => {
    const tokens = recipeTokens();
    expect(tokens.length, "the governed tuple must emit classes at all").toBeGreaterThan(0);
    for (const token of ["bg-panel", "border-line2", "rounded-control", "shadow-well"]) {
      expect(tokens, `the governed tuple must carry ${token}`).toContain(token);
    }
  });

  it("takes the INSET cast only — never an outer elevation", () => {
    // DESIGN.md §4 rule 1: direction of light is fixed. A `well` that gained an
    // outer cast would read as lifted rather than recessed, and every consumer
    // of this tuple would invert with it.
    expect(recipeTokens().filter((t) => t.startsWith("shadow-"))).toEqual(["shadow-well"]);
  });
});

describe("InsetHairlineTile", () => {
  const LAYOUT = ["flex", "flex-none", "items-center", "justify-center"];

  function renderTile(props: Partial<InsetHairlineTileProps> = {}) {
    render(
      <InsetHairlineTile data-testid="tile" {...props}>
        <span>icon</span>
      </InsetHairlineTile>,
    );
    return screen.getByTestId("tile");
  }

  it("derives its whole surface from the governed tuple, and nothing else", () => {
    expectClosedOverRecipe(renderTile(), LAYOUT);
  });

  it("goes through the Surface adapter, not a hand-rolled div", () => {
    // The adapter's own markers. A raw div hand-authored with the same canonical
    // tokens paints identically, so the rendered CLASSES cannot tell the two
    // apart — these attributes and the `inset-hairline-box-authority` ast-grep
    // rule are what distinguish them.
    const tile = renderTile();
    expect(tile).toHaveAttribute("data-level", "well");
    expect(tile).toHaveAttribute("data-geometry", "control");
    expect(tile).toHaveAttribute("data-emphasis", "hairline");
    expect(tile).toHaveAttribute("data-slot", "shift-tile");
  });

  it("declares exactly the prototype's 42px box inline, and nothing else", () => {
    // React's inline style outranks every class, so an extra property here would
    // silently take a channel the recipe owns. The style attribute is the whole
    // declaration, so an addition is visible as an inequality rather than needing
    // a per-property denylist.
    const tile = renderTile();
    expect(tile.getAttribute("style")).toBe("width: 42px; height: 42px;");
  });

  it("refuses a caller's class and style even when the type boundary is cast away", () => {
    // The type half is `inset-hairline-box.negative.test-d.ts`. This is the
    // RUNTIME half: the owner applies `className` and `style` AFTER the caller's
    // spread, so an `as unknown as` cast, an untyped re-export or a JS-boundary
    // call still cannot repaint the box or override its dimension.
    const hostile = {
      className: "bg-brandtint shadow-3 rounded-card",
      style: { backgroundColor: "red", height: 9 },
    } as unknown as InsetHairlineTileProps;

    const tile = renderTile(hostile);
    expectClosedOverRecipe(tile, LAYOUT);
    expect(tile.getAttribute("style")).toBe("width: 42px; height: 42px;");
  });

  it("still forwards the DOM attributes a caller legitimately owns", () => {
    // The refusal above must not be a blanket one: identity, labelling and
    // handlers still belong to the call site, or the component would not be
    // usable and the refusal would be untested against a live pass-through.
    const tile = renderTile({ "aria-label": "Day", title: "a shift", id: "tile-1" });
    expect(tile).toHaveAttribute("aria-label", "Day");
    expect(tile).toHaveAttribute("title", "a shift");
    expect(tile).toHaveAttribute("id", "tile-1");
    expect(tile).toHaveTextContent("icon");
  });
});

describe("InsetHairlineReadout", () => {
  const LAYOUT = [
    "flex",
    "items-center",
    "gap-1.5",
    "overflow-hidden",
    "px-2.5",
    "pointer-coarse:min-h-touch",
  ];

  function renderReadout(props: Partial<InsetHairlineReadoutProps> = {}) {
    render(
      <InsetHairlineReadout data-testid="readout" {...props}>
        8h 30m
      </InsetHairlineReadout>,
    );
    return screen.getByTestId("readout");
  }

  it("derives its whole surface from the governed tuple, and nothing else", () => {
    expectClosedOverRecipe(renderReadout(), LAYOUT);
  });

  it("goes through the Surface adapter, not a hand-rolled div", () => {
    const readout = renderReadout();
    expect(readout).toHaveAttribute("data-level", "well");
    expect(readout).toHaveAttribute("data-geometry", "control");
    expect(readout).toHaveAttribute("data-emphasis", "hairline");
    expect(readout).toHaveAttribute("data-slot", "inset-hairline-readout");
  });

  it("declares exactly the absolute control height inline, and nothing else", () => {
    // `--ctl` is the ratified absolute token (D10), not `h-10` on the 0.9 density
    // baseline — the readout sits in a row with two 36px selects and steps the
    // row if it drifts. The measured height is asserted in a real browser by
    // `e2e/shift-types.spec.ts`; jsdom resolves no custom property.
    expect(renderReadout().getAttribute("style")).toBe("height: var(--ctl);");
  });

  it("refuses a caller's class and style even when the type boundary is cast away", () => {
    const hostile = {
      className: "bg-surface shadow-1",
      style: { backgroundColor: "var(--color-panel)" },
    } as unknown as InsetHairlineReadoutProps;

    const readout = renderReadout(hostile);
    expectClosedOverRecipe(readout, LAYOUT);
    expect(readout.getAttribute("style")).toBe("height: var(--ctl);");
  });

  it("still forwards the DOM attributes a caller legitimately owns", () => {
    const readout = renderReadout({ "aria-label": "Working duration (auto)", title: "8h working" });
    expect(readout).toHaveAttribute("aria-label", "Working duration (auto)");
    expect(readout).toHaveAttribute("title", "8h working");
    expect(readout).toHaveTextContent("8h 30m");
  });
});
