// Guided rule projection/mutation registry (T14b) — public surface.
export type {
  GuidedMutationOutcome,
  GuidedQuickField,
  GuidedRuleMapper,
  GuidedRuleRow,
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
