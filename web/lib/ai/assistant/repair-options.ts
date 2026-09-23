// Ranked, safe repair options for a short-staffed or infeasible schedule.
//
// Pure. The static staffing check (lib/rules/shortfalls) says WHERE the schedule is
// short. The playbook says WHICH repairs a ward uses, in what order, and what is never
// allowed. This module joins them into at most three concrete options. Each option has
// the exact operations the host would validate and the real-world agreement it needs.
// Nothing here applies anything: an option reaches the schedule only as a Preview the
// user applies.
//
// Controller rulings (2026-09-24) shape the operations: a borrowed nurse is
// `add_person` + `set_off_request` "must" outside the loan (no `mark_person_off` arm);
// staffing requirements are EXACT counts; a requirement can be lowered only when it
// targets the one short date alone; a skill-mix requirement is never lowered or created.

import { isEditableCountCard } from "@/components/counts/counts-model";
import { paidMinutesFor } from "@/components/entity-editor/core";
import type { CapabilityId } from "@/lib/capability/help-content";
import { generateDateItems, type DateItem } from "@/lib/dates/date-id";
import {
  COUNT_EXPRESSIONS,
  MAX_ASSISTANT_OPERATIONS,
  type AssistantCommandV1,
} from "@/lib/proposal/commands";
import { expandPersonRefs, flattenShiftTypeRefs } from "@/lib/rules/expansion";
import {
  capOf,
  findStaffingShortfalls,
  requirementDateIds,
  toDateId,
  type StaffingFinding,
} from "@/lib/rules/shortfalls";
import type {
  CountCard,
  OrdinaryCountCard,
  PersonRef,
  RequirementCard,
  ScenarioUiState,
  UiShiftRequestCell,
} from "@/lib/scenario";
import {
  CHRONIC_DATE_COUNT,
  FEASIBILITY_INSTRUCTIONS,
  LONG_SHIFT_MINUTES,
  MAX_BORROWED,
  MAX_CAP_RAISE,
  MAX_EXPLAINED_FINDINGS,
  MAX_OPTIONS,
  PLAYBOOK_VERSION,
  REPAIRS,
  REPAIR_ORDER,
  SAFETY_FLOOR,
  SOFT_REQUEST_WEIGHT,
  type Confirmation,
  type EnforcedBy,
  type RepairId,
  type Situation,
} from "./playbook";

export interface RepairOption {
  repairId: RepairId;
  /** One line, concrete, in ward language. */
  title: string;
  /** Why this helps, citing the day, shift and numbers. */
  why: string;
  /** Exactly what prepare_scenario_change / test_feasibility_candidates would carry. Empty = advice only. */
  operations: AssistantCommandV1[];
  confirmation: Confirmation;
  enforcedBy: EnforcedBy;
  confirmationQuestion: string;
  /** Questions the assistant must ask before preparing. */
  needsFromUser: string[];
  /** A screen to open for advice-only options. */
  capabilityId: CapabilityId | null;
  /** static_check: the gap is proven. hypothesis: a guess to test on a copy. */
  evidence: "static_check" | "hypothesis";
}

interface Ctx {
  state: ScenarioUiState;
  items: DateItem[];
  staffIds: Set<string>;
  groupIds: Set<string>;
}

type Builder = (ctx: Ctx, findings: StaffingFinding[], situation: Situation) => RepairOption | null;
type EditableCount = OrdinaryCountCard & { expression: string; target: number };

const asList = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const isAll = (ref: unknown) => String(ref).toUpperCase() === "ALL";

const REASON_WORDS = {
  leave: "on leave",
  day_off: "must be off",
  never_request: "must not work this shift",
} as const;

const PLACEHOLDER = /^Borrowed nurse \d+$/;

function makeCtx(state: ScenarioUiState): Ctx {
  return {
    state,
    items: generateDateItems({ start: state.rangeStart, end: state.rangeEnd }),
    staffIds: new Set(state.staff.map((p) => String(p.id))),
    groupIds: new Set(state.staffGroups.map((g) => String(g.id))),
  };
}

const range = (ctx: Ctx) => ({ start: ctx.state.rangeStart, end: ctx.state.rangeEnd });
const dateLabel = (ctx: Ctx, dateId: string) =>
  ctx.items.find((i) => i.id === dateId)?.description ?? dateId;
const isoOf = (ctx: Ctx, dateId: string) => ctx.items.find((i) => i.id === dateId)?.iso ?? null;
const personRef = (ctx: Ctx, id: string): PersonRef =>
  ctx.state.staff.find((p) => String(p.id) === id)?.id ?? id;
const requirementCard = (ctx: Ctx, uid: string): RequirementCard | undefined =>
  ctx.state.cardsByKind.requirements.find((c) => c.uid === uid);
const countCard = (ctx: Ctx, uid: string): CountCard | undefined =>
  ctx.state.cardsByKind.counts.find((c) => c.uid === uid);
const ruleName = (card: { description?: string; uid: string } | undefined, uid: string) =>
  card?.description || uid;
const staffIn = (ctx: Ctx, refs: PersonRef | PersonRef[]) =>
  [...expandPersonRefs(refs, ctx.state)].filter((id) => ctx.staffIds.has(id));
