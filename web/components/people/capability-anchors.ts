// Staff screen control anchors (T06). Declared beside the component that renders
// them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const PEOPLE_ANCHORS = [
  {
    anchorId: "people.add-person",
    routeId: "people",
    label: "Add person button",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const PEOPLE_ADD_PERSON_ANCHOR = PEOPLE_ANCHORS[0].anchorId;
