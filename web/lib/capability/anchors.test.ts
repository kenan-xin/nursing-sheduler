import { describe, expect, it } from "vitest";
import { ALL_NAV_ITEMS } from "@/components/shell/nav-config";
import { CAPABILITY_ANCHOR_ATTRIBUTE, capabilityAnchorSelector } from "./anchor-contract";
import { ANCHOR_SOURCES, CONTROL_ANCHOR_DECLARATIONS, findControlAnchor } from "./anchors";

describe("control-anchor manifest", () => {
  it("collects every declaration the production registry carries", () => {
    // The failure this prevents: an owner module exports an anchor, the anchor is
    // rendered under its constant, but the module was never registered in
    // `ANCHOR_SOURCES` -- so the manifest never collected it and the live-DOM
    // resolver, the browser gate and the generated registry all silently agree it
    // does not exist.
    //
    // WHAT CHANGED (bounded-review round 1). Ticket 2 proved completeness by reading
    // the `components/` directory with `readdirSync` and dynamically importing every
    // `capability-anchors.ts` it found. That made this file a generic filesystem and
    // module-loader consumer, which the reader ledger had promised it would not be.
    // The owner set is now the production `ANCHOR_SOURCES` registry shipped from
    // `anchors.ts`: a typed, frozen object this test reads through an ordinary
    // import. The claim is therefore "every declaration the registry carries is
    // collected" -- the registry IS the source of truth for the owner set, and a new
    // owner is added by editing it in one place.
    //
    // The guarantee this loses on purpose is "a `capability-anchors.ts` nobody
    // registered is noticed". That was always a weak proxy for the question that
    // actually matters -- does each declared anchor render, exactly once, on the
    // route that owns it -- and that question is answered strictly more strongly by
    // `e2e/capability-anchors.spec.ts`, named below. Provenance -- a hand-typed
    // attribute that passes the browser gate while wired to no declaration -- stays
    // with the `capability-anchor-literal-attribute` ast-grep rule.
    const manifest = new Set(CONTROL_ANCHOR_DECLARATIONS.map((anchor) => anchor.anchorId));
    expect(ANCHOR_SOURCES.length, "the registry carries no owner").toBeGreaterThan(0);

    for (const source of ANCHOR_SOURCES) {
      expect(
        source.declarations.length,
        `components/${source.owner}/capability-anchors.ts exports no anchor declarations`,
      ).toBeGreaterThan(0);

      for (const anchor of source.declarations) {
        expect(
          manifest.has(anchor.anchorId),
          `components/${source.owner} declares "${anchor.anchorId}" but it is not in CONTROL_ANCHOR_DECLARATIONS`,
        ).toBe(true);
      }
    }
  });

  // WHAT CHANGED (custom-AST ticket 3). Ticket 2 RETAINED one check here -- "every declared
  // anchor is rendered by a component in its owner directory" -- and deferred it to this
  // ticket expecting an ast-grep rule. It does not become one, and the reason is worth
  // stating rather than working around: a syntax matcher answers "does this file contain a
  // forbidden shape". "Some file in this directory REFERENCES this constant" is a presence
  // claim over a directory, which no declarative rule can express, and building it would mean
  // exactly the semantic engine the migration plan refuses.
  //
  // The guarantee does not lapse; its owner changes to a gate that was already running and is
  // strictly stronger. `e2e/capability-anchors.spec.ts` iterates these same declarations and
  // asserts each renders EXACTLY ONCE, visibly, on its own route, in every mode that route is
  // reachable in, against a real production build -- plus that no other screen renders it and
  // that no two declarations collide in the shell. "The constant name appears somewhere in a
  // .tsx file in this folder" was a proxy for that, and a weak one: a reference inside dead
  // code, a commented-out JSX block, or a renamed attribute all satisfied it.
  //
  // The one thing a browser gate cannot see is PROVENANCE -- an element with a hand-typed
  // `data-capability-anchor` passes it while being wired to no declaration -- and that is the
  // `capability-anchor-literal-attribute` ast-grep rule.
  it("anchor ids are unique", () => {
    const ids = CONTROL_ANCHOR_DECLARATIONS.map((anchor) => anchor.anchorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every anchor names a real route", () => {
    const routeIds = new Set(ALL_NAV_ITEMS.map((item) => item.id));
    for (const anchor of CONTROL_ANCHOR_DECLARATIONS) {
      expect(routeIds.has(anchor.routeId), `anchor "${anchor.anchorId}"`).toBe(true);
    }
  });

  it("declarations and the manifest are frozen", () => {
    // The manifest is shipped state that a help answer is grounded in; a spec (or a
    // component) that could mutate it in place could retarget an answer at runtime.
    expect(Object.isFrozen(CONTROL_ANCHOR_DECLARATIONS)).toBe(true);
    for (const anchor of CONTROL_ANCHOR_DECLARATIONS) {
      expect(Object.isFrozen(anchor)).toBe(true);
    }
  });

  it("ids stay safe inside an attribute selector", () => {
    for (const anchor of CONTROL_ANCHOR_DECLARATIONS) {
      expect(anchor.anchorId).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
      expect(capabilityAnchorSelector(anchor.anchorId)).toBe(
        `[${CAPABILITY_ANCHOR_ATTRIBUTE}="${anchor.anchorId}"]`,
      );
    }
  });

  it("lookup misses return undefined rather than a nearby anchor", () => {
    expect(findControlAnchor("dates.roster-period-renamed")).toBeUndefined();
  });
});
