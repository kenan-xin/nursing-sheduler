// Route-validity interface for mode transitions (T08c, wired live by T08d;
// unified onto the shared projection by the T08d repair). This reads
// `getNavItemForMode` — the exact same `getNavGroupsForMode` filter the
// sidebar/mobile drawer/Home render — rather than re-deriving the
// Guided/Advanced `advancedOnly` policy independently, so a future
// mode-specific label, hidden route, or availability rule can't drift between
// this seam and what's actually rendered. A route not present in the registry
// at all (e.g. `/design-system`) carries no mode policy and is always valid,
// matching this seam's original always-true behavior for unlisted routes.

import type { AppMode } from "@/lib/mode/mode";
import { findNavItem, getNavItemForMode } from "./nav-config";

export function isRouteValidForMode(path: string, mode: AppMode): boolean {
  if (!findNavItem(path)) return true;
  return getNavItemForMode(path, mode) != null;
}
