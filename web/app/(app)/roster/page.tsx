// Roster route entry (G4 — the dedicated /roster route). A thin server entry
// that mounts the client RosterScreen under the same `(app)` shell as every
// other production route. The route group does not affect URLs —
// `app/(app)/roster/page.tsx` is `/roster`.

import { RosterScreen } from "@/components/roster-viewer/roster-screen";

export default function RosterPage() {
  return <RosterScreen />;
}