const isSkillMix = (card: RequirementCard | undefined) => {
  const refs = asList(card?.qualifiedPeople);
  return refs.length > 0 && !refs.some(isAll);
};
/** One plain head count the Rules quick edit can change (the host's `targetsOneShiftType`). */
const isHeadCount = (card: RequirementCard) =>
  !isSkillMix(card) &&
  !card.shiftTypeCoefficients?.length &&
  flattenShiftTypeRefs(card.shiftType).length === 1;
const weightText = (w: number) =>
  w === Infinity ? "infinity" : w === -Infinity ? "-infinity" : String(w);
/** A requirement_conflict is two rules disagreeing, not a shortage of people. */
const gapsOnly = (findings: StaffingFinding[]) =>
  findings.filter((f) => f.kind !== "requirement_conflict");

function makeOption(
  id: RepairId,
  fields: Omit<RepairOption, "repairId" | "confirmation" | "enforcedBy"> & {
    enforcedBy?: EnforcedBy;
  },
): RepairOption {
  const entry = REPAIRS.find((r) => r.id === id);
  if (!entry) throw new Error(`playbook has no repair ${id}`);
  return {
    repairId: id,
    confirmation: entry.confirmation,
    enforcedBy: fields.enforcedBy ?? entry.enforcedBy,
    ...fields,
  };
}

/** The largest people gap any finding reports on a date: one-person fixes need it to be exactly 1. */
const gapOn = (findings: StaffingFinding[], dateId: string) =>
  Math.max(
    0,
    ...gapsOnly(findings)
      .filter((f) => f.dateId === dateId)
      .map((f) => f.required - f.available),
  );

/** Short date ids, in roster order. */
function shortDates(ctx: Ctx, findings: StaffingFinding[]): string[] {
  const set = new Set(findings.flatMap((f) => (f.dateId ? [f.dateId] : [])));
  return ctx.items.map((i) => i.id).filter((id) => set.has(id));
}

/** ISO runs of consecutive roster days that share a non-null key. */
function runsOf(ctx: Ctx, keyOf: (dateId: string) => string | null) {
  const runs: { from: string; to: string; key: string }[] = [];
  let previous: string | null = null;
  for (const item of ctx.items) {
    const key = keyOf(item.id);
    if (key !== null && key === previous) runs[runs.length - 1].to = item.iso;
    else if (key !== null) runs.push({ from: item.iso, to: item.iso, key });
    previous = key;
  }
  return runs;
}

export function classifySituation(
  findings: StaffingFinding[],
  runInfeasible: boolean,
): Situation | null {
  if (findings.some((f) => f.kind === "cap_short")) return "capped";
  const dates = new Set(findings.flatMap((f) => (f.dateId ? [f.dateId] : [])));
  if (dates.size > CHRONIC_DATE_COUNT) return "chronic";
  if (dates.size > 0) return "acute";
  return runInfeasible ? "unexplained" : null;
}

// --- Count rules ----------------------------------------------------------------

/** A count card the `edit_count_rule` arm can carry unchanged except for target and people. */
function editableCount(card: CountCard | undefined): card is EditableCount {
  return (
    card !== undefined &&
    !card.disabled &&
    isEditableCountCard(card) &&
    typeof card.expression === "string" &&
    typeof card.target === "number" &&
    (COUNT_EXPRESSIONS as readonly string[]).includes(card.expression)
  );
}

/** An editable hard upper limit (a cap the staffing check can cite). */
const editableCap = (card: CountCard | undefined): card is EditableCount =>
  editableCount(card) && Number.isFinite(capOf(card.expression, card.target, card.weight));

/**
 * The card's label at a new target. A label that starts "At most <current target>" states
 * the cap itself, so its number follows the target; any other label is the manager's own.
 */
function labelAt(card: EditableCount, target: number): string {
  const label = card.description ?? "";
  const stated = new RegExp(`^(At most )${card.target}(?!\\d)`);
  return target === card.target ? label : label.replace(stated, `$1${target}`);
}

function editCount(
  ctx: Ctx,
  card: EditableCount,
  target: number,
  people: PersonRef[] = asList(card.person),
): Extract<AssistantCommandV1, { type: "edit_count_rule" }> {
  return {
    type: "edit_count_rule",
    ruleId: card.uid,
    description: labelAt(card, target),
    people,
    shiftTypes: asList(card.countShiftTypes).map(String),
    // Span ids become ISO (the card editor's form); chips and group ids stay as written.
    dates: asList(card.countDates).map((d) => {
      const key = String(d);
      return ctx.items.find((i) => i.id === key || i.iso === key)?.iso ?? key;
    }),
    expression: card.expression as (typeof COUNT_EXPRESSIONS)[number],
    target,
    weight: weightText(card.weight),
  };
}

// --- Builders, one per playbook entry -------------------------------------

