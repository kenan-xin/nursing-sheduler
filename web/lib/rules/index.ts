// Shared requirement-rules foundation (DR-H) — public surface.
//
// A neutral, pure (React-free, AI-free, store-free) module consumed by BOTH the
// domain-UI Shift Types card (DR-4) and the Tier-1 conflict detector. The
// selector-expansion helpers live here as the single owner; downstream tickets
// import, never re-copy.

export {
  type DerivedGroupLike,
  flattenShiftTypeRefs,
  expandDateRefs,
  expandShiftTypeRefs,
} from "./expansion";

export {
  type ScopeRef,
  type DateScopeRef,
  type DateScopeContext,
  isAllScope,
  isAllDates,
} from "./scope";

export {
  type RequirementMatchKind,
  type RequirementMatch,
  requirementsForShiftType,
} from "./requirements";
