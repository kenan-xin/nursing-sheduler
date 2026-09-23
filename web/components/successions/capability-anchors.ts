// Shift Successions screen control anchors (T06). Declared beside the editor that
// renders them; collected by `lib/capability/anchors`.
//
// WHY THIS ONE IS DECLARED PER-ROUTE RATHER THAN IN THE SHARED SHELL. Five Advanced
// constraint editors mount the same `CardEditorHeader`, so an anchor hard-coded in
// the shell would render on all five routes and the manifest's "this anchor lives on
// exactly this screen" claim would be false on four of them. The shell therefore
// takes an OPTIONAL anchor prop and each route that wants one passes its own.
// Successions is the route the help flow's worked example asks about ("what is a
// succession rule?"), so it is the one that carries an anchor today; the other four
// Advanced editors are registry entries with a screen and no control anchor, which
// is a supported shape rather than a gap.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const SUCCESSIONS_ANCHORS = [
  {
    anchorId: "shift-type-successions.add-succession",
    routeId: "shift-type-successions",
    label: "Add succession button",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const SUCCESSIONS_ADD_ANCHOR = SUCCESSIONS_ANCHORS[0].anchorId;
