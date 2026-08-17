// NEGATIVE TYPE FIXTURE for the public Surface recipe contract.
//
// The discriminated unions `SurfaceVariantProps` (recipe options) and
// `SurfaceVisualProps` (`<Surface>` level/geometry/emphasis) make the illegal
// (role, emphasis) tuples unrepresentable at the type boundary. This file pins
// that property: an illegal tuple is a COMPILE error before any runtime
// validation gets a chance to be forgotten, and a bypass through the retired
// `edge`/`drop` axes or the second CVA `class` channel fails just the same.
//
// WHAT THIS FILE ACTUALLY PROVES, stated narrowly:
//
//   * `SurfaceEmphasis` is EXACTLY `"hairline" | "drop-candidate"` — checked both
//     ways, so a widening to `string` and a silent removal both fail here;
//   * every illegal (role, emphasis) tuple on `surfaceVariants(...)` is rejected,
//     across ALL nine non-`well` public roles, not a sample of them;
//   * an emphasis VALUE outside the public union is rejected;
//   * a `class` channel on `surfaceVariants(...)` is rejected (CVA's second
//     channel, made structurally unavailable by `class?: never`);
//   * the retired `edge` / `drop` axes are gone, not merely unused;
//   * every illegal `<Surface>` level/emphasis tuple is rejected;
//   * the sanctioned tuples still compile, so the union is neither widened to
//     `string` nor narrowed to nothing.
//
// The dev-mode runtime assertion in `surfaceVariants` is the second layer: it
// catches the `as any` / untyped-re-export / `__proto__`-poisoned cases the
// type boundary cannot see. Its sole runtime owner is `primitives-v2.test.tsx`
// (an earlier draft of this comment named a `surface-runtime-contract.test.ts`
// that does not exist; bounded review round 1 caught it). This file owns the
// type half alone.
//
// Checked by `tsc --noEmit`; `.test-d.ts` is not collected by vitest, so
// nothing executes. The `@ts-expect-error` directives are self-checking: if the
// union ever widens (a regression to `string`, or `class?: string` coming
// back), the error they expect disappears and the directive itself becomes the
// error.

import * as React from "react";
import type { SurfaceEmphasis, SurfaceVariantProps } from "./surface";
import { Surface, surfaceVariants } from "./surface";

// ---------------------------------------------------------------------------
// The public emphasis DOMAIN, pinned exactly.
//
// The deleted analyzer read the live `cva` config and the exported union out of
// the TypeScript program and asserted the two were EQUAL, so a widening, an
// addition, a removal and a rename all failed loudly. Bounded review round 1
// found this file never imported `SurfaceEmphasis` at all, so a widening to
// `string` passed every fixture below (an illegal tuple stays illegal because
// of the ROLE, whatever the emphasis type is). These two lines restore the
// domain half.
//
// `Exact` compares both directions. `[A] extends [B]` alone would accept a
// widening in one direction; the tuple wrappers stop the conditional from
// distributing over the union, so the check is on the union as a whole.
// ---------------------------------------------------------------------------

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// If `SurfaceEmphasis` ever widens to `string`, gains a member, or loses one,
// `Exact<...>` becomes `false` and this assignment stops compiling.
const emphasisDomainIsExact: Exact<SurfaceEmphasis, "hairline" | "drop-candidate"> = true;
void emphasisDomainIsExact;

// @ts-expect-error — the union admits no arbitrary string. This is the negative
// control for the widening: if `SurfaceEmphasis` became `string`, the error
// disappears and the directive itself becomes the error.
const notAnEmphasis: SurfaceEmphasis = "bogus";
void notAnEmphasis;

// ---------------------------------------------------------------------------
// Positive controls. The sanctioned tuples compile, so the union is neither
// widened to `string` nor narrowed to nothing.
// ---------------------------------------------------------------------------

const legalRecipeA: SurfaceVariantProps = {
  role: "well",
  geometry: "control",
  emphasis: "hairline",
};
void legalRecipeA;

const legalRecipeB: SurfaceVariantProps = {
  role: "well",
  geometry: "control",
  emphasis: "drop-candidate",
};
void legalRecipeB;

// An ordinary container compiles without an emphasis.
const legalRecipeC: SurfaceVariantProps = { role: "surface", geometry: "card" };
void legalRecipeC;

// ---------------------------------------------------------------------------
// Negative: every illegal (role, emphasis) tuple on surfaceVariants(...).
// ---------------------------------------------------------------------------

