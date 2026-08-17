// The ONE typed control-anchor manifest (T06).
//
// Every owner-local declaration is imported here and nowhere else, so there is a
// single list the generated registry validates against, the browser fixtures
// enumerate, and the live-DOM resolver trusts. Adding an anchor is: declare it
// beside the component, render it, add the import below, and add the owner to
// `ANCHOR_SOURCES`. Missing the last step is caught by `anchors.test.ts`, which
// iterates `ANCHOR_SOURCES` -- the production registry this module ships -- and
// asserts every declaration it carries appears in the manifest.
//
// `ControlAnchorId` is derived from the declarations rather than hand-written, so a
// capability entry pointing at an anchor that no component declares is a COMPILE
// error -- the fail-closed behaviour starts at the type level, before any runtime
// check gets a chance to be forgotten.
//
// WHY A REGISTRY RATHER THAN A DISK WALK (bounded-review round 1). The ticket-2
// version of `anchors.test.ts` discovered owner modules by reading the `components/`
// directory and dynamically importing whatever it found. That made the test a generic
// filesystem and module-loader consumer, and the reader ledger had promised this row
// no such exception. The owner set is now THIS list: a typed, frozen, production
// object that both the manifest and the test read through an ordinary import. A new
// owner is added by editing one place, and the test proves that place's contents are
// all collected. The strictly-stronger question -- does every declared anchor
// actually render on its route -- stays with the browser gate named below.

import { DATES_ANCHORS } from "@/components/dates/capability-anchors";
import { RULES_ANCHORS } from "@/components/guided-rules/capability-anchors";
import { OPTIMIZE_ANCHORS } from "@/components/optimize/capability-anchors";
import { PEOPLE_ANCHORS } from "@/components/people/capability-anchors";
import { REQUESTS_ANCHORS } from "@/components/requests/capability-anchors";
import { SAVE_LOAD_ANCHORS } from "@/components/save-load/capability-anchors";
import { SHIFT_TYPES_ANCHORS } from "@/components/shift-types/capability-anchors";
import { SUCCESSIONS_ANCHORS } from "@/components/successions/capability-anchors";
import type { ControlAnchorDeclaration } from "./anchor-contract";

/**
 * One owner's locally-declared control anchors, paired with the owner label for
 * diagnostics. An entry in this list IS the registration that collects a module's
 * declarations into the manifest; nothing else discovers it.
 */
export interface AnchorSource {
  /** The owner directory under `components/`; used only in failure messages. */
  readonly owner: string;
  /** The declaration array the owner module exports. */
  readonly declarations: readonly ControlAnchorDeclaration[];
}

/**
 * Every owner-local anchor module, statically imported. This IS the production
 * registry: the single, typed place a declaration module is collected, read through
 * a normal import by both the manifest below and `anchors.test.ts`.
 *
 * The `as const satisfies readonly AnchorSource[]` form is load-bearing: it checks
 * each entry is a valid `AnchorSource` while preserving the literal tuple inference,
 * so `DECLARED`'s element type stays the union of each owner module's literal
 * declaration types rather than widening to `ControlAnchorDeclaration`. `ControlAnchorId`
 * is therefore the shipped literal union of anchor ids, and a capability entry that
 * names an anchor no component declares is a COMPILE error, before any runtime check
 * gets a chance to be forgotten. Annotating the binding `: readonly AnchorSource[]`
 * instead would widen `declarations` to `readonly ControlAnchorDeclaration[]` and
 * erase the literal union to `string` -- the regression bounded-review round 2 found.
 */
export const ANCHOR_SOURCES = [
  { owner: "dates", declarations: DATES_ANCHORS },
  { owner: "people", declarations: PEOPLE_ANCHORS },
  { owner: "shift-types", declarations: SHIFT_TYPES_ANCHORS },
  { owner: "guided-rules", declarations: RULES_ANCHORS },
  { owner: "requests", declarations: REQUESTS_ANCHORS },
  { owner: "successions", declarations: SUCCESSIONS_ANCHORS },
  { owner: "optimize", declarations: OPTIMIZE_ANCHORS },
  { owner: "save-load", declarations: SAVE_LOAD_ANCHORS },
] as const satisfies readonly AnchorSource[];

const DECLARED = ANCHOR_SOURCES.flatMap(
  (source): readonly ControlAnchorDeclaration[] => source.declarations,
);

/**
 * Every anchor a shipped component declares. Literal union, derived from the const
 * `ANCHOR_SOURCES` tuple's element types -- NOT from the `flatMap` value above, whose
 * inferred element type widens to `ControlAnchorDeclaration` (and therefore `string`).
 * Indexed access into the const tuple preserves each owner module's literal `anchorId`.
 */
export type ControlAnchorId = (typeof ANCHOR_SOURCES)[number]["declarations"][number]["anchorId"];

/**
 * The frozen manifest, in declaration order.
 *
 * Deliberately a LIST rather than a record: duplicate detection belongs to the
 * validator (`./build-manifest`), and a record would silently collapse a duplicate
 * id into one entry before the validator ever saw two.
 */
export const CONTROL_ANCHOR_DECLARATIONS: readonly ControlAnchorDeclaration[] = Object.freeze(
  DECLARED.map((declaration) => Object.freeze({ ...declaration })),
);

/** Look up a declaration by id, or undefined. */
export function findControlAnchor(anchorId: string): ControlAnchorDeclaration | undefined {
  return CONTROL_ANCHOR_DECLARATIONS.find((declaration) => declaration.anchorId === anchorId);
}