const alignOverlappingRequirements: Builder = (ctx, findings) => {
  const conflicts = findings.filter((f) => f.kind === "requirement_conflict" && f.dateId);
  if (conflicts.length === 0) return null;
  // ruleIds: the inner requirements, then the outer one.
  const outerId = conflicts[0].ruleIds[conflicts[0].ruleIds.length - 1];
  const outer = requirementCard(ctx, outerId);
  if (!outer) return null;
  const mine = conflicts.filter((f) => f.ruleIds[f.ruleIds.length - 1] === outerId);
  const needed = Math.max(...mine.map((f) => f.required));
  const conflictDates = new Set(mine.map((f) => f.dateId as string));
  const innerNames = [...new Set(mine.flatMap((f) => f.ruleIds.slice(0, -1)))]
    .map((uid) => ruleName(requirementCard(ctx, uid), uid))
    .join(", ");
  const name = ruleName(outer, outerId);
  const shifts = mine[0].shiftTypes.join("/");
  const first = dateLabel(ctx, mine[0].dateId as string);
  const when = mine.length === 1 ? first : `${mine.length} days from ${first}`;
  // Raising changes every date the card covers, so only when each one conflicts. With a
  // preferred count the ceiling is that count, which this arm does not change.
  // One number for every date too: raising to the largest would conflict on the others.
  const canRaise =
    isHeadCount(outer) &&
    outer.preferredNumPeople == null &&
    mine.every((f) => f.required === needed) &&
    requirementDateIds(ctx.state, outer).every((d) => conflictDates.has(d));
  return makeOption("align_overlapping_requirements", {
    title: canRaise
      ? `Raise "${name}" to ${needed} on ${shifts}, so it agrees with ${innerNames}`
      : `Make "${name}" and ${innerNames} agree on the Staffing requirements screen`,
    why: `On ${when}, ${innerNames} need ${needed} on ${shifts}, but "${name}" allows at most ${mine[0].available}. No roster can meet both.`,
    operations: canRaise
      ? [{ type: "set_staffing_requirement_people", ruleId: outerId, requiredNumPeople: needed }]
      : [],
    confirmationQuestion: canRaise
      ? `Is ${needed} on ${shifts} what the ward really needs every day "${name}" covers?`
      : "Which number does the ward really need on that shift?",
    needsFromUser: [
      "Which number the ward really needs on that shift. The app will not lower a skill-mix requirement.",
    ],
    capabilityId: "staffing-requirements",
    evidence: "static_check",
  });
};

const softenHardRequest: Builder = (ctx, findings, situation) => {
  const hit = findings.flatMap((f) =>
    f.away.filter((a) => a.reason === "never_request").map((a) => ({ f, person: a.person })),
  )[0];
  const hard = ctx.state.reqData.filter(
    (c): c is UiShiftRequestCell => c.kind === "request" && !Number.isFinite(c.weight),
  );
  const cell = hit
    ? hard.find(
        (c) =>
          c.weight === -Infinity &&
          String(c.person) === hit.person &&
          toDateId(c.date, range(ctx)) === hit.f.dateId,
      )
    : situation === "unexplained"
      ? hard[0]
      : undefined;
  if (!cell) return null;
  // Softening one request frees one nurse: offer it only when that closes the gap.
  if (hit && hit.f.dateId !== null && gapOn(findings, hit.f.dateId) > 1) return null;
  const dateId = toDateId(cell.date, range(ctx));
  const iso = isoOf(ctx, dateId);
  if (!iso) return null;
  const never = cell.weight === -Infinity;
  const who = String(cell.person);
  return makeOption("soften_hard_request", {
    title: `Ask ${who} whether their "${never ? "never" : "must"} work ${cell.shiftType}" on ${dateLabel(ctx, dateId)} can become a strong preference`,
    why: hit
      ? `${who} is a nurse the ${hit.f.shiftTypes.join("/")} shift could use that day, but the request forbids it.`
      : "A hard request can make a schedule impossible. As a strong preference the solver breaks it only if it must.",
    operations: [
      {
        type: "set_shift_request",
        personId: cell.person,
        shiftType: String(cell.shiftType),
        startDate: iso,
        endDate: iso,
        weight: never ? -SOFT_REQUEST_WEIGHT : SOFT_REQUEST_WEIGHT,
      },
    ],
    confirmationQuestion: `Has ${who} agreed that this request can be a strong preference instead of a hard rule?`,
    needsFromUser: [
      `Why ${who} made the request. Keep it hard if it is for health, childcare or a formal agreement.`,
    ],
    capabilityId: null,
    evidence: hit ? "static_check" : "hypothesis",
  });
};

const extraShiftWillingNurse: Builder = (ctx, findings) => {
  for (const f of findings) {
    if (f.kind !== "cap_short") continue;
    for (const uid of f.capRuleIds) {
      const card = countCard(ctx, uid);
      if (!editableCap(card)) continue;
      const people = staffIn(ctx, card.person);
      if (people.length !== 1) continue;
      const [person] = people;
      const shifts = f.shiftTypes.join("/");
      return makeOption("extra_shift_willing_nurse", {
        title: `Ask ${person} whether they will work one more ${shifts} shift this period`,
        why: `${shifts} needs ${f.required} shifts over the period but the limits allow only ${f.available}. ${person}'s own limit is one of them.`,
        operations: [editCount(ctx, card, card.target + 1)],
        confirmationQuestion: `Has ${person} agreed to one extra ${shifts} shift, within legal and contract limits?`,
        needsFromUser: [
          `Whether ${person} is willing, and that one more shift keeps them within legal rest and contract limits.`,
        ],
        capabilityId: null,
        evidence: "static_check",
      });
    }
  }
  return null;
};

