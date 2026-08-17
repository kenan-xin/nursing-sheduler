// Requests & Leave screen control anchors (T06). Declared beside the component
// that renders them; collected by `lib/capability/anchors`.

import type { ControlAnchorDeclaration } from "@/lib/capability/anchor-contract";

export const REQUESTS_ANCHORS = [
  {
    anchorId: "shift-requests.mode-toolbar",
    routeId: "shift-requests",
    // NOTE for the browser fixture: this screen renders a required-data gate
    // instead of its editor until a roster range, people and shift types exist,
    // so the anchor's mount contract includes the route's declared fixture seed.
    // That is a DATA precondition, not a mode or feature gate, and the fixture
    // seeds it the same way the v2 surface matrix already does for this route.
    label: "Requests toolbar (Normal / Quick paint)",
  },
] as const satisfies readonly ControlAnchorDeclaration[];

export const REQUESTS_TOOLBAR_ANCHOR = REQUESTS_ANCHORS[0].anchorId;
