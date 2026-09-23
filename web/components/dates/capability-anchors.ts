// Dates screen control anchors (T06). Declared beside the component that renders
// them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const DATES_ANCHORS = [
  {
    anchorId: "dates.roster-period",
    routeId: "dates",
    label: "Roster period card",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const DATES_ROSTER_PERIOD_ANCHOR = DATES_ANCHORS[0].anchorId;
