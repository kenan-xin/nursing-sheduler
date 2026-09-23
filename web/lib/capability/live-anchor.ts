// Confirming that an anchor is actually in the live DOM (T06).
//
// The registry can only promise that a control WAS declared by the component that
// owns a screen. Whether it is rendered right now depends on the route having
// mounted, on lazy chunks having arrived, on the mode, and on the screen's own
// conditional rendering. So a navigation action is not allowed to report success --
// or move focus -- until it has found the exact element.
//
// THREE OUTCOMES, NOT TWO. "Missing" and "ambiguous" are separate failures on
// purpose: missing means the target is not there (a stale registry, a route that did
// not mount, a control the current data does not render), while ambiguous means two
// elements claim the same anchor, which is a code defect that would make every
// navigation to it a coin flip. Neither may be reported as success, and neither
// substitutes a nearby element.

import { capabilityAnchorSelector } from "./anchor-contract";

export type LiveAnchorLookup =
  | { readonly status: "ok"; readonly element: HTMLElement }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly count: number };

/** One synchronous look at the current DOM. */
export function findLiveAnchor(root: ParentNode, anchorId: string): LiveAnchorLookup {
  const found = root.querySelectorAll(capabilityAnchorSelector(anchorId));
  if (found.length === 0) return { status: "missing" };
  if (found.length > 1) return { status: "ambiguous", count: found.length };
  const element = found[0];
  // An anchor must be an element that can be revealed and focused. A non-HTML element
  // (an SVG node, say) is treated as missing rather than coerced, because the caller
  // would otherwise call `focus`/`scrollIntoView` on something that may not have them.
  if (!(element instanceof HTMLElement)) return { status: "missing" };
  return { status: "ok", element };
}

export interface WaitForAnchorOptions {
  /** Give up after this long. Bounded: a hung wait is a hung help answer. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Poll until the anchor resolves or the budget runs out.
 *
 * A route reached by client navigation may mount its chunk after the push resolves,
 * so a single synchronous look would report a lazily-loaded screen's anchor as
 * missing. Polling rather than a `MutationObserver` because the failure has to be
 * BOUNDED -- an observer that never fires would wait forever, and "we could not
 * confirm the control" is a legitimate, reportable outcome.
 *
 * An `ambiguous` result short-circuits: two elements will not become one by waiting,
 * and it is a defect worth surfacing immediately.
 */
export async function waitForLiveAnchor(
  root: ParentNode,
  anchorId: string,
  options: WaitForAnchorOptions = {},
): Promise<LiveAnchorLookup> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  let last = findLiveAnchor(root, anchorId);
  while (last.status === "missing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = findLiveAnchor(root, anchorId);
  }
  return last;
}

/** Selectors that are focusable without the host adding a tabindex of its own. */
const NATIVELY_FOCUSABLE =
  "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Reveal the anchor, and focus it when focusing is genuinely possible.
 *
 * Deliberately does NOT add a `tabindex` to make a container focusable: mutating a
 * screen's markup to satisfy a help action would change the app's own tab order as a
 * side effect of asking a question. A container anchor is therefore scrolled into
 * view and reported as `revealed`, which is an honest weaker claim than `focused`.
 */
export function revealAnchor(element: HTMLElement): "focused" | "revealed" {
  // Optional call: scrolling is a courtesy, not the claim being made. An environment
  // without `scrollIntoView` (jsdom, notably) must still let the host confirm and
  // focus the control rather than fail the whole help action on a nicety.
  element.scrollIntoView?.({ block: "center", inline: "nearest" });
  const focusTarget = element.matches(NATIVELY_FOCUSABLE)
    ? element
    : element.querySelector<HTMLElement>(NATIVELY_FOCUSABLE);
  if (focusTarget && !focusTarget.hasAttribute("disabled")) {
    focusTarget.focus({ preventScroll: true });
    return "focused";
  }
  return "revealed";
}