const relaxCountRule: Builder = (ctx, findings, situation) => {
  if (situation === "unexplained") {
    const card = ctx.state.cardsByKind.counts.find(editableCap);
    return editableCap(card) ? relaxOption(ctx, card, 1, null) : null;
  }
  for (const f of findings) {
    if (f.kind !== "cap_short") continue;
    for (const uid of f.capRuleIds) {
      const card = countCard(ctx, uid);
      if (!editableCap(card)) continue;
      const capped = staffIn(ctx, card.person);
      if (capped.length < 2) continue;
      // Only nurses free on more days than the cap can use a higher one.
      const requirement = requirementCard(ctx, f.ruleIds[0]);
      const dates = requirement ? requirementDateIds(ctx.state, requirement) : [];
      const cap = capOf(card.expression, card.target, card.weight);
      const useful = capped.filter((p) => freeDays(ctx, p, dates) > cap).length;
      if (useful === 0) continue;
      const delta = Math.ceil((f.required - f.available) / useful);
      if (delta > MAX_CAP_RAISE) continue;
      return relaxOption(ctx, card, delta, f);
    }
  }
  return null;
};

/**
 * The dates a person is not on leave or a hard day off.
 *
 * ponytail: ignores hard "never" requests, skill-mix bans and date-group cells; the
 * static check re-proves any option, so an overestimate only costs a weaker option.
 */
function freeDays(ctx: Ctx, person: string, dateIds: string[]): number {
  const away = new Set(
    ctx.state.reqData
      .filter(
        (c) =>
          (c.kind === "leave" || (c.kind === "off" && c.weight === Infinity)) &&
          [...expandPersonRefs(c.person, ctx.state)].includes(person),
      )
      .map((c) => toDateId(c.date, range(ctx))),
  );
  return dateIds.filter((d) => !away.has(d)).length;
}

function relaxOption(
  ctx: Ctx,
  card: EditableCount,
  delta: number,
  f: StaffingFinding | null,
): RepairOption {
  const cap = capOf(card.expression, card.target, card.weight);
  const shifts = asList(card.countShiftTypes).join("/");
  const name = ruleName(card, card.uid);
  return makeOption("relax_count_rule", {
    title: `Allow up to ${cap + delta} ${shifts} shifts per nurse this period instead of ${cap} ("${name}")`,
    why: f
      ? `${shifts} needs ${f.required} shifts over the period, but "${name}" lets the team work only ${f.available}.`
      : `"${name}" is a hard limit that can make the schedule impossible.`,
    operations: [editCount(ctx, card, card.target + delta)],
    confirmationQuestion: `Is ${cap + delta} ${shifts} shifts per nurse in this period within your ward's contract and legal limits?`,
    needsFromUser: [
      "That the higher limit is within the ward's contract and legal limits. The app cannot check that.",
    ],
    capabilityId: "shift-counts",
    evidence: f ? "static_check" : "hypothesis",
  });
}

/** The staff group a borrowed nurse must join: null = none needed, undefined = needed but unknown. */
function skillGroup(ctx: Ctx, findings: StaffingFinding[]): string | null | undefined {
  const skilled = findings.filter((f) => f.skillMix);
  if (skilled.length === 0) return null;
  for (const f of skilled) {
    for (const uid of f.ruleIds) {
      const card = requirementCard(ctx, uid);
      if (!isSkillMix(card)) continue;
      const group = asList(card?.qualifiedPeople)
        .map(String)
        .find((ref) => ctx.groupIds.has(ref));
      if (group) return group;
    }
  }
  return undefined;
}

function placeholderNames(ctx: Ctx, count: number): string[] {
  const taken = new Set([...ctx.staffIds, ...ctx.groupIds]);
  const names: string[] = [];
  for (let n = 1; names.length < count; n++) {
    const name = `Borrowed nurse ${n}`;
    if (!taken.has(name)) names.push(name);
  }
  return names;
}

/** Whether a rule's people would take in a nurse who joins `group` (everyone is in ALL). */
const wouldBind = (refs: PersonRef | PersonRef[], group: string | null) =>
  asList(refs).some((r) => isAll(r) || (group !== null && String(r) === group));

/**
 * Hard count rules a borrowed nurse would inherit, narrowed to the ward's own staff. A
 * contracted-hours minimum or a cap would bind her on days she is not here. `null` =
 * one cannot be narrowed by `edit_count_rule`, so no loan is offered.
 */
function narrowedCounts(ctx: Ctx, group: string | null): AssistantCommandV1[] | null {
  const ops: AssistantCommandV1[] = [];
  for (const card of ctx.state.cardsByKind.counts) {
    if (card.disabled || Number.isFinite(card.weight) || !wouldBind(card.person, group)) continue;
    const staff = staffIn(ctx, card.person);
    if (!editableCount(card) || staff.length === 0) return null;
    ops.push(
      editCount(
        ctx,
        card,
        card.target,
        staff.map((id) => personRef(ctx, id)),
      ),
    );
  }
  return ops;
}

