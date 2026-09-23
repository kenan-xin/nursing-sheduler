// Applies the persisted desktop sidebar collapse preference to <html> before
// first paint, so a collapsed rail is never painted at 280px and then snapped to
// 60px (G8). Kept as a standalone inline script — not a client component with an
// effect — because it must run synchronously in <head>, exactly like ThemeScript.
//
// The key and the "only `1` collapses" rule here must match side-collapse.ts.
//
// This script never writes to storage, and it never removes the attribute: the
// document arrives without it, so the absent/unreadable/expanded cases all land
// on the expanded default without touching the DOM at all.

const script = `(function () {
  var c = null;
  try { c = localStorage.getItem("ns-side-collapsed"); } catch (e) {}
  if (c === "1") document.documentElement.setAttribute("data-side-collapsed", "1");
})();`;

export function SideCollapseScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

// Exported for the contract test, which executes the exact string that ships.
export const SIDE_COLLAPSE_SCRIPT_SOURCE = script;
