// Operational assumptions and their structured confirmations (T07; decision R12).
//
// SOME CHANGES ARE AGREEMENTS WITH A PERSON, not settings. Moving a nurse's leave,
// or destroying it as a side effect of shortening the roster period, is a real-world
// commitment the app cannot verify and the model must never assert. So the host asks
// -- once per named person, unbroken run of dates, and action -- and Apply stays disabled until every
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

import { dateIdToIso, generateDateItems, isoToUtcMs } from "@/lib/dates/date-id";
import { expandPersonRefs } from "@/lib/rules/expansion";
import { capOf } from "@/lib/rules/shortfalls";
import type { ScenarioUiState, UiRequestCell } from "@/lib/scenario";
import type { AssistantCommandV1 } from "./commands";
import { proposalDigest, stableStringify } from "./digest";

export type AssumptionType =
  /** A leave pin is moving to another date. */
  | "leave_moved"
  /** A leave pin is being destroyed — by a range change that drops its date. */
  | "leave_cancelled"
  /** A nurse from another ward or agency is added for a bounded run of days. */
  | "borrowed_staff_arranged"
  /** One named nurse's own hard limit goes up. */
  | "extra_shifts_agreed";

export interface OperationalAssumption {
  /** Deterministic identity: same targets, same id, across re-preparations. */
  assumptionId: string;
  type: AssumptionType;
  /** The named person, rendered exactly as the document holds the reference. */
  person: string;
  /** The date the agreement is currently about. */
  date: string;
  /** `leave_moved`: where it moves to. `leave_cancelled` / `borrowed_staff_arranged`: the run's last date (null for one day). */
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/**
 * A run of calendar days as a ward writes it: "14 Oct", "10–16 Oct", "30 Oct – 1 Nov",
 * "30 Dec 2026 – 2 Jan 2027". The month names are fixed here: ICU's en-GB "Sept"
 * would make the same question read differently on another runtime.
 */
export function calendarSpan(fromIso: string, toIso: string): string {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = `${fd} ${MONTHS[fm - 1]}`;
  if (fromIso === toIso) return from;
  if (fy !== ty) return `${from} ${fy} – ${td} ${MONTHS[tm - 1]} ${ty}`;
  if (fm !== tm) return `${from} – ${td} ${MONTHS[tm - 1]}`;
  return `${fd}–${td} ${MONTHS[fm - 1]}`;
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
 * Where each person or staff group a batch renames ends up, keyed as leave pins key a
 * person. A rename cascade re-labels leave -- it does not cancel it -- so without this
 * a plain rename would ask "has ana agreed to give up their leave". Same "changed text"
 * rule as the Staff screen (`edit_person` / `edit_people_group` in `operations.ts`).
 */
function finalNames(commands: readonly AssistantCommandV1[]): (personKey: string) => string {
  const step = new Map<string, string>();
  for (const command of commands) {
    if (command.type === "edit_person" && command.name !== String(command.personId)) {
      step.set(stableStringify(command.personId), stableStringify(command.name.trim()));
    }
    if (command.type === "edit_people_group" && command.newGroupId !== command.groupId) {
      step.set(stableStringify(command.groupId), stableStringify(command.newGroupId.trim()));
    }
  }
  // ponytail: follows chains (a -> b -> c) but not a batch that reuses a freed name for
  // someone else; such a batch may ask one extra, answerable question.
  return (personKey) => {
    let current = personKey;
    for (let hops = 0; hops < step.size; hops += 1) {
      const next = step.get(current);
      if (next === undefined) break;
      current = next;
    }
    return current;
  };
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
  const renamedTo = finalNames(commands);
  const lost: UiRequestCell[] = [];
  for (const [key, cell] of leavePins(before)) {
    const followed = `${renamedTo(stableStringify(cell.person))}|${stableStringify(cell.date)}`;
    if (claimed.has(key) || surviving.has(key) || surviving.has(followed)) continue;
    lost.push(cell);
  }
  assumptions.push(...cancelledLeave(before, lost));

  assumptions.push(...borrowedStaff(after, commands), ...extraShifts(before, after, commands));

  // Stable order, so the same change always renders the same list of questions.
  return assumptions.sort((a, b) => a.assumptionId.localeCompare(b.assumptionId));
}

/**
 * Leave the change destroys, ONE question per unbroken run of one person's days.
 * Clearing a week is one agreement with that nurse, not seven. A one-day run keeps
 * `toDate: null`, so its id is the one a per-day question always had and a stored
 * answer to it still counts. A date the BEFORE range cannot resolve gets its own
 * question with its raw id.
 */
function cancelledLeave(before: ScenarioUiState, lost: readonly UiRequestCell[]) {
  const range = { start: before.rangeStart, end: before.rangeEnd };
  const byPerson = new Map<string, { cell: UiRequestCell; iso: string | null }[]>();
  for (const cell of lost) {
    const key = stableStringify(cell.person);
    const days = byPerson.get(key) ?? [];
    days.push({ cell, iso: dateIdToIso(String(cell.date), range) });
    byPerson.set(key, days);
  }
  const assumptions: OperationalAssumption[] = [];
  for (const days of byPerson.values()) {
    days.sort((a, b) => (a.iso ?? "").localeCompare(b.iso ?? ""));
    const runs: (typeof days)[] = [];
    for (const day of days) {
      const run = runs[runs.length - 1];
      const previous = run?.[run.length - 1];
      const next =
        previous?.iso && day.iso && isoToUtcMs(day.iso) - isoToUtcMs(previous.iso) === DAY_MS;
      if (next) run.push(day);
      else runs.push([day]);
    }
    for (const run of runs) {
      const first = run[0];
      const last = run[run.length - 1];
      const person = ref(first.cell.person);
      const date = ref(first.cell.date);
      const toDate = run.length > 1 ? ref(last.cell.date) : null;
      const when = first.iso && last.iso ? calendarSpan(first.iso, last.iso) : date;
      assumptions.push({
        assumptionId: assumptionId("leave_cancelled", person, date, toDate),
        type: "leave_cancelled",
        person,
        date,
        toDate,
        question: `Has ${person} agreed to give up their leave on ${when}?`,
        detail:
          (run.length > 1
            ? `This change removes all ${run.length} days of that leave from the schedule.`
            : "This change removes that leave from the schedule.") +
          " Applying it does not tell anyone, and it cannot be recovered except by Undo.",
      });
    }
  }
  return assumptions;
}

/**
 * A borrowed nurse, read structurally from the documents rather than from any
 * model-set flag: `add_person` plus a hard `set_off_request` ("must") for the same
 * person in one change -- the loan shape people-ops builds (`repair-options.ts`'s
 * `borrow_temporary_nurse`; no `mark_person_off` arm exists). An ordinary new hire
 * has no hard days off and is not asked about -- the two are indistinguishable
 * otherwise, so a whole-period add with no off days stays chat-only (`enforcedBy:
 * "chat"` in the repair playbook). The loan itself is read from the AFTER document:
 * the days she is NOT hard-off.
 */
function borrowedStaff(
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): OperationalAssumption[] {
  const loaned = new Set(
    commands.flatMap((command) =>
      command.type === "set_off_request" && command.weight === "must"
        ? [ref(command.personId)]
        : [],
    ),
  );
  const items = generateDateItems({ start: after.rangeStart, end: after.rangeEnd });
  return commands.flatMap((command) => {
    if (command.type !== "add_person" || !loaned.has(command.name)) return [];
    const off = new Set(
      after.reqData
        .filter(
          (cell) =>
            cell.kind === "off" && cell.weight === Infinity && ref(cell.person) === command.name,
        )
        .map((cell) => ref(cell.date)),
    );
    const loan = items.filter((item) => !off.has(item.id) && !off.has(item.iso));
    if (loan.length === 0) return [];
    const first = loan[0].iso;
    const last = loan[loan.length - 1].iso;
    const skills = command.groups.length > 0 ? command.groups.join(", ") : "no staff group";
    return [
      {
        assumptionId: assumptionId("borrowed_staff_arranged", command.name, first, last),
        type: "borrowed_staff_arranged",
        person: command.name,
        date: first,
        toDate: last,
        question: `Has the lending ward or agency confirmed ${command.name} for ${first} to ${last}, qualified as ${skills}?`,
        detail:
          "Applying this adds a nurse the ward does not employ. The app cannot check the loan or her qualifications with anyone.",
      },
    ];
  });
}

/** Raising ONE named nurse's own hard limit is an agreement with that nurse. */
function extraShifts(
  before: ScenarioUiState,
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): OperationalAssumption[] {
  const staffIds = new Set(before.staff.map((person) => String(person.id)));
  return commands.flatMap((command) => {
    if (command.type !== "edit_count_rule") return [];
    const was = before.cardsByKind.counts.find((card) => card.uid === command.ruleId);
    const now = after.cardsByKind.counts.find((card) => card.uid === command.ruleId);
    if (!was || !now || typeof was.expression !== "string" || typeof was.target !== "number")
      return [];
    if (typeof now.expression !== "string" || typeof now.target !== "number") return [];
    const oldCap = capOf(was.expression, was.target, was.weight);
    const newCap = capOf(now.expression, now.target, now.weight);
    if (!Number.isFinite(oldCap) || !(newCap > oldCap)) return [];
    const people = [...expandPersonRefs(was.person, before)].filter((id) => staffIds.has(id));
    if (people.length !== 1) return [];
    const [person] = people;
    const period = `${before.rangeStart}~${before.rangeEnd}`;
    const cap = Number.isFinite(newCap) ? String(newCap) : "no limit";
    return [
      {
        assumptionId: assumptionId("extra_shifts_agreed", person, period, cap),
        type: "extra_shifts_agreed",
        person,
        date: period,
        toDate: cap,
        question: `Has ${person} agreed to work up to ${cap} ${command.shiftTypes.join("/")} shifts in this period?`,
        detail:
          "Applying this lets the roster give them more shifts than their limit allowed. The app cannot check that they agreed, or that it is within legal limits.",
      },
    ];
  });
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