/** The dates a cap_short's requirement covers: a loan adds at most one shift per date. */
function cappedDateCount(ctx: Ctx, f: StaffingFinding): number {
  const card = requirementCard(ctx, f.ruleIds[0]);
  return (card ? requirementDateIds(ctx.state, card).length : 0) || ctx.items.length;
}

const borrowTemporaryNurse: Builder = (ctx, all) => {
  const findings = gapsOnly(all);
  const dated = findings.filter((f) => f.dateId !== null);
  const capped = findings.find((f) => f.kind === "cap_short");
  const count = dated.length
    ? Math.max(...dated.map((f) => f.required - f.available))
    : capped
      ? Math.ceil((capped.required - capped.available) / cappedDateCount(ctx, capped))
      : 0;
  if (count < 1 || count > MAX_BORROWED || ctx.items.length === 0) return null;
  const group = skillGroup(ctx, findings);
  if (group === undefined) return null;
  const narrowed = narrowedCounts(ctx, group);
  if (narrowed === null) return null;

  // She is here on the short dates only (or the whole period) and must be off on every
  // other date: a free day between two short dates would be a hire the caps no longer bind.
  const short = shortDates(ctx, dated);
  const loanIds = short.length ? short : ctx.items.map((i) => i.id);
  const offRuns = runsOf(ctx, (id) => (loanIds.includes(id) ? null : "off"));
  // On a date short on ONE shift, pin that shift, but only as many nurses as it is short
  // (counts are exact). A hard sequence rule she would inherit could clash with the pins.
  const pinnable = !ctx.state.cardsByKind.successions.some(
    (c) => !c.disabled && !Number.isFinite(c.weight) && wouldBind(c.person, group),
  );
  const shortShift = (id: string) => {
    const shifts = new Set(dated.filter((f) => f.dateId === id).flatMap((f) => f.shiftTypes));
    return shifts.size === 1 ? [...shifts][0] : null;
  };
  const operations: AssistantCommandV1[] = placeholderNames(ctx, count).flatMap(
    (name, index): AssistantCommandV1[] => [
      { type: "add_person", name, groups: group ? [group] : [] },
      ...offRuns.map(
        ({ from, to }): AssistantCommandV1 => ({
          type: "set_off_request",
          personId: name,
          startDate: from,
          endDate: to,
          weight: "must",
        }),
      ),
      ...(pinnable
        ? runsOf(ctx, (id) => (gapOn(dated, id) > index ? shortShift(id) : null))
        : []
      ).map(
        ({ from, to, key }): AssistantCommandV1 => ({
          type: "set_shift_request",
          personId: name,
          shiftType: key,
          startDate: from,
          endDate: to,
          weight: "must",
        }),
      ),
    ],
  );
  operations.push(...narrowed);
  if (operations.length > MAX_ASSISTANT_OPERATIONS) return null;

  const labels = loanIds.map((id) => dateLabel(ctx, id));
  const when = !short.length
    ? `${labels[0]} to ${labels[labels.length - 1]}`
    : labels.length === 1
      ? labels[0]
      : labels.length <= 3
        ? `${labels.slice(0, -1).join("; ")} and ${labels[labels.length - 1]}`
        : `${labels.length} days from ${labels[0]} to ${labels[labels.length - 1]}`;
  const who = count === 1 ? "a nurse" : `${count} nurses`;
  const skill = group ? `, qualified as ${group}` : "";
  return makeOption("borrow_temporary_nurse", {
    title: `Borrow ${who}${skill} from the float pool, an agency or another ward for ${when}`,
    why: dated.length
      ? `${dated.length === 1 ? "That day is" : "Those days are"} short by up to ${count} ${count === 1 ? "nurse" : "nurses"} even with everyone free working.`
      : "More hands over the period remove the pressure the current staff cannot absorb.",
    operations,
    // A whole-period loan has no days off, so the host cannot tell it from a new hire:
    // the agreement is asked in chat.
    enforcedBy: offRuns.length === 0 ? "chat" : "host_question",
    confirmationQuestion: `Has the lending ward or agency confirmed ${count === 1 ? "the nurse" : "the nurses"} for ${when}${skill}?`,
    needsFromUser: [
      "Which ward, float pool or agency can lend the nurse, and the name to show on the roster (or keep the placeholder).",
      ...(group ? [`That the borrowed nurse is qualified as ${group}.`] : []),
      ...(narrowed.length
        ? ["That the ward's own hard shift limits need not apply to the borrowed nurse."]
        : []),
    ],
    capabilityId: "staff-list",
    evidence: "static_check",
  });
};