// @ts-expect-error — the page plane is never a bordered box.
surfaceVariants({ role: "page", geometry: "square", emphasis: "hairline" });
// @ts-expect-error — a raised surface is never a recessed row.
surfaceVariants({ role: "raised", geometry: "card", emphasis: "drop-candidate" });
// @ts-expect-error — an L1 card is not a recessed row either.
surfaceVariants({ role: "surface", geometry: "card", emphasis: "hairline" });
// @ts-expect-error — a sticky edge is not a recessed row.
surfaceVariants({ role: "sticky", geometry: "square", emphasis: "drop-candidate" });
// @ts-expect-error — a band has no edge.
surfaceVariants({ role: "band", geometry: "square", emphasis: "hairline" });
// @ts-expect-error — `emphasis` without a role falls back to `surface`.
surfaceVariants({ geometry: "control", emphasis: "hairline" });

// The four public non-`well` roles the first draft of this file omitted while
// claiming to cover "every illegal tuple" (bounded review round 1). With these,
// all nine non-`well` members of `SurfaceRole` are covered, so the claim is now
// true of the whole union rather than of a sample.

// @ts-expect-error — a selected L1 card is not a recessed row.
surfaceVariants({ role: "selected", geometry: "card", emphasis: "hairline" });
// @ts-expect-error — the drop-target ROLE already restates its own edge.
surfaceVariants({ role: "drop-target", geometry: "card", emphasis: "drop-candidate" });
// @ts-expect-error — a drawer is the sidebar plane, not a recessed row.
surfaceVariants({ role: "drawer", geometry: "square", emphasis: "hairline" });
// @ts-expect-error — a zebra band has no edge.
surfaceVariants({ role: "zebra", geometry: "square", emphasis: "drop-candidate" });

// The VALUE half of the tuple, on the one role that legally carries an emphasis.
// Without this the union could widen to `string` and every row above would still
// pass, because they are all rejected on the ROLE.

// @ts-expect-error — "bogus" is not a public SurfaceEmphasis; CVA would drop it
// silently and the row would render with no edge.
surfaceVariants({ role: "well", geometry: "control", emphasis: "bogus" });
// @ts-expect-error — ditto on `<Surface>`, whose emphasis is the same union.
React.createElement(Surface, { level: "well", geometry: "control", emphasis: "bogus" });

// ---------------------------------------------------------------------------
// Negative: the retired `edge` / `drop` axes are gone, not merely unused.
// ---------------------------------------------------------------------------

// @ts-expect-error — the retired loose `edge` axis is gone.
surfaceVariants({ role: "well", geometry: "control", edge: "hairline" });
// @ts-expect-error — the retired loose `drop` axis is gone.
surfaceVariants({ role: "well", geometry: "control", drop: "candidate" });

// ---------------------------------------------------------------------------
// Negative: the second CVA `class` channel is structurally unavailable.
// ---------------------------------------------------------------------------

// @ts-expect-error — `class` is `never` on the recipe options type; CVA's
// second channel cannot be spelled at the public boundary.
surfaceVariants({ role: "well", geometry: "control", class: "flex" });
// @ts-expect-error — ditto on an ordinary-container tuple.
surfaceVariants({ role: "surface", geometry: "card", class: "flex" });

// ---------------------------------------------------------------------------
// Negative: every illegal `<Surface>` level/emphasis tuple.
//
// `React.createElement(Surface, {...})` is used (rather than JSX) because this
// is a `.ts` file. Each call is on ONE LINE so the `@ts-expect-error` directive
// above it spans the whole expression; multi-line object literals would surface
// the error on a later column than the directive covers.
// ---------------------------------------------------------------------------

// @ts-expect-error — only `level="well"` carries an emphasis.
React.createElement(Surface, { level: "page", geometry: "square", emphasis: "hairline" });
// @ts-expect-error — ditto for a raised container.
React.createElement(Surface, { level: "raised", geometry: "card", emphasis: "drop-candidate" });
// @ts-expect-error — an L1 surface is not a recessed row either.
React.createElement(Surface, { level: "surface", geometry: "card", emphasis: "hairline" });

// ---------------------------------------------------------------------------
// Positive: the sanctioned `<Surface>` tuples still compile.
// ---------------------------------------------------------------------------

const legalSurfaceA = React.createElement(Surface, {
  level: "well",
  geometry: "control",
  emphasis: "hairline",
});
void legalSurfaceA;

const legalSurfaceB = React.createElement(Surface, {
  level: "well",
  geometry: "square",
  emphasis: "drop-candidate",
});
void legalSurfaceB;

const legalSurfaceC = React.createElement(Surface, { level: "page", geometry: "square" });
void legalSurfaceC;
