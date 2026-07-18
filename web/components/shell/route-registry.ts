// Route-validity interface for mode transitions (T08c). `nav-config.ts` is
// still the one visible route set, unfiltered by mode — DL10/nav-config.ts:
// "the nav set is identical regardless of mode; mode changes how content is
// presented, never what is reachable." So every shipped route is valid in
// either mode today; this always returns `true`.
//
// T08d (blocked on T14 `/rules`) will replace this body with the real
// mode-filtered check once Advanced-only routes exist (Requirements,
// Successions, Counts, Affinities, Coverings, Export Layout). Until then this
// is the seam `useModeTransition` needs so a mode change can ask "does the
// current route survive?" without T08d having shipped yet.

import type { AppMode } from "@/lib/mode/mode";

export function isRouteValidForMode(_path: string, _mode: AppMode): boolean {
  return true;
}
