// Optimise & Export screen control anchors (T06). Declared beside the component
// that renders them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const OPTIMIZE_ANCHORS = [
  {
    anchorId: "optimize.run-options",
    routeId: "optimize-and-export",
    label: "Setup and Run options",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const OPTIMIZE_RUN_OPTIONS_ANCHOR = OPTIMIZE_ANCHORS[0].anchorId;
