// Reference-cascade engine (T07) — pure rename/delete transforms over
// `ScenarioUiState` that keep entity references consistent (spec 06; tech-plan §4;
// design review findings #3/#4/#5). The store wires each op as one tracked
// mutation (T04 `mutateScenario`); these functions never touch the store.

export { renameEntity, applyRename, remapDateReferences } from "./rename";
export { deleteEntity, applyDelete } from "./delete";
export {
  RenameCollisionError,
  type EntityDomain,
  type EntityRef,
  type CollisionReason,
} from "./domain";
