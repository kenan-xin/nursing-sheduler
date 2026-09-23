// Rules screen control anchors (T06). Declared beside the component that renders
// them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const RULES_ANCHORS = [
  {
    anchorId: "rules.rule-library",
    routeId: "rules",
    // The category list container, which renders whether or not any constraint
    // record exists (it holds the empty state in that case) -- so the anchor's
    // presence is a property of the ROUTE, not of the scenario's contents.
    label: "Plain-English rule library",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const RULES_LIBRARY_ANCHOR = RULES_ANCHORS[0].anchorId;
