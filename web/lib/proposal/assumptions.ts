// Operational assumptions and their structured confirmations (T07; decision R12).
//
// SOME CHANGES ARE AGREEMENTS WITH A PERSON, not settings. Moving a nurse's leave,
// or destroying it as a side effect of shortening the roster period, is a real-world
// commitment the app cannot verify and the model must never assert. So the host asks
// -- once per named person, date and action -- and Apply stays disabled until every
// question has an answer.
//
// THE HOST DERIVES THE FORM. A model may say "they agreed"; that is prose, and prose
// is not a confirmation. Every assumption below is computed from VALIDATED TARGETS:
// the command's own person/date pair, or a LEAVE pin the host's own cascade is about
// to destroy. Nothing here reads model text.
//
// A CONFIRMATION IS BOUND FOUR WAYS -- assumption identity, proposal revision,
// person/date/action, and the moment it was given. Revise, regenerate, a scenario
// change, a target change or a takeover all move the revision, and a confirmation
// from an older revision is then simply not one of this proposal's confirmations. It
// is never "cleared" by anybody remembering to clear it.

import type { ScenarioUiState, UiRequestCell } from "@/lib/scenario";
import type { AssistantCommandV1 } from "./commands";
import { proposalDigest, stableStringify } from "./digest";

export type AssumptionType =
  /** A leave pin is moving to another date. */
  | "leave_moved"
  /** A leave pin is being destroyed — by a range change that drops its date. */
  | "leave_cancelled";

export interface OperationalAssumption {
  /** Deterministic identity: same targets, same id, across re-preparations. */
  assumptionId: string;
  type: AssumptionType;
  /** The named person, rendered exactly as the document holds the reference. */
  person: string;
  /** The date the agreement is currently about. */
  date: string;
  /** The date it is moving to, for `leave_moved`. */
  toDate: string | null;
  /** The question the host asks, verbatim. */
  question: string;
  /** What answering “yes” commits to, so nobody confirms something vague. */
  detail: string;
}

/** One recorded answer. Durable, and bound to the exact proposal revision. */
export interface OperationalConfirmationV1 {
  assumptionId: string;
  type: AssumptionType;
  person: string;
  date: string;
  toDate: string | null;
  /** The proposal revision this answer was given against. */
  proposalRevision: number;
  /** When the confirmer answered. */
  confirmedAt: string;
}

function ref(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function assumptionId(type: AssumptionType, person: string, date: string, toDate: string | null) {
  return `${type}:${proposalDigest({ person, date, toDate })}`;
}

/** Leave pins in a document, keyed by `person|date`. */
function leavePins(state: ScenarioUiState): Map<string, UiRequestCell> {
  const pins = new Map<string, UiRequestCell>();
  for (const cell of state.reqData) {
    if (cell.kind !== "leave") continue;
    pins.set(`${stableStringify(cell.person)}|${stableStringify(cell.date)}`, cell);
  }
  return pins;
}

/**
 * Every operational assumption this change carries.
 *
 * Both arguments are HOST documents -- the validated before and after -- because the
 * second source of assumptions is not a command at all: it is a leave pin the
 * cascade destroys, which only a document comparison can find.
 */
export function deriveAssumptions(
  before: ScenarioUiState,
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): OperationalAssumption[] {
  const assumptions: OperationalAssumption[] = [];
  const claimed = new Set<string>();

  for (const command of commands) {
    if (command.type !== "move_leave") continue;
    const person = ref(command.personId);
    const from = ref(command.fromDate);
    const to = ref(command.toDate);
    claimed.add(`${stableStringify(command.personId)}|${stableStringify(command.fromDate)}`);
    assumptions.push({
      assumptionId: assumptionId("leave_moved", person, from, to),
      type: "leave_moved",
      person,
      date: from,
      toDate: to,
      question: `Has ${person} agreed to move their leave from ${from} to ${to}?`,
      detail:
        "Applying this rewrites the schedule as if the change is already agreed. The app cannot check that with anyone.",
    });
  }

  // Leave the change DESTROYS. The `move_leave` sources above are excluded: their
  // pin does not disappear, it relocates, and asking twice about one agreement would
  // read as two separate commitments.
  const surviving = leavePins(after);
  for (const [key, cell] of leavePins(before)) {
    if (claimed.has(key) || surviving.has(key)) continue;
    const person = ref(cell.person);
    const date = ref(cell.date);
    assumptions.push({
      assumptionId: assumptionId("leave_cancelled", person, date, null),
      type: "leave_cancelled",
      person,
      date,
      toDate: null,
      question: `Has ${person} agreed to give up their leave on ${date}?`,
      detail:
        "This change removes that leave from the schedule. Applying it does not tell anyone, and it cannot be recovered except by Undo.",
    });
  }

  // Stable order, so the same change always renders the same list of questions.
  return assumptions.sort((a, b) => a.assumptionId.localeCompare(b.assumptionId));
}

/**
 * The confirmations that actually belong to `proposalRevision` and answer a live
 * assumption.
 *
 * Filtering rather than trusting the stored list is the point: a confirmation whose
 * assumption no longer exists (the user revised the change) must not be counted, and
 * one recorded against an older revision must not survive into a newer one.
 */
export function activeConfirmations(
  assumptions: readonly OperationalAssumption[],
  confirmations: readonly OperationalConfirmationV1[],
  proposalRevision: number,
): OperationalConfirmationV1[] {
  const live = new Map(assumptions.map((assumption) => [assumption.assumptionId, assumption]));
  return confirmations.filter((confirmation) => {
    if (confirmation.proposalRevision !== proposalRevision) return false;
    const assumption = live.get(confirmation.assumptionId);
    if (!assumption) return false;
    // The identity is hashed into the id already; comparing the fields as well means
    // a stored row whose targets were edited in place cannot pass as an answer.
    return (
      assumption.type === confirmation.type &&
      assumption.person === confirmation.person &&
      assumption.date === confirmation.date &&
      assumption.toDate === confirmation.toDate
    );
  });
}

/** The assumptions still waiting for an answer. Empty means Apply may be offered. */
export function outstandingAssumptions(
  assumptions: readonly OperationalAssumption[],
  confirmations: readonly OperationalConfirmationV1[],
  proposalRevision: number,
): OperationalAssumption[] {
  const answered = new Set(
    activeConfirmations(assumptions, confirmations, proposalRevision).map(
      (confirmation) => confirmation.assumptionId,
    ),
  );
  return assumptions.filter((assumption) => !answered.has(assumption.assumptionId));
}

/**
 * The digest Apply binds to.
 *
 * Order-independent (the ids are sorted) and revision-scoped, so it changes if an
 * answer is withdrawn, if the set of questions changes, or if the proposal is
 * revised -- which is exactly when a previously derived idempotency key must stop
 * matching.
 */
export function confirmationsDigest(confirmations: readonly OperationalConfirmationV1[]): string {
  return proposalDigest(
    [...confirmations]
      .map((confirmation) => ({
        assumptionId: confirmation.assumptionId,
        type: confirmation.type,
        person: confirmation.person,
        date: confirmation.date,
        toDate: confirmation.toDate,
        proposalRevision: confirmation.proposalRevision,
        confirmedAt: confirmation.confirmedAt,
      }))
      .sort((a, b) => a.assumptionId.localeCompare(b.assumptionId)),
  );
}
