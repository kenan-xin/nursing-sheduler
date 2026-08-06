// The contract every owner-local control-anchor declaration satisfies (T06).
//
// WHY THE DECLARATIONS DO NOT LIVE HERE. An anchor names one exact element in one
// component's rendered output, so the only file that can keep it honest is the file
// that renders it: a renamed control, a moved button, or a deleted card is then a
// change to two adjacent lines rather than to a distant table nobody reads while
// editing a screen. This module holds only the SHAPE and the attribute name;
// `./anchors` collects the owner-local declarations into the single manifest the
// generated registry validates and the browser fixtures mount.
//
// AN ANCHOR IS NOT A TESTID. `data-testid` says "a test may find this"; a capability
// anchor says "the assistant may send a nurse here, and the host must find this exact
// element in the live DOM before it claims it did". They sit on the same elements
// today by coincidence of good targets, not by rule, and neither may be derived from
// the other -- retiring a testid must not silently retarget a help answer.

import type { NavRouteId } from "@/components/shell/nav-config";

/**
 * The DOM attribute an anchored control renders. Deliberately an attribute rather
 * than a class or an `id`: a class is a styling channel that a re-skin may rewrite,
 * and an `id` must be document-unique for reasons unrelated to help targeting.
 */
export const CAPABILITY_ANCHOR_ATTRIBUTE = "data-capability-anchor";

export interface ControlAnchorDeclaration {
  /** Globally unique, `<route-id>.<control>` by convention. */
  readonly anchorId: string;
  /** The ONE screen this anchor is rendered by. Validated by mounting that route. */
  readonly routeId: NavRouteId;
  /** Plain-language name of the control, safe to show a nurse. Never a URL. */
  readonly label: string;
}

/**
 * Spread onto the anchored element: `<Button {...capabilityAnchorProps(ID)} />`.
 *
 * A helper rather than a literal attribute at each site so
 * {@link CAPABILITY_ANCHOR_ATTRIBUTE} has exactly one definition that both the
 * renderers and the live-DOM resolver read.
 */
export function capabilityAnchorProps(anchorId: string): Record<string, string> {
  return { [CAPABILITY_ANCHOR_ATTRIBUTE]: anchorId };
}

/** The selector that finds an anchor in a live document. */
export function capabilityAnchorSelector(anchorId: string): string {
  // The anchor ids are `[a-z0-9.-]` by validation, so quoting the value is enough
  // and no escaping table is needed; the validator is what keeps that true.
  return `[${CAPABILITY_ANCHOR_ATTRIBUTE}="${anchorId}"]`;
}
