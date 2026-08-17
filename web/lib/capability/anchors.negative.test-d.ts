// NEGATIVE TYPE FIXTURE for the control-anchor manifest.
//
// `ControlAnchorId` is derived from the const `ANCHOR_SOURCES` tuple's element types
// so it is the shipped literal union of anchor ids, not `string`. This file pins that
// property: a capability entry that names an anchor no component declares is a COMPILE
// error, before any runtime validation gets a chance to be forgotten. The registry
// redesign in bounded-review round 1 briefly widened the union to `string` by
// annotating `ANCHOR_SOURCES: readonly AnchorSource[]`; this fixture would have caught
// that, and now keeps it from recurring silently.
//
// WHAT THIS FILE ACTUALLY PROVES, stated narrowly:
//
//   * a definitely-unknown anchor id is rejected as a `ControlAnchorId`;
//   * a shipped anchor id is still accepted, so the union is neither widened to
//     `string` nor narrowed to nothing;
//   * the literal union is non-empty (a regressed `never` would fail the positive
//     control).
//
// Checked by `tsc --noEmit`; `.test-d.ts` is not collected by vitest, so nothing
// executes. The `@ts-expect-error` directives are self-checking: if `ControlAnchorId`
// ever widens back to `string`, the error they expect disappears and the directive
// itself becomes the error.

import type { ControlAnchorId } from "./anchors";

// Positive control -- a shipped anchor id is accepted. If `ControlAnchorId` regressed
// to `never`, THIS line errors and the fixture cannot pass vacuously.
const known: ControlAnchorId = "dates.roster-period";
void known;

// The negative half. A definitely-unknown id is rejected by the literal union.
// @ts-expect-error "definitely-not-a-real-anchor" is not a shipped control anchor.
const unknown: ControlAnchorId = "definitely-not-a-real-anchor";
void unknown;

// And a near-miss typo of a shipped id is rejected just the same -- the value must be
// exactly one of the declared literals.
// @ts-expect-error "dates.roster-peroid" is a typo, not a shipped anchor id.
const typo: ControlAnchorId = "dates.roster-peroid";
void typo;
