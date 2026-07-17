// Barrel for the entity-editor pure-logic core (T09). No React — unit-testable
// under the node vitest env.

export type {
  EntityId,
  EditorItemBase,
  EditorGroup,
  EntityLabels,
  SyntheticRow,
  EntityDescriptor,
} from "./descriptor";
export { entityKey, sameEntityId } from "./descriptor";

export { sortMembersByItemOrder } from "./membership";
export { getUniqueCopyLabel } from "./duplicate-label";
export {
  isReservedKeyword,
  validateFullEditId,
  validateInlineId,
  type ValidationOk,
  type ValidationErr,
  type ValidationResult,
} from "./validation";
export type {
  WorkingTimeField,
  WorkingTimeIssue,
  WorkingTimeDraft,
  WorkingTimeValue,
  WorkingTimeResult,
} from "./working-time";
export { validateWorkingTimeDraft, paidMinutesFor } from "./working-time";
export type { ItemDraft, GroupDraft } from "./mutations";
export {
  addItem,
  updateItemFields,
  reorderItems,
  reorderGroups,
  duplicateItem,
  deleteItem,
  renameItem,
  addGroup,
  updateGroupFields,
  duplicateGroup,
  deleteGroup,
  renameGroup,
  setGroupMembers,
  toggleGroupMembership,
  reorderByUpload,
  type ReorderByUploadResult,
  type ReorderByUploadOk,
  type ReorderByUploadErr,
} from "./mutations";