const askNurseOnLeave: Builder = (ctx, all) => {
  const findings = gapsOnly(all);
  for (const f of findings) {
    if (f.dateId === null || gapOn(findings, f.dateId) !== 1) continue;
    // She must be the missing nurse in every finding that day, or her leave is not the gap.
    const sameDay = findings.filter((g) => g.dateId === f.dateId);
    const onLeave = f.away.find(
      (a) =>
        a.reason === "leave" &&
        sameDay.every((g) => g.away.some((b) => b.person === a.person && b.reason === "leave")),
    );
    const iso = isoOf(ctx, f.dateId);
    if (!onLeave || !iso) continue;
    const when = dateLabel(ctx, f.dateId);
    const shifts = f.shiftTypes.join("/");
    return makeOption("ask_nurse_on_leave", {
      title: `Ask ${onLeave.person} whether they can give up their leave on ${when} to cover ${shifts}`,
      why: `${when} is one nurse short for ${shifts}, and ${onLeave.person} ${f.skillMix ? "is qualified and " : ""}is on leave that day.`,
      operations: [
        {
          type: "clear_requests",
          personId: personRef(ctx, onLeave.person),
          startDate: iso,
          endDate: iso,
        },
      ],
      confirmationQuestion: `Has ${onLeave.person} agreed to give up their leave on ${when}?`,
      needsFromUser: [
        "What kind of leave it is. Do not ask a nurse on sick or compassionate leave.",
        `Whether ${onLeave.person} has agreed.`,
      ],
      capabilityId: "leave-and-requests",
      evidence: "static_check",
    });
  }
  return null;
};

const runOneShort: Builder = (ctx, all) => {
  const findings = gapsOnly(all);
  for (const f of findings) {
    if (f.dateId === null || gapOn(findings, f.dateId) !== 1) continue;
    // Lowering a requirement closes the gap only if it is part of every finding that day.
    const sameDay = findings.filter((g) => g.dateId === f.dateId);
    for (const uid of f.ruleIds) {
      const card = requirementCard(ctx, uid);
      if (!card || !isHeadCount(card) || card.requiredNumPeople < 2) continue;
      if (!sameDay.every((g) => g.ruleIds.includes(uid))) continue;
      const shift = String(flattenShiftTypeRefs(card.shiftType)[0]);
      const n = card.requiredNumPeople;
      const when = dateLabel(ctx, f.dateId);
      const dates = requirementDateIds(ctx.state, card);
      // A single date cannot be overridden on its own (bead nursing-sheduler-2se).
      const alone = dates.length === 1 && dates[0] === f.dateId;
      return makeOption("run_one_short", {
        title: `Run ${shift} on ${when} with ${n - 1} instead of ${n} (the manager's safety call)`,
        why: alone
          ? `Nobody else is free: ${shift} can have at most ${n - 1} there as things stand.`
          : `Nobody else is free: ${shift} can have at most ${n - 1} there. "${ruleName(card, uid)}" covers other days too, so the app cannot lower it for that day alone.`,
        operations: alone
          ? [{ type: "set_staffing_requirement_people", ruleId: uid, requiredNumPeople: n - 1 }]
          : [],
        confirmationQuestion: `As the manager, are you satisfied it is safe to run ${shift} on ${when} with ${n - 1} nurses?`,
        needsFromUser: [
          "Whether the manager accepts running the shift one short. Only they can make that safety call.",
        ],
        capabilityId: "staffing-requirements",
        evidence: "static_check",
      });
    }
  }
  return null;
};

const splitLongShift: Builder = (ctx, all) => {
  for (const f of gapsOnly(all)) {
    for (const id of f.shiftTypes) {
      const shift = ctx.state.shifts.find((s) => String(s.id) === id);
      const minutes = shift
        ? (shift.durationMinutes ?? paidMinutesFor(shift.startTime, shift.endTime, 0))
        : null;
      if (minutes == null || minutes < LONG_SHIFT_MINUTES) continue;
      const hours = Math.round((minutes / 60) * 10) / 10;
      return makeOption("split_long_shift", {
        title: `Consider splitting the ${id} shift (${hours} h) into two shorter shifts so part-time or borrowed staff can cover half`,
        why: `${id} is short and ${hours} hours long. Two halves are easier to fill.`,
        operations: [],
        confirmationQuestion: "Does the ward want to change how this shift is worked?",
        needsFromUser: ["The two shorter shifts' times, if they want to try it."],
        capabilityId: "shift-types",
        evidence: "hypothesis",
      });
    }
  }
  return null;
};

const BUILDERS: Record<RepairId, Builder> = {
  align_overlapping_requirements: alignOverlappingRequirements,
  soften_hard_request: softenHardRequest,
  extra_shift_willing_nurse: extraShiftWillingNurse,
  relax_count_rule: relaxCountRule,
  borrow_temporary_nurse: borrowTemporaryNurse,
  ask_nurse_on_leave: askNurseOnLeave,
  run_one_short: runOneShort,
  split_long_shift: splitLongShift,
};

export function rankRepairOptions(
  state: ScenarioUiState,
  findings: StaffingFinding[],
  opts: { runInfeasible: boolean },
): RepairOption[] {
  const situation = classifySituation(findings, opts.runInfeasible);
  if (situation === null) return [];
  const ctx = makeCtx(state);
  const options: RepairOption[] = [];
  for (const id of REPAIR_ORDER[situation]) {
    const built = BUILDERS[id](ctx, findings, situation);
    if (built && isSafeOption(state, built)) options.push(built);
    if (options.length === MAX_OPTIONS) break;
  }
  return options;
}

// --- The safety floor, in code --------------------------------------------

const sameRefs = (a: unknown, b: unknown) =>
  JSON.stringify(asList(a).map(String)) === JSON.stringify(asList(b).map(String));

