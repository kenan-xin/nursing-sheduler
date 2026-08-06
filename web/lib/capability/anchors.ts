// The ONE typed control-anchor manifest (T06).
//
// Every owner-local declaration is imported here and nowhere else, so there is a
// single list the generated registry validates against, the browser fixtures
// enumerate, and the live-DOM resolver trusts. Adding an anchor is: declare it
// beside the component, render it, add the import below. Missing the last step is
// caught by `anchors.test.ts`, which walks the component directories.
//
// `ControlAnchorId` is derived from the declarations rather than hand-written, so a
// capability entry pointing at an anchor that no component declares is a COMPILE
// error -- the fail-closed behaviour starts at the type level, before any runtime
// check gets a chance to be forgotten.

import { DATES_ANCHORS } from "@/components/dates/capability-anchors";
import { RULES_ANCHORS } from "@/components/guided-rules/capability-anchors";
import { OPTIMIZE_ANCHORS } from "@/components/optimize/capability-anchors";
import { PEOPLE_ANCHORS } from "@/components/people/capability-anchors";
import { REQUESTS_ANCHORS } from "@/components/requests/capability-anchors";
import { SAVE_LOAD_ANCHORS } from "@/components/save-load/capability-anchors";
import { SHIFT_TYPES_ANCHORS } from "@/components/shift-types/capability-anchors";
import { SUCCESSIONS_ANCHORS } from "@/components/successions/capability-anchors";
import type { ControlAnchorDeclaration } from "./anchor-contract";

const DECLARED = [
  ...DATES_ANCHORS,
  ...PEOPLE_ANCHORS,
  ...SHIFT_TYPES_ANCHORS,
  ...RULES_ANCHORS,
  ...REQUESTS_ANCHORS,
  ...SUCCESSIONS_ANCHORS,
  ...OPTIMIZE_ANCHORS,
  ...SAVE_LOAD_ANCHORS,
] as const;

/** Every anchor a shipped component declares. Literal union, derived not written. */
export type ControlAnchorId = (typeof DECLARED)[number]["anchorId"];

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
