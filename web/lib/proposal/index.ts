// The host proposal layer (T07) -- public surface.
//
// PURE, AND OUTSIDE `lib/ai` ON PURPOSE. Validation, cascade derivation, digests,
// operational assumptions and the Apply preconditions are the HOST's, not the
// assistant's; the assistant only names an operation and a target. Keeping this
// layer out of `lib/ai/` is what lets the projection adapter import it without
// violating the assistant-independence boundary (`lib/ai/independence.test.ts`),
// and what makes every rule here testable with no agent, no provider and no store.
//
// Nothing here touches IndexedDB, Zustand, React or the network.

export {
  ASSISTANT_COMMAND_SCHEMA_VERSION,
  ASSISTANT_COMMAND_TYPES,
  MAX_ASSISTANT_OPERATIONS,
  RULE_KINDS,
  assistantCommandListSchema,
  assistantCommandSchema,
  parseAssistantCommands,
  type AssistantCommandType,
  type AssistantCommandV1,
} from "./commands";

export { proposalDigest, stableStringify } from "./digest";

export {
  applyAssistantCommand,
  applyAssistantCommands,
  cellsAtCoordinate,
  withCoordinateCells,
  type CommandRejection,
  type CommandRejectionCode,
  type OperationResult,
} from "./operations";

export {
  SCOPE_LABEL,
  SETUP_DOMAINS,
  SETUP_DOMAIN_LABEL,
  deriveProposalDiff,
  diffScenarioDocuments,
  type DiffChangeKind,
  type DiffScope,
  type ProposalDiff,
  type ProposalDiffEntry,
  type SetupDomain,
} from "./diff";

export {
  activeConfirmations,
  confirmationsDigest,
  deriveAssumptions,
  outstandingAssumptions,
  type AssumptionType,
  type OperationalAssumption,
  type OperationalConfirmationV1,
} from "./assumptions";

export {
  commandsDigest,
  deriveIdempotencyKey,
  describeProposalReadiness,
  type EvidenceReference,
  type LiveProposalBasis,
  type PreparedProposalV1,
  type ProposalBlock,
  type ProposalOutcome,
  type ProposalReadiness,
  type ProposalStatus,
} from "./proposal";

export {
  prepareProposal,
  reviseProposal,
  type PrepareProposalInput,
  type PrepareProposalResult,
} from "./prepare";