/**
 * The SAFETY_FLOOR line these operations break, or null. A DENYLIST, so it can judge
 * any operations, including a candidate the model wrote itself. `leaveAsked`: the
 * host asks the nurse before leave is removed (a prepared Preview always does, through
 * its assumptions; a repair option only when it is a named-nurse host question).
 */
export function violatesSafetyFloor(
  state: ScenarioUiState,
  operations: readonly AssistantCommandV1[],
  opts: { leaveAsked: boolean },
): string | null {
  const [rest, supervision, skillMix, zero, limit, leave, skillGroup, invented] = SAFETY_FLOOR;
  const ctx = makeCtx(state);
  // A hard day off makes an added nurse a loan, which the Preview asks the lender about.
  const loaned = new Set(
    operations.flatMap((op) =>
      op.type === "set_off_request" && op.weight === "must" ? [String(op.personId)] : [],
    ),
  );
  const hardCount = (uid: string) => {
    const card = countCard(ctx, uid);
    return card !== undefined && !Number.isFinite(card.weight) ? card : undefined;
  };
  const offByKind = (kind: string, ruleId: string) =>
    kind === "successions"
      ? rest
      : kind === "coverings"
        ? supervision
        : kind === "requirements"
          ? zero
          : kind === "counts" && hardCount(ruleId)
            ? limit
            : null;
  const lowered = (uid: string, n: number) => {
    const card = requirementCard(ctx, uid);
    if (n < 1) return zero;
    if (!card || n >= card.requiredNumPeople) return null;
    return isSkillMix(card) || n < skillMixOn(ctx, card) ? skillMix : null;
  };
  for (const op of operations) {
    const broken = (() => {
      switch (op.type) {
        case "set_rule_enabled":
          return op.enabled ? null : offByKind(op.ruleKind, op.ruleId);
        case "remove_rule":
          return offByKind(op.ruleKind, op.ruleId);
        case "edit_succession_rule": {
          const card = ctx.state.cardsByKind.successions.find((c) => c.uid === op.ruleId);
          if (!card || Number.isFinite(card.weight)) return null;
          const same = op.weight === weightText(card.weight) && sameRefs(op.people, card.person);
          return same ? null : rest;
        }
        case "set_staffing_requirement_people":
          return lowered(op.ruleId, op.requiredNumPeople);
        case "edit_staffing_requirement": {
          const card = requirementCard(ctx, op.ruleId);
          if (card && isSkillMix(card)) {
            const same =
              sameRefs(op.qualifiedPeople, card.qualifiedPeople) &&
              sameRefs(op.shiftType, card.shiftType) &&
              sameRefs(op.dates, card.date);
            if (!same) return skillMix;
          }
          return lowered(op.ruleId, op.requiredNumPeople);
        }
        case "add_staffing_requirement":
          return asList(op.qualifiedPeople).some((r) => !isAll(r)) ? skillMix : null;
        case "edit_count_rule": {
          const card = hardCount(op.ruleId);
          if (!card || typeof card.target !== "number") return null;
          if (op.weight !== weightText(card.weight) || op.expression !== card.expression)
            return limit;
          const cap = capOf(String(card.expression), card.target, card.weight);
          if (Number.isFinite(cap) && op.target - card.target > MAX_CAP_RAISE) return limit;
          // Everyone it bound among the ward's own staff stays bound.
          const after = new Set(staffIn(ctx, op.people));
          return staffIn(ctx, card.person).every((p) => after.has(p)) ? null : limit;
        }
        case "clear_requests":
        case "move_leave":
          return opts.leaveAsked ? null : leave;
        case "add_person":
          if (!PLACEHOLDER.test(op.name) || ctx.staffIds.has(op.name) || ctx.groupIds.has(op.name))
            return invented;
          return op.groups.length > 0 && !loaned.has(op.name) ? skillGroup : null;
        case "edit_person":
          return op.name === String(op.personId) ? null : invented;
        default:
          return null;
      }
    })();
    if (broken !== null) return broken;
  }
  return null;
}

/** The largest skill-mix count on a head count's shift and dates: it may not go below it. */
function skillMixOn(ctx: Ctx, card: RequirementCard): number {
  const shifts = new Set(flattenShiftTypeRefs(card.shiftType).map(String));
  const dates = new Set(requirementDateIds(ctx.state, card));
  return Math.max(
    0,
    ...ctx.state.cardsByKind.requirements
      .filter(
        (c) =>
          !c.disabled &&
          isSkillMix(c) &&
          flattenShiftTypeRefs(c.shiftType).some((s) => shifts.has(String(s))) &&
          requirementDateIds(ctx.state, c).some((d) => dates.has(d)),
      )
      .map((c) => c.requiredNumPeople),
  );
}

