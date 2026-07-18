// Guided rule projection/mutation/pin-catalog registry (T14b) — public surface.
export type {
  GuidedMutationOutcome,
  GuidedPinOutcome,
  GuidedQuickField,
  GuidedRuleMapper,
  GuidedRuleProjection,
  GuidedRuleRow,
  PinnableRecord,
} from "./types";

export {
  affinitiesMapper,
  countsMapper,
  coveringsMapper,
  requirementsMapper,
  successionsMapper,
} from "./mappers";

export { GUIDED_RULE_MAPPERS, guidedRuleMapperFor, projectGuidedRules } from "./registry";

export {
  applyAffinityQuickEdit,
  applyCountQuickEdit,
  applyCoveringQuickEdit,
  applyRequirementQuickEdit,
  applySuccessionQuickEdit,
  renameAffinityRule,
  renameCountRule,
  renameCoveringRule,
  renameRequirementRule,
  renameSuccessionRule,
  toggleAffinityRule,
  toggleCountRule,
  toggleCoveringRule,
  toggleRequirementRule,
  toggleSuccessionRule,
} from "./mutations";

export {
  listPinnableRecords,
  pinConstraint,
  repinConstraint,
  unpinConstraint,
  type PinConstraintInput,
} from "./pin-catalog";
