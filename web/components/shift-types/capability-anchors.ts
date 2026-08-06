// Shifts screen control anchors (T06). Declared beside the component that renders
// them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const SHIFT_TYPES_ANCHORS = [
  {
    anchorId: "shift-types.add-shift-type",
    routeId: "shift-types",
    label: "Add shift button",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const SHIFT_TYPES_ADD_ANCHOR = SHIFT_TYPES_ANCHORS[0].anchorId;
