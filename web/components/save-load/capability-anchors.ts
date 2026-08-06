// Save & Load screen control anchors (T06). Declared beside the component that
// renders them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const SAVE_LOAD_ANCHORS = [
  {
    anchorId: "save-and-load.download-backup",
    routeId: "save-and-load",
    label: "Download backup button",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const SAVE_LOAD_DOWNLOAD_ANCHOR = SAVE_LOAD_ANCHORS[0].anchorId;