/** An ALLOWLIST: an operation or shape not named here is never part of a repair. */
export function isSafeOption(state: ScenarioUiState, option: RepairOption): boolean {
  const ctx = makeCtx(state);
  const added = new Set(
    option.operations.flatMap((op) => (op.type === "add_person" ? [op.name] : [])),
  );
  const real = (ref: PersonRef) => ctx.staffIds.has(String(ref));
  const loan = option.confirmation === "lending_ward";
  const nurseAsked = option.confirmation === "named_nurse" && option.enforcedBy === "host_question";
  if (option.operations.length > MAX_ASSISTANT_OPERATIONS) return false;
  if (violatesSafetyFloor(state, option.operations, { leaveAsked: nurseAsked }) !== null)
    return false;
  if (option.operations.filter((op) => op.type === "add_person").length > MAX_BORROWED)
    return false;
  return option.operations.every((op) => {
    switch (op.type) {
      case "set_staffing_requirement_people": {
        // Raise any plain head count; lower one only by 1 (the floor keeps it at 1 or
        // more), and only when it targets a single date.
        const card = requirementCard(ctx, op.ruleId);
        if (!card || !isHeadCount(card) || !Number.isInteger(op.requiredNumPeople)) return false;
        if (op.requiredNumPeople > card.requiredNumPeople) return true;
        return (
          op.requiredNumPeople === card.requiredNumPeople - 1 &&
          requirementDateIds(state, card).length === 1
        );
      }
      case "edit_count_rule": {
        const card = countCard(ctx, op.ruleId);
        if (!editableCount(card)) return false;
        const keep = (o: typeof op) =>
          JSON.stringify([o.description, o.shiftTypes, o.dates, o.expression, o.weight]);
        if (keep(op) !== keep(editCount(ctx, card, op.target))) return false;
        const raise = op.target - card.target;
        const samePeople =
          JSON.stringify(op.people.map(String)) === JSON.stringify(asList(card.person).map(String));
        // A cap goes up by 1..MAX_CAP_RAISE, or (for a loan) binds exactly the staff it bound.
        if (samePeople) return editableCap(card) && raise > 0 && raise <= MAX_CAP_RAISE;
        const staff = new Set(staffIn(ctx, card.person));
        const people = new Set(op.people.map(String));
        return (
          raise === 0 &&
          loan &&
          added.size > 0 &&
          op.people.length === staff.size &&
          people.size === staff.size &&
          [...people].every((p) => staff.has(p))
        );
      }
      case "set_shift_request":
        // Soften a real nurse's request, or pin a nurse this loan adds to a shift.
        return typeof op.weight === "number"
          ? Number.isFinite(op.weight) &&
              (real(op.personId) || ctx.groupIds.has(String(op.personId)))
          : op.weight === "must" && loan && added.has(String(op.personId));
      case "set_off_request":
        // Only a nurse this loan adds: on anyone else it would paint over their leave.
        return op.weight === "must" && loan && added.has(String(op.personId));
      case "clear_requests":
      case "move_leave":
        return nurseAsked && real(op.personId);
      case "add_person":
        // A placeholder (the floor), in real groups, and a skill group only with a host question.
        return (
          loan &&
          op.groups.every((g) => ctx.groupIds.has(g)) &&
          (op.groups.length === 0 || option.enforcedBy === "host_question")
        );
      default:
        return false;
    }
  });
}

// --- Ward language ---------------------------------------------------------

export function explainFinding(state: ScenarioUiState, f: StaffingFinding): string {
  const ctx = makeCtx(state);
  const shifts = f.shiftTypes.join("/");
  const away = f.away.length
    ? ` Away: ${f.away.map((a) => `${a.person} (${REASON_WORDS[a.reason]})`).join(", ")}.`
    : "";
  const label = f.dateId ? dateLabel(ctx, f.dateId) : "";
  switch (f.kind) {
    case "requirement_short":
      return `${label}, ${shifts}: needs ${f.required}${f.skillMix ? " from its group" : ""}, only ${f.available} free.${away}`;
    case "day_short":
      return `${label}: ${shifts} need ${f.required} nurses in total, only ${f.available} free.${away}`;
    case "cap_short": {
      const names = f.capRuleIds.map((uid) => ruleName(countCard(ctx, uid), uid)).join(", ");
      return `${shifts} over the whole period: needs ${f.required} shifts, but the limits (${names}) allow only ${f.available}.`;
    }
    case "requirement_conflict": {
      const names = f.ruleIds.map((uid) => ruleName(requirementCard(ctx, uid), uid));
      const outer = names.pop();
      return `${label}, ${shifts}: ${names.join(", ")} need ${f.required} in total, but "${outer}" allows at most ${f.available}.`;
    }
  }
}

export interface FeasibilityReport {
  playbookVersion: string;
  findings: string[];
  moreFindings: number;
  certainty: string;
  options: RepairOption[];
  safetyFloor: readonly string[];
  instructions: readonly string[];
}

export function buildFeasibilityReport(
  state: ScenarioUiState,
  afterInfeasibleRun: boolean,
): FeasibilityReport {
  const findings = findStaffingShortfalls(state);
  return {
    playbookVersion: PLAYBOOK_VERSION,
    findings: findings.slice(0, MAX_EXPLAINED_FINDINGS).map((f) => explainFinding(state, f)),
    moreFindings: Math.max(0, findings.length - MAX_EXPLAINED_FINDINGS),
    certainty:
      findings.length > 0
        ? "These gaps are certain: the rules as written cannot be met on those days, so you may name them as the cause."
        : "No certain cause was found. The cause is unknown, and every option is a guess to test.",
    options: rankRepairOptions(state, findings, { runInfeasible: afterInfeasibleRun }),
    safetyFloor: SAFETY_FLOOR,
    instructions: FEASIBILITY_INSTRUCTIONS,
  };
}
