import {
  pruneOrphanedGuidedRulePins,
  type RequirementCard,
  type ScenarioUiState,
} from "@/lib/scenario";
import {
  buildRequirementCard,
  buildRequirementShiftTypeDomain,
  type RequirementFormState,
} from "./requirements-model";

export type RequirementPatch =
  | { type: "add"; form: RequirementFormState }
  | { type: "update"; uid: string; form: RequirementFormState };

/**
 * Apply an add/update against the supplied LIVE scenario state.
 *
 * This is intentionally store-free. Callers pass it directly to
 * `mutateScenario(state => applyRequirementPatch(state, patch))`, which avoids
 * writing a render-snapshot requirements array over a newer cascade. Updates
 * preserve the durable card identity and the UI-only disabled/applied markers.
 */
export function applyRequirementPatch(
  state: ScenarioUiState,
  patch: RequirementPatch,
): ScenarioUiState {
  const requirements = state.cardsByKind.requirements;
  const domain = buildRequirementShiftTypeDomain(state);
  let nextRequirements: RequirementCard[];

  if (patch.type === "add") {
    nextRequirements = [...requirements, buildRequirementCard(patch.form, domain)];
  } else {
    const source = requirements.find((card) => card.uid === patch.uid);
    if (!source) return state;

    const rebuilt = buildRequirementCard(patch.form, domain, patch.uid);
    const markers: Pick<RequirementCard, "disabled" | "applied"> = {};
    if (source.disabled) markers.disabled = true;
    if (source.applied) markers.applied = true;
    const next = markers.disabled || markers.applied ? { ...rebuilt, ...markers } : rebuilt;
    nextRequirements = requirements.map((card) => (card.uid === patch.uid ? next : card));
  }

  const cardsByKind = { ...state.cardsByKind, requirements: nextRequirements };
  return {
    ...state,
    cardsByKind,
    guidedRulePins: pruneOrphanedGuidedRulePins(state.guidedRulePins, cardsByKind),
  };
}
