// Ranked, safe repair options for a short-staffed or infeasible schedule.
//
// Pure. The static staffing check (lib/rules/shortfalls) says WHERE the schedule is
// short. The playbook says WHICH repairs a ward uses, in what order, and what is never
// allowed. This module joins them into at most three concrete options. Each option has
// the exact operations the host would validate and the real-world agreement it needs.
// Nothing here applies anything: an option reaches the schedule only as a Preview the
// user applies.
//
// Controller rulings (2026-09-24, d582 2026-09-27) shape the operations: a borrowed nurse is
// a TEMPORARY COVER (`add_temporary_cover`), one per short (date, shift) -- a staffing credit
// the reads apply, never a solver person, so no `mark_person_off` arm is needed and no rule,
// pin or roster cell names her;
// staffing requirements are EXACT counts; a requirement is lowered for one date through a
// date exception (set_staffing_requirement_on_date), or lowered outright when it targets
// that date alone; a skill-mix requirement is never lowered, and no repair creates one (a
// skill-mix gap is closed by covering into its group).

import { isContractedHoursCard, isEditableCountCard } from "@/components/counts/counts-model";
import { formatHalfHours } from "@/components/counts/half-hour-codec";
import {
  awayDays,
  computeStaffingBalance,
  contractOf,
  type NurseContract,
} from "./staffing-balance";
import { skillMixFloor } from "@/components/requirements/requirements-model";
import { paidMinutesFor } from "@/components/entity-editor/core";
import type { CapabilityId } from "@/lib/capability/help-content";
import { formatShortDate, generateDateItems, type DateItem } from "@/lib/dates/date-id";
import {
  COUNT_EXPRESSIONS,
  MAX_ASSISTANT_OPERATIONS,
  type AssistantCommandV1,
} from "@/lib/proposal/commands";
import { expandPersonRefs, expandShiftTypeRefs, flattenShiftTypeRefs } from "@/lib/rules/expansion";
import type { ResolvedCoreMember } from "@/lib/optimize/explanation";
import { stableStringify } from "@/lib/proposal/digest";
import { applyAssistantCommands } from "@/lib/proposal/operations";
import {
  capOf,
  findStaffingShortfalls,
  requiredOn,
  requirementDateIds,
  requirementDateIsos,
  skillMixOverflow,
  toDateId,
  type StaffingFinding,
} from "@/lib/rules/shortfalls";
// Direct path: the barrel re-exports this module and `@/lib/scenario` would cycle.
import { cardNeedOn, coverStatuses } from "@/lib/scenario/temporary-cover";
import type {
  ContractedHoursCountCard,
  CountCard,
  DateRef,
  OrdinaryCountCard,
  PersonRef,
  RequirementCard,
  ScenarioUiState,
  SuccessionCard,
  UiRequestCell,
  UiShiftRequestCell,
} from "@/lib/scenario";
import {
  CHRONIC_DATE_COUNT,
  FEASIBILITY_INSTRUCTIONS,
  LONG_SHIFT_MINUTES,
  MAX_BORROWED,
  MAX_CAP_RAISE,
  MAX_EXPLAINED_FINDINGS,
  MAX_LEAVE_CHANGES,
  MAX_LEAVE_MOVE_DAYS,
  MAX_NEW_STAFF,
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
  /** The solver's proven core after a failed run, or null. */
  core: readonly ResolvedCoreMember[] | null;
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

const PLACEHOLDER = /^(Borrowed|New) nurse \d+$/;

function makeCtx(state: ScenarioUiState, core: readonly ResolvedCoreMember[] | null = null): Ctx {
  return {
    state,
    core,
    items: generateDateItems({ start: state.rangeStart, end: state.rangeEnd }),
    staffIds: new Set(state.staff.map((p) => String(p.id))),
    groupIds: new Set(state.staffGroups.map((g) => String(g.id))),
  };
}

const range = (ctx: Ctx) => ({ start: ctx.state.rangeStart, end: ctx.state.rangeEnd });
/**
 * A rule a repair may change: any rule with no proven core, else one the core names. Each
 * builder picks among these, so an unrelated rule written first never hides one that helps.
 */
const onCore = (ctx: Ctx, uid: string) =>
  !ctx.core?.length || ctx.core.some((m) => m.ruleId === uid);
/** A nurse's request on `iso` a repair may change: as `onCore`, by nurse and date. */
const requestOnCore = (ctx: Ctx, person: string, iso: string | null) =>
  !ctx.core?.length ||
  ctx.core.some((m) => m.kind === "request" && m.nurse === person && m.date === iso);
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
/** Named qualifiedPeople: everyone else is banned from the shift. */
const isNamed = (card: RequirementCard | undefined) => {
  const refs = asList(card?.qualifiedPeople);
  return refs.length > 0 && !refs.some(isAll);
};
/** A card that limits who counts: named qualifiedPeople (bans others) or a skill mix (bans nobody). */
const isSkillMix = (card: RequirementCard | undefined) =>
  isNamed(card) || (card?.skillMix?.length ?? 0) > 0;
/**
 * A skill group: a staff group some requirement counts by, named in its skill mix or its
 * named qualifiedPeople. Who is in one decides qualification, so only the manager or a
 * confirmed borrow changes it.
 */
const countedGroup = (ctx: Ctx, groupId: string) =>
  ctx.state.cardsByKind.requirements.some(
    (c) =>
      (c.skillMix ?? []).some((e) => String(e.people) === groupId) ||
      (isNamed(c) && asList(c.qualifiedPeople).map(String).includes(groupId)),
  );
/** One plain head count the Rules quick edit can change (the host's `targetsOneShiftType`). */
const isHeadCount = (card: RequirementCard) =>
  asList(card.qualifiedPeople).every(isAll) &&
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

/** Span ids become ISO (the card editor's form); chips and group ids stay as written. */
const formDate = (ctx: Ctx, ref: DateRef) => {
  const key = String(ref);
  return ctx.items.find((i) => i.id === key || i.iso === key)?.iso ?? key;
};

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
    dates: asList(card.countDates).map((d) => formDate(ctx, d)),
    expression: card.expression as (typeof COUNT_EXPRESSIONS)[number],
    target,
    weight: weightText(card.weight),
  };
}

// --- Builders, one per playbook entry -------------------------------------

const alignOverlappingRequirements: Builder = (ctx, findings) => {
  const conflicts = findings.filter(
    (f) =>
      f.kind === "requirement_conflict" && f.dateId && onCore(ctx, f.ruleIds[f.ruleIds.length - 1]),
  );
  if (conflicts.length === 0) return null;
  // ruleIds: the inner requirements, then the outer one.
  const outerId = conflicts[0].ruleIds[conflicts[0].ruleIds.length - 1];
  const outer = requirementCard(ctx, outerId);
  if (!outer) return null;
  const mine = conflicts.filter((f) => f.ruleIds[f.ruleIds.length - 1] === outerId);
  const needed = Math.max(...mine.map((f) => f.required));
  const conflictDates = new Set(mine.map((f) => f.dateId as string));
  // A one-card conflict is its own skill mix: groups that share no one (shortfalls.ts).
  const innerNames =
    [...new Set(mine.flatMap((f) => f.ruleIds.slice(0, -1)))]
      .map((uid) => ruleName(requirementCard(ctx, uid), uid))
      .join(", ") || `its skill mix (${mine[0].mixPeople}, who share no one)`;
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
    !outer.requiredNumPeopleOverrides?.length &&
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

type HardCell = UiShiftRequestCell | Extract<UiRequestCell, { kind: "off" }>;
const isHardCell = (c: UiRequestCell): c is HardCell =>
  (c.kind === "request" || c.kind === "off") && !Number.isFinite(c.weight);

const softenHardRequest: Builder = (ctx, findings, situation) => {
  const hard = ctx.state.reqData.filter(isHardCell);
  const picked = (c: HardCell | undefined): c is HardCell =>
    c !== undefined &&
    requestOnCore(ctx, String(c.person), isoOf(ctx, toDateId(c.date, range(ctx))));
  const cellFor = (person: string, dateId: string | null, reason: string) =>
    hard.find(
      (c) =>
        (reason === "day_off"
          ? c.kind === "off" && c.weight === Infinity
          : c.kind === "request" && c.weight === -Infinity) &&
        String(c.person) === person &&
        toDateId(c.date, range(ctx)) === dateId,
    );
  // Softening one request frees one nurse: only on a short date that one nurse closes.
  const hit = findings
    .flatMap((f) =>
      f.away
        .filter((a) => a.reason === "never_request" || a.reason === "day_off")
        .map((a) => ({ f, cell: cellFor(a.person, f.dateId, a.reason) })),
    )
    .find(({ f, cell }) => picked(cell) && f.dateId !== null && gapOn(findings, f.dateId) <= 1);
  const anyHit = findings.some((f) =>
    f.away.some((a) => a.reason === "never_request" || a.reason === "day_off"),
  );
  const cell = hit
    ? hit.cell
    : !anyHit && situation === "unexplained"
      ? hard.find(picked)
      : undefined;
  if (!cell) return null;
  const at = (c: HardCell) => ctx.items.findIndex((i) => i.id === toDateId(c.date, range(ctx)));
  let first = at(cell);
  if (first < 0) return null;
  let last = first;
  // A guess softens the nurse's whole run of this request (l3m: one day of a week of
  // "never nights" never helps). A static-check hit frees her on its one short date only.
  if (!hit) {
    const shiftOf = (c: HardCell) => (c.kind === "request" ? String(c.shiftType) : null);
    const run = new Set(
      hard
        .filter(
          (c) =>
            String(c.person) === String(cell.person) &&
            c.kind === cell.kind &&
            c.weight === cell.weight &&
            shiftOf(c) === shiftOf(cell),
        )
        .map(at)
        // An imported request can sit outside the roster range (at() === -1).
        .filter((i) => i >= 0),
    );
    while (run.has(first - 1)) first--;
    while (run.has(last + 1)) last++;
  }
  const iso = ctx.items[first].iso;
  const endIso = ctx.items[last].iso;
  const who = String(cell.person);
  const when =
    first === last
      ? ctx.items[first].description
      : `${ctx.items[first].description} to ${ctx.items[last].description}`;
  const dayOff = cell.kind === "off";
  const never = !dayOff && cell.weight === -Infinity;
  const request = dayOff
    ? `must be off on ${when}`
    : `${never ? "never" : "must"} work ${cell.shiftType}" on ${when}`;
  return makeOption("soften_hard_request", {
    title: dayOff
      ? `Ask ${who} whether their hard day off on ${when} can become a strong wish to be off`
      : `Ask ${who} whether their "${request} can become a strong preference`,
    why: hit
      ? `${who} is a nurse the ${hit.f.shiftTypes.join("/")} shift could use that day, but the ${dayOff ? "day off" : "request"} forbids it.`
      : "A hard request can make a schedule impossible. As a strong preference the optimiser breaks it only if it must.",
    operations: [
      dayOff
        ? {
            type: "set_off_request",
            personId: cell.person,
            startDate: iso,
            endDate: endIso,
            weight: SOFT_REQUEST_WEIGHT,
          }
        : {
            type: "set_shift_request",
            personId: cell.person,
            shiftType: String(cell.shiftType),
            startDate: iso,
            endDate: endIso,
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
    // One extra shift closes a gap of one shift, no more.
    if (f.kind !== "cap_short" || f.required - f.available > 1) continue;
    for (const uid of f.capRuleIds) {
      const card = countCard(ctx, uid);
      if (!editableCap(card) || !onCore(ctx, uid)) continue;
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
          `Whether ${person} is willing, and that one more shift keeps them within the legal working-hour and contract limits.`,
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
    // Ruling (spdk, 2026-09-27): never guess at an exact count (x = T). Raising it raises
    // its floor too, and with no cap_short its cap already covers the demand, so a raise
    // cannot help (l3m: "exactly six nights" 6 -> 7 asked for 98 nights of 84). The side
    // that can bind is its floor, and lowering a floor, changing the expression or
    // softening a hard count all break the safety floor. Relax the first true cap instead.
    // (A hard-negative "|x - T|^2" is exact too.)
    const card = ctx.state.cardsByKind.counts.find(
      (c) =>
        editableCap(c) &&
        c.expression !== "x = T" &&
        c.expression !== "|x - T|^2" &&
        onCore(ctx, c.uid),
    );
    return editableCap(card) ? relaxOption(ctx, card, 1, null) : null;
  }
  for (const f of findings) {
    if (f.kind !== "cap_short") continue;
    for (const uid of f.capRuleIds) {
      const card = countCard(ctx, uid);
      if (!editableCap(card) || !onCore(ctx, uid)) continue;
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

// --- Contracted hours (4h5a) -------------------------------------------------

const contractCards = (ctx: Ctx) =>
  ctx.state.cardsByKind.counts.filter(
    (c): c is ContractedHoursCountCard => !c.disabled && isContractedHoursCard(c),
  );

/**
 * Lower a contracted minimum. Proven first per nurse (her free days cannot give her
 * floor), then for the team (the floors need more working days than the staffing
 * numbers allow); otherwise one day less on the first contract, as a guess to test.
 */
const relaxContractedHours: Builder = (ctx) => {
  const cards = contractCards(ctx).filter((c) => onCore(ctx, c.uid));
  if (cards.length === 0) return null;
  const days = ctx.items.length;
  const step = (c: NurseContract) => Math.max(...c.workCoefs);

  for (const card of cards) {
    for (const person of staffIn(ctx, card.person)) {
      const c = contractOf(ctx.state, person);
      if (c?.card.uid !== card.uid) continue;
      const away = awayDays(ctx.state, person);
      const most = mostContracted(ctx.state, person, c);
      if (c.floor <= most) continue;
      return contractOption(
        ctx,
        card,
        most,
        `${person} is on leave or off on ${away.leave + away.off} of the ${days} days, so they can work at most ${formatHalfHours(most)}, less than the contracted minimum of ${formatHalfHours(c.floor)}.`,
      );
    }
  }

  const mostShifts = computeStaffingBalance(ctx.state)?.mostShifts ?? null;
  if (mostShifts !== null) {
    let need = 0;
    for (const person of ctx.staffIds) {
      const c = contractOf(ctx.state, person);
      if (!c) continue;
      const leave = awayDays(ctx.state, person).leave * c.leaveCoef;
      need += Math.max(0, Math.ceil((c.floor - leave) / step(c)));
    }
    if (need > mostShifts) {
      const [card] = [...cards].sort(
        (a, b) => staffIn(ctx, b.person).length - staffIn(ctx, a.person).length,
      );
      const c = contractOf(ctx.state, staffIn(ctx, card.person)[0])!;
      const fewer = Math.ceil((need - mostShifts) / staffIn(ctx, card.person).length);
      return contractOption(
        ctx,
        card,
        c.floor - fewer * step(c),
        `The contracted minimums ask for at least ${need} working days, but the staffing numbers allow at most ${mostShifts} shifts in the period, so no roster can meet them.`,
      );
    }
  }

  const [card] = cards;
  const c = contractOf(ctx.state, staffIn(ctx, card.person)[0] ?? "");
  if (!c || c.card.uid !== card.uid) return null;
  return contractOption(ctx, card, c.floor - step(c), null);
};

const contractHours = (card: ContractedHoursCountCard): [number, number] =>
  Array.isArray(card.target) ? [card.target[0], card.target[1]] : [card.target, card.target];

function contractEdit(
  ctx: Ctx,
  card: ContractedHoursCountCard,
  floor: number,
): Extract<AssistantCommandV1, { type: "edit_contracted_hours" }> {
  return {
    type: "edit_contracted_hours",
    ruleId: card.uid,
    description: card.description ?? "",
    people: asList(card.person),
    dates: asList(card.countDates).map((d) => formDate(ctx, d)),
    minHours: floor / 2,
    maxHours: contractHours(card)[1] / 2,
  };
}

function contractOption(
  ctx: Ctx,
  card: ContractedHoursCountCard,
  newFloor: number,
  proof: string | null,
): RepairOption | null {
  const [floor] = contractHours(card);
  const lowered = Math.max(0, newFloor);
  if (lowered >= floor) return null;
  const people = staffIn(ctx, card.person);
  const who = people.length <= 3 ? people.join(", ") : `the ${people.length} nurses on it`;
  const name = ruleName(card, card.uid);
  return makeOption("relax_contracted_hours", {
    title: `Lower ${who}'s contracted minimum from ${formatHalfHours(floor)} to ${formatHalfHours(lowered)} ("${name}")`,
    why: proof ?? `"${name}" is a hard contracted minimum that can make the schedule impossible.`,
    operations: [contractEdit(ctx, card, lowered)],
    confirmationQuestion: `Can ${who} work fewer contracted hours this period, with the difference made up later or paid?`,
    needsFromUser: [
      "How the ward makes up the missing contracted hours. The app cannot check that.",
    ],
    capabilityId: "shift-counts",
    evidence: proof ? "static_check" : "hypothesis",
  });
}

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

/**
 * The staff group a short finding needs a borrowed nurse in: the group its skill mix is
 * short of (`mixPeople`), else a counted group its named qualified people list. `undefined`
 * when a short finding counts no counted group at all (the qualification is unknown, so no
 * loan is offered); `null` when it needs no group.
 */
function findingGroup(ctx: Ctx, f: StaffingFinding): string | null | undefined {
  if (!f.skillMix) return null;
  const counted = (ref: string) => ctx.groupIds.has(ref) && countedGroup(ctx, ref);
  if (f.mixPeople && counted(f.mixPeople)) return f.mixPeople;
  for (const uid of f.ruleIds) {
    const card = requirementCard(ctx, uid);
    if (!isNamed(card)) continue;
    const group = asList(card?.qualifiedPeople).map(String).find(counted);
    if (group) return group;
  }
  return undefined;
}

interface SkillGroupNeed {
  group: string;
  /** Short dates the group covers, in roster order. */
  dateIds: string[];
  /** Borrowed nurses it needs: its largest shortfall over those dates. */
  count: number;
}

/**
 * One borrowed nurse per short skill group per date it is short, so a second group's gap
 * does not stay open. `undefined` when a short group's qualification is unknown.
 */
function skillGroupNeeds(ctx: Ctx, dated: StaffingFinding[]): SkillGroupNeed[] | undefined {
  // group -> short date id -> the largest gap a finding there reports for that group.
  const gaps = new Map<string, Map<string, number>>();
  for (const f of dated) {
    if (f.dateId === null) continue;
    const group = findingGroup(ctx, f);
    if (group === undefined) return undefined;
    if (group === null) continue;
    const byDate = gaps.get(group) ?? new Map<string, number>();
    byDate.set(f.dateId, Math.max(byDate.get(f.dateId) ?? 0, f.required - f.available));
    gaps.set(group, byDate);
  }
  const dates = ctx.items.map((i) => i.id);
  return [...gaps].map(([group, byDate]) => {
    const dateIds = dates.filter((id) => byDate.has(id));
    return { group, dateIds, count: Math.max(1, ...dateIds.map((id) => byDate.get(id) ?? 0)) };
  });
}

/** The finding with the largest people gap on a date: its shifts are the date's short shifts. */
function worstOn(dated: StaffingFinding[], dateId: string): StaffingFinding | undefined {
  return [...dated]
    .filter((f) => f.dateId === dateId)
    .sort((a, b) => b.required - b.available - (a.required - a.available))[0];
}

interface CoverSlot {
  dateId: string;
  shiftType: string;
}

/** One nurse a borrow books: the group she joins (null = any) and the slots she fills. */
interface CoverNurse {
  group: string | null;
  slots: CoverSlot[];
}

/**
 * One nurse per short skill group on each date it is short, then one per head-count gap those
 * nurses do not already fill, each with the (date, shift) slots she covers: the group's own
 * short shift, or the date's next short shift (bead nursing-sheduler-efi). `undefined` when a
 * short group's qualification is unknown.
 */
function coverNurses(
  ctx: Ctx,
  dated: StaffingFinding[],
  short: string[],
): CoverNurse[] | undefined {
  const needs = skillGroupNeeds(ctx, dated);
  if (needs === undefined) return undefined;
  const shiftOn = (dateId: string, slot: number) => {
    const shifts = [...new Set(worstOn(dated, dateId)?.shiftTypes ?? [])];
    return shifts.length ? shifts[slot % shifts.length] : null;
  };
  const groupShift = (dateId: string, group: string) =>
    dated.find((f) => f.dateId === dateId && findingGroup(ctx, f) === group)?.shiftTypes[0];
  const nurses: CoverNurse[] = [];
  for (const need of needs)
    for (let n = 0; n < need.count; n++)
      nurses.push({
        group: need.group,
        slots: need.dateIds.flatMap((dateId) => {
          const shiftType = groupShift(dateId, need.group);
          return shiftType === undefined ? [] : [{ dateId, shiftType }];
        }),
      });
  const covered = new Map<string, number>();
  for (const need of needs)
    for (const id of need.dateIds) covered.set(id, (covered.get(id) ?? 0) + need.count);
  const spare = (id: string) => Math.max(0, gapOn(dated, id) - (covered.get(id) ?? 0));
  const spareCount = Math.max(0, ...short.map(spare));
  for (let n = 0; n < spareCount; n++)
    nurses.push({
      group: null,
      slots: short.flatMap((dateId) => {
        if (spare(dateId) <= n) return [];
        const shiftType = shiftOn(dateId, n);
        return shiftType === null ? [] : [{ dateId, shiftType }];
      }),
    });
  return nurses.filter((nurse) => nurse.slots.length > 0);
}

const borrowTemporaryNurse: Builder = (ctx, all) => {
  const findings = gapsOnly(all);
  const dated = findings.filter((f) => f.dateId !== null);
  // A cap_short is a period-level ceiling on people, which no (date, shift) cover lowers.
  if (ctx.items.length === 0 || dated.length === 0) return null;
  const ids = ctx.items.map((i) => i.id);
  const short = shortDates(ctx, dated);
  const gap = Math.max(...dated.map((f) => f.required - f.available));
  const nurses = coverNurses(ctx, dated, short);
  if (nurses === undefined || nurses.length < 1 || nurses.length > MAX_BORROWED) return null;

  // Each cover is a staffing credit on one date and one shift (d582). She takes no roster
  // cell, inherits no ward rule and needs no pin, so nothing else about the ward changes.
  const operations = nurses.flatMap((nurse, index) =>
    nurse.slots.map(
      ({ dateId, shiftType }): AssistantCommandV1 => ({
        type: "add_temporary_cover",
        name: `Borrowed nurse ${index + 1} (another ward)`,
        date: isoOf(ctx, dateId) ?? dateId,
        shiftType,
        groups: nurse.group ? [nurse.group] : [],
      }),
    ),
  );
  if (operations.length > MAX_ASSISTANT_OPERATIONS) return null;

  const loanIds = ids.filter((id) => nurses.some((n) => n.slots.some((s) => s.dateId === id)));
  const labels = (loanIds.length ? loanIds : ids).map((id) => dateLabel(ctx, id));
  const when =
    labels.length === 1
      ? labels[0]
      : labels.length <= 3
        ? `${labels.slice(0, -1).join("; ")} and ${labels[labels.length - 1]}`
        : `${labels.length} days from ${labels[0]} to ${labels[labels.length - 1]}`;
  const who = nurses.length === 1 ? "a nurse" : `${nurses.length} nurses`;
  const groups = [...new Set(nurses.flatMap((n) => (n.group === null ? [] : [n.group])))];
  const skill = groups.length ? `, qualified as ${groups.join(" and ")}` : "";
  return makeOption("borrow_temporary_nurse", {
    title: `Borrow ${who}${skill} from the float pool, an agency or another ward for ${when}`,
    why: `${dated.length === 1 ? "That day is" : "Those days are"} short by up to ${gap} ${gap === 1 ? "nurse" : "nurses"} even with everyone free working.`,
    operations,
    // A cover needs no roster cell and no rule change, so the lending ward is the
    // manager's own word in chat, and the covers are the whole change.
    enforcedBy: "chat",
    confirmationQuestion: `Has the lending ward or agency confirmed ${nurses.length === 1 ? "the nurse" : "the nurses"} for ${when}${skill}?`,
    needsFromUser: [
      "Which ward, float pool or agency can lend her, and the name to show on the roster (or keep the placeholder).",
      ...(groups.length
        ? [`That the borrowed nurse is qualified as ${groups.join(" and ")}.`]
        : []),
    ],
    capabilityId: "staff-list",
    evidence: "static_check",
  });
};

/** bead 2vtv: a chronic head-count shortage is a staffing problem, so offer a real staff member. */
const addStaffMember: Builder = (ctx, all) => {
  const dated = gapsOnly(all).filter((f) => f.dateId !== null);
  if (ctx.items.length === 0 || dated.length === 0) return null;
  // A skill-mix gap needs a qualified nurse; that is the manager's word, and the borrow
  // option already asks for it.
  if (dated.some((f) => f.skillMix)) return null;
  const short = shortDates(ctx, dated);
  const count = Math.max(...short.map((id) => gapOn(dated, id)));
  if (count < 1 || count > MAX_NEW_STAFF) return null;
  const who = count === 1 ? "a nurse" : `${count} nurses`;
  // A kept placeholder is a real staff id now, and the floor refuses a name already taken.
  const names: string[] = [];
  for (let n = 1; names.length < count; n++) {
    const name = `New nurse ${n}`;
    if (!ctx.staffIds.has(name) && !ctx.groupIds.has(name)) names.push(name);
  }
  return makeOption("add_staff_member", {
    title: `Add ${who} to the staff list for the whole period (a new starter, a transfer or a relief nurse)`,
    why: `${short.length} days are short by up to ${count} ${count === 1 ? "nurse" : "nurses"} even with everyone free working. A nurse on the staff list can be rostered on any of them.`,
    operations: names.map((name): AssistantCommandV1 => ({ type: "add_person", name, groups: [] })),
    confirmationQuestion:
      count === 1
        ? "Is a new nurse joining the ward's staff for this roster period?"
        : `Are ${count} new nurses joining the ward's staff for this roster period?`,
    needsFromUser: [
      "Her name as the roster should show it (or keep the placeholder until you know it).",
      "Which staff groups she is in, if a rule counts that group. Leave her in none if unsure.",
    ],
    capabilityId: "staff-list",
    evidence: "static_check",
  });
};

// --- Leave (bead msnp) ------------------------------------------------------
//
// A nurse's leave is an agreement with her, so a leave repair is the last resort: move a
// leave day to a nearby date the roster can spare, else give up one leave day. Each day is
// one operation the host asks her about on the Preview (assumptions.ts). The static check
// says which leave is a gap; after a failed run with no static cause, the solver's proven
// core names the leave days instead (explanation.ts), so the app never guesses at one.

/**
 * Leave no repair may touch. A leave cell records no kind, so its own label is the only
 * record that it is sick or compassionate leave.
 * ponytail: a label match; a structured leave kind would replace it.
 */
const PROTECTED_LEAVE = /sick|compassion|bereave|medical|hospital|\bmc\b/i;

const isProtected = (c: UiRequestCell) => PROTECTED_LEAVE.test(c.description ?? "");

/**
 * Her own leave cell on that date (a group's leave is not hers to give), unless ANY of her
 * leave there is protected: a leave operation clears or moves the whole coordinate.
 */
const askableLeave = (state: ScenarioUiState, person: string, dateId: string) => {
  const hers = state.reqData.filter(
    (c) =>
      c.kind === "leave" &&
      String(c.person) === person &&
      toDateId(c.date, { start: state.rangeStart, end: state.rangeEnd }) === dateId,
  );
  return hers.some(isProtected) ? undefined : hers[0];
};

/**
 * `op` touches her own unprotected leave and no one else's, judged by what it does: every
 * leave cell it changes or removes, through the operation's own selector (operations.ts).
 */
function asksOwnLeave(state: ScenarioUiState, person: string, op: AssistantCommandV1): boolean {
  const applied = applyAssistantCommands(state, [op]);
  if (!applied.ok) return false;
  const kept = new Set(applied.next.reqData.map(stableStringify));
  const touched = state.reqData.filter((c) => c.kind === "leave" && !kept.has(stableStringify(c)));
  return touched.length > 0 && touched.every((c) => String(c.person) === person && !isProtected(c));
}

/** A nurse's leave day a repair may ask about, and the shifts she would cover. */
interface LeaveDay {
  person: string;
  dateId: string;
  shifts: string[];
}

/** Per short date in roster order: its gap, and the nurses away on leave in every finding there. */
function provenLeaveDays(ctx: Ctx, findings: StaffingFinding[]) {
  return shortDates(ctx, findings).map((dateId) => {
    const sameDay = findings.filter((f) => f.dateId === dateId);
    const shifts = worstOn(sameDay, dateId)?.shiftTypes ?? [];
    const onLeave = (f: StaffingFinding, person: string) =>
      f.away.some((a) => a.person === person && a.reason === "leave");
    const people = [...new Set(sameDay[0].away.map((a) => a.person))].filter(
      (person) =>
        sameDay.every((f) => onLeave(f, person)) && askableLeave(ctx.state, person, dateId),
    );
    return {
      dateId,
      gap: gapOn(findings, dateId),
      days: people.map((person): LeaveDay => ({ person, dateId, shifts })),
    };
  });
}

/** The leave days in the solver's proven core, by date: each one is part of the clash. */
function coreLeaveDays(ctx: Ctx) {
  const byDate = new Map<string, LeaveDay[]>();
  for (const m of ctx.core ?? []) {
    const dateId = ctx.items.find((i) => i.iso === m.date)?.id;
    if (m.kind !== "leave" || !m.nurse || !dateId) continue;
    if (!askableLeave(ctx.state, m.nurse, dateId)) continue;
    const shifts = [
      ...new Set(
        (ctx.core ?? []).flatMap((s) =>
          s.kind === "staffing" && s.date === m.date ? (s.shift ?? []) : [],
        ),
      ),
    ];
    byDate.set(dateId, [...(byDate.get(dateId) ?? []), { person: m.nurse, dateId, shifts }]);
  }
  return ctx.items.flatMap((i) => {
    const days = byDate.get(i.id);
    return days ? [{ dateId: i.id, gap: 1, days }] : [];
  });
}

/** Short date ids the static check finds in `state`. */
const shortIn = (state: ScenarioUiState) =>
  new Set(gapsOnly(findStaffingShortfalls(state)).flatMap((f) => (f.dateId ? [f.dateId] : [])));

/**
 * `state` with every nurse's availability on `dateId` resolved as the solver resolves it,
 * written as hard "never" requests the static check reads: a nurse with a hard shift pin
 * works only that shift, and a shift her hard rest rules forbid next to her pinned days
 * is out. The static check reads neither (shortfalls.ts).
 * ponytail: pins and rest from her own fixed days only; a rest clash with a shift the
 * solver chooses stays unseen, so a moved leave day is still a guess to test.
 */
function withResolvedAvailability(state: ScenarioUiState, dateId: string): ScenarioUiState {
  const range = { start: state.rangeStart, end: state.rangeEnd };
  const worked = state.shifts.map((s) => String(s.id));
  const out: UiRequestCell[] = [];
  for (const { id } of state.staff) {
    const person = String(id);
    const pins = state.reqData.flatMap((c) =>
      c.kind === "request" &&
      c.weight === Infinity &&
      String(c.person) === person &&
      toDateId(c.date, range) === dateId
        ? [String(c.shiftType)]
        : [],
    );
    const pinned = pins.length ? expandShiftTypeRefs(pins, state) : null;
    for (const shift of worked) {
      if (pinned ? pinned.has(shift) : !restForbids(state, person, dateId, [shift])) continue;
      out.push({
        uid: `resolved-${person}-${dateId}-${shift}`,
        kind: "request",
        person: id,
        date: dateId,
        shiftType: shift,
        weight: -Infinity,
      });
    }
  }
  return { ...state, reqData: [...state.reqData, ...out] };
}

/** The most half-hours her free and leave days can give her contract (relaxContractedHours' proof). */
function mostContracted(state: ScenarioUiState, person: string, c: NurseContract): number {
  const days = generateDateItems({
    start: state.rangeStart,
    end: state.rangeEnd,
  }).length;
  const away = awayDays(state, person);
  return (days - away.leave - away.off) * Math.max(...c.workCoefs) + away.leave * c.leaveCoef;
}

/** The change leaves her contracted minimum no harder to reach than it was. */
function keepsContract(before: ScenarioUiState, after: ScenarioUiState, person: string): boolean {
  const c = contractOf(before, person);
  if (!c) return true;
  return mostContracted(after, person, c) >= Math.min(c.floor, mostContracted(before, person, c));
}

/**
 * Working any of `shifts` on `dateId` would complete one of her hard forbidden rest
 * patterns with the days her own pins fix (leave, a hard day off, a hard shift request).
 * ponytail: ignores a rule's date scope; the solver still holds every rest rule.
 */
function restForbids(state: ScenarioUiState, person: string, dateId: string, shifts: string[]) {
  const range = { start: state.rangeStart, end: state.rangeEnd };
  const items = generateDateItems(range);
  const at = items.findIndex((i) => i.id === dateId);
  const worked = new Set(state.shifts.map((s) => String(s.id)));
  const fixed = (index: number): string | null => {
    const item = items[index];
    const cell =
      item &&
      state.reqData.find(
        (c) =>
          String(c.person) === person &&
          toDateId(c.date, range) === item.id &&
          (c.kind === "leave" || c.weight === Infinity),
      );
    if (!cell) return null;
    return cell.kind === "leave" ? "LEAVE" : cell.kind === "off" ? "OFF" : String(cell.shiftType);
  };
  const matches = (element: unknown, id: string) => {
    const refs = flattenShiftTypeRefs(element as SuccessionCard["pattern"]).map(String);
    return (
      refs.includes(id) ||
      (worked.has(id) && (refs.some(isAll) || expandShiftTypeRefs(refs, state).has(id)))
    );
  };
  const rules = state.cardsByKind.successions.filter(
    (c) => !c.disabled && c.weight === -Infinity && expandPersonRefs(c.person, state).has(person),
  );
  // No short shift named (a core leave day with no staffing member): any worked shift.
  return (shifts.length > 0 ? shifts : [...worked]).every((shift) =>
    rules.some((rule) => {
      const pattern = asList(rule.pattern);
      return pattern.some(
        (element, i) =>
          matches(element, shift) &&
          pattern.every((other, j) => {
            if (j === i) return true;
            const id = fixed(at - i + j);
            return id !== null && matches(other, id);
          }),
      );
    }),
  );
}

interface LeavePick {
  day: LeaveDay;
  op: AssistantCommandV1;
  /** move_leave: the date id her leave moves to. */
  to: string | null;
}

/** One leave day's operation on `state`, or null when it would break her rest or contract. */
type LeaveStep = (
  ctx: Ctx,
  state: ScenarioUiState,
  day: LeaveDay,
  /** Dates a moved leave day may not land on. */
  avoid: Set<string>,
) => LeavePick | null;

/** Her rest rules and contract still hold once she is free to work that day. */
const stillFits = (before: ScenarioUiState, after: ScenarioUiState, day: LeaveDay) =>
  !restForbids(after, day.person, day.dateId, day.shifts) &&
  keepsContract(before, after, day.person);

const cancelStep: LeaveStep = (ctx, state, day) => {
  const iso = isoOf(ctx, day.dateId);
  if (!iso) return null;
  const op: AssistantCommandV1 = {
    type: "clear_requests",
    personId: personRef(ctx, day.person),
    startDate: iso,
    endDate: iso,
  };
  if (!asksOwnLeave(state, day.person, op)) return null;
  const applied = applyAssistantCommands(state, [op]);
  return applied.ok && stillFits(state, applied.next, day) ? { day, op, to: null } : null;
};

/** Her leave day moved to the nearest date that can spare her (the earlier on a tie). */
const moveStep: LeaveStep = (ctx, state, day, avoid) => {
  const cell = askableLeave(state, day.person, day.dateId);
  // move_leave names the cell by its span id.
  if (!cell || String(cell.date) !== day.dateId) return null;
  const from = ctx.items.findIndex((i) => i.id === day.dateId);
  const hers = new Set(
    state.reqData
      .filter((c) => String(c.person) === day.person)
      .map((c) => toDateId(c.date, range(ctx))),
  );
  const nearest = ctx.items
    .map((item, i) => ({ item, distance: Math.abs(i - from) }))
    // A date she has anything on would lose it; an avoided date has no one to spare.
    .filter(({ distance }) => distance > 0 && distance <= MAX_LEAVE_MOVE_DAYS)
    .filter(({ item }) => !avoid.has(item.id) && !hers.has(item.id))
    .sort((a, b) => a.distance - b.distance);
  for (const { item } of nearest) {
    const op: AssistantCommandV1 = {
      type: "move_leave",
      personId: cell.person,
      fromDate: cell.date,
      toDate: item.id,
    };
    if (!asksOwnLeave(state, day.person, op)) return null;
    const applied = applyAssistantCommands(state, [op]);
    // The new date must stay staffed once the others' pins and hard rest rules are counted.
    if (!applied.ok || shortIn(withResolvedAvailability(applied.next, item.id)).has(item.id))
      continue;
    if (stillFits(state, applied.next, day)) return { day, op, to: item.id };
  }
  return null;
};

/**
 * Proven: one leave operation per nurse per short day, at most MAX_LEAVE_CHANGES, each day
 * kept only when its operations close it. Core: ONE leave day, since a minimal core breaks
 * when any one member goes, moved off every core date; each leaves no new short date.
 */
function planLeave(ctx: Ctx, all: StaffingFinding[], step: LeaveStep) {
  const findings = gapsOnly(all);
  const short = new Set(shortDates(ctx, findings));
  const proven = short.size > 0;
  const groups = proven ? provenLeaveDays(ctx, findings) : coreLeaveDays(ctx);
  // Where a moved day may not land: a short date, or another day of the same clash.
  const avoid = proven ? short : new Set(groups.map((g) => g.dateId));
  let state = ctx.state;
  const picks: LeavePick[] = [];
  const stayShort: string[] = [];
  for (const { dateId, gap, days } of groups) {
    const mine: LeavePick[] = [];
    let next = state;
    for (const day of days) {
      if (mine.length === gap || picks.length + mine.length === MAX_LEAVE_CHANGES) break;
      const pick = step(ctx, next, day, avoid);
      const applied = pick && applyAssistantCommands(next, [pick.op]);
      if (!pick || !applied?.ok) continue;
      next = applied.next;
      mine.push(pick);
    }
    const after = shortIn(next);
    const noNewGap = [...after].every((d) => short.has(d));
    if (mine.length > 0 && noNewGap && !(proven && after.has(dateId))) {
      state = next;
      picks.push(...mine);
    } else if (proven) stayShort.push(dateId);
    if (!proven && picks.length > 0) break;
  }
  return picks.length > 0 ? { picks, stayShort, proven } : null;
}

const joinAnd = (items: string[]) =>
  items.length === 1 ? items[0] : `${items.slice(0, -1).join("; ")} and ${items.at(-1)}`;

/** The why shared by both leave repairs: what proves her leave is the gap, and what stays short. */
function leaveWhy(
  ctx: Ctx,
  plan: NonNullable<ReturnType<typeof planLeave>>,
  findings: StaffingFinding[],
  tail: string,
) {
  const [first] = plan.picks;
  const when = dateLabel(ctx, first.day.dateId);
  const shifts = first.day.shifts.join("/") || "that day";
  const skill = gapsOnly(findings).some((f) => f.dateId === first.day.dateId && f.skillMix)
    ? "is qualified and "
    : "";
  const cause = !plan.proven
    ? `The optimiser proved that ${joinAnd(plan.picks.map((p) => `${p.day.person}'s leave on ${dateLabel(ctx, p.day.dateId)}`))} ${plan.picks.length === 1 ? "is" : "are"} part of the clash that leaves no roster. Test it on a copy before calling it a fix.`
    : plan.picks.length === 1
      ? `${when} is one nurse short for ${shifts}, and ${first.day.person} ${skill}is on leave that day.`
      : "Each of those days is short only because a qualified nurse is on leave.";
  const stays = plan.stayShort.length
    ? ` ${joinAnd(plan.stayShort.map((d) => dateLabel(ctx, d)))} ${plan.stayShort.length === 1 ? "stays" : "stay"} short: no leave there can close it.`
    : "";
  return `${cause}${tail}${stays}`;
}

const LEAVE_KIND_QUESTION =
  "What kind of leave it is. Never ask a nurse on sick or compassionate leave.";

const moveLeave: Builder = (ctx, all) => {
  const plan = planLeave(ctx, all, moveStep);
  if (!plan) return null;
  const moves = plan.picks.map(
    (p) =>
      `${p.day.person} from ${dateLabel(ctx, p.day.dateId)} to ${dateLabel(ctx, p.to as string)}`,
  );
  const [first] = plan.picks;
  const names = [...new Set(plan.picks.map((p) => p.day.person))];
  return makeOption("move_leave", {
    title:
      plan.picks.length === 1
        ? `Ask ${first.day.person} whether they can move their leave from ${dateLabel(ctx, first.day.dateId)} to ${dateLabel(ctx, first.to as string)}, to cover ${first.day.shifts.join("/") || "that day"}`
        : `Ask nurses on leave to move one leave day each: ${joinAnd(moves)}`,
    why: leaveWhy(
      ctx,
      plan,
      all,
      ` The static check finds no gap on the new ${plan.picks.length === 1 ? "date" : "dates"}, counting pinned shifts and hard rest rules, but only a run can prove it. The leave keeps counting toward contracted hours, and no rest rule is relaxed.`,
    ),
    operations: plan.picks.map((p) => p.op),
    confirmationQuestion: `Has ${joinAnd(moves.map((m) => m.replace(/^(\S+) from/, "$1 agreed to move their leave from")))}?`,
    needsFromUser: [
      `${LEAVE_KIND_QUESTION} Never move it either.`,
      `Whether ${joinAnd(names)} ${names.length === 1 ? "has" : "have"} agreed to the new ${plan.picks.length === 1 ? "date" : "dates"}.`,
    ],
    capabilityId: "leave-and-requests",
    // The new date is not proven to stay staffed: a guess to test, even for a proven gap.
    evidence: "hypothesis",
  });
};

const askNurseOnLeave: Builder = (ctx, all) => {
  const plan = planLeave(ctx, all, cancelStep);
  if (!plan) return null;
  const [first] = plan.picks;
  const days = plan.picks.map((p) => `${p.day.person} on ${dateLabel(ctx, p.day.dateId)}`);
  const names = [...new Set(plan.picks.map((p) => p.day.person))];
  return makeOption("ask_nurse_on_leave", {
    title:
      plan.picks.length === 1
        ? `Ask ${first.day.person} whether they can give up their leave on ${dateLabel(ctx, first.day.dateId)} to cover ${first.day.shifts.join("/") || "that day"}`
        : `Ask nurses on leave to give up one leave day each: ${joinAnd(days)}`,
    why: leaveWhy(ctx, plan, all, ""),
    // One day at a time: each day is its own operation and its own question to her.
    operations: plan.picks.map((p) => p.op),
    confirmationQuestion:
      plan.picks.length === 1
        ? `Has ${first.day.person} agreed to give up their leave on ${dateLabel(ctx, first.day.dateId)}?`
        : `Has each nurse agreed to give up that one leave day: ${joinAnd(days)}?`,
    needsFromUser: [
      LEAVE_KIND_QUESTION,
      `Whether ${joinAnd(names)} ${names.length === 1 ? "has" : "have"} agreed.`,
    ],
    capabilityId: "leave-and-requests",
    evidence: plan.proven ? "static_check" : "hypothesis",
  });
};

const runOneShort: Builder = (ctx, all) => {
  const findings = gapsOnly(all);
  /**
   * Running `uid` one short on `dateId` closes that day's gap: the ward's need there and
   * the rule's own number the operation writes, or null. The two part company once a
   * temporary cover has lowered the ward need: the title counts the ward's nurses, while
   * the operation writes the authored count, which the cover credit lowers again.
   */
  const oneShortOn = (
    card: RequirementCard,
    dateId: string,
  ): { need: number; written: number } | null => {
    const iso = isoOf(ctx, dateId);
    const sameDay = findings.filter((g) => g.dateId === dateId);
    if (!iso || gapOn(findings, dateId) !== 1) return null;
    // Not a skill-mix gap: one fewer leaves the group just as short. And the rule must be
    // part of every finding that day, or lowering it leaves the day short.
    if (sameDay.some((g) => g.mixPeople || !g.ruleIds.includes(card.uid))) return null;
    // The ward need, a temporary cover included. One fewer than it supplies must stay at
    // 1 or more and hold the skill mix the shift needs that day.
    const need = cardNeedOn(ctx.state, card, iso).required;
    if (need < 2 || loweredTooFar(ctx, card, need - 1, iso)) return null;
    return { need, written: requiredOn(card, iso) - 1 };
  };
  // Every short date, in roster order: run one short where one fewer on one rule closes it.
  const pairs: { card: RequirementCard; iso: string; n: number; written: number }[] = [];
  const stayShort: string[] = [];
  for (const dateId of shortDates(ctx, findings)) {
    const iso = isoOf(ctx, dateId) as string;
    const uids = [
      ...new Set(findings.filter((f) => f.dateId === dateId).flatMap((f) => f.ruleIds)),
    ];
    const pair = uids.flatMap((uid) => {
      const card = requirementCard(ctx, uid);
      const one = card && isHeadCount(card) ? oneShortOn(card, dateId) : null;
      return card && one ? [{ card, iso, n: one.need, written: one.written }] : [];
    })[0];
    if (pair) pairs.push(pair);
    else stayShort.push(iso);
  }
  // More dates than a bad day is a lower staffing standard, not a one-off safety call.
  if (pairs.length === 0 || pairs.length > CHRONIC_DATE_COUNT) return null;

  const day = (iso: string) => formatShortDate(iso, true);
  const list = (items: string[]) =>
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  // A chronic ward can leave many dates short: cap the "stays short" list so the
  // title and confirmation stay readable, naming only the overflow count past it.
  const STAYS_SHORT_LIST_CAP = 3;
  const listCapped = (items: string[]) =>
    items.length <= STAYS_SHORT_LIST_CAP
      ? list(items)
      : `${items.slice(0, STAYS_SHORT_LIST_CAP).join(", ")} and ${items.length - STAYS_SHORT_LIST_CAP} more`;
  const shiftOf = (card: RequirementCard) => String(flattenShiftTypeRefs(card.shiftType)[0]);
  const shifts = [...new Set(pairs.map((p) => shiftOf(p.card)))];
  const where = shifts
    .map(
      (s) => `${s} on ${list(pairs.filter((p) => shiftOf(p.card) === s).map((p) => day(p.iso)))}`,
    )
    .join("; ");
  const [first] = pairs;
  const one = pairs.length === 1;
  const nurses = (n: number) => `${n} ${n === 1 ? "nurse" : "nurses"}`;
  const stays = stayShort.length
    ? `${listCapped(stayShort.map(day))} ${stayShort.length === 1 ? "stays" : "stay"} short`
    : "";
  // A rule for that one date alone is lowered outright. Otherwise the date gets an exception.
  const alone = ({ card, iso }: (typeof pairs)[number]) => {
    const covered = requirementDateIsos(ctx.state, card);
    return covered.length === 1 && covered[0] === iso && !card.requiredNumPeopleOverrides?.length;
  };
  const others = [...new Set(pairs.map((p) => p.card))].flatMap((card) => {
    const lowered = new Set(pairs.filter((p) => p.card === card).map((p) => p.iso));
    if (requirementDateIsos(ctx.state, card).every((d) => lowered.has(d))) return [];
    const name = ruleName(card, card.uid);
    const exceptions = (card.requiredNumPeopleOverrides ?? []).some(([d]) => !lowered.has(d));
    return [
      exceptions
        ? ` "${name}" keeps its own numbers on its other days.`
        : ` "${name}" stays at ${card.requiredNumPeople} on its other days.`,
    ];
  });
  const title = one
    ? `Run ${where} with ${first.n - 1} instead of ${first.n}`
    : shifts.length === 1
      ? `Run ${where.replace(/ on /, " one short on ")}`
      : `Run one short: ${where}`;
  return makeOption("run_one_short", {
    title: `${title}${stays ? `; ${stays}` : ""} (the manager's safety call)`,
    why:
      (one
        ? `Nobody else is free: ${shiftOf(first.card)} can have at most ${first.n - 1} there${alone(first) ? " as things stand" : ""}.`
        : "Nobody else is free: each of those shifts can have one fewer than it needs.") +
      others.join("") +
      (stays ? ` ${stays}: one fewer cannot close it, so the roster still cannot be solved.` : ""),
    operations: pairs.map((p) =>
      alone(p)
        ? {
            type: "set_staffing_requirement_people",
            ruleId: p.card.uid,
            requiredNumPeople: p.written,
          }
        : {
            type: "set_staffing_requirement_on_date",
            ruleId: p.card.uid,
            date: p.iso,
            requiredNumPeople: p.written,
          },
    ),
    confirmationQuestion: `As the manager${stays ? `, knowing ${stays},` : ""} are you satisfied it is safe to run ${
      one ? `${where} with ${nurses(first.n - 1)}` : `${where} one nurse short`
    }?`,
    needsFromUser: [
      "Whether the manager accepts running the shift one short. Only they can make that safety call.",
    ],
    capabilityId: "staffing-requirements",
    evidence: "static_check",
  });
};

const splitLongShift: Builder = (ctx, all) => {
  for (const f of gapsOnly(all)) {
    for (const id of f.shiftTypes) {
      const shift = ctx.state.shifts.find((s) => String(s.id) === id);
      const minutes = shift
        ? (shift.durationMinutes ??
          paidMinutesFor(shift.startTime, shift.endTime, shift.restMinutes))
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
  relax_contracted_hours: relaxContractedHours,
  align_overlapping_requirements: alignOverlappingRequirements,
  soften_hard_request: softenHardRequest,
  extra_shift_willing_nurse: extraShiftWillingNurse,
  relax_count_rule: relaxCountRule,
  borrow_temporary_nurse: borrowTemporaryNurse,
  add_staff_member: addStaffMember,
  move_leave: moveLeave,
  ask_nurse_on_leave: askNurseOnLeave,
  run_one_short: runOneShort,
  split_long_shift: splitLongShift,
};

/** Repairs that change one named rule or request: they help a proven clash only if it names it. */
const RULE_CHANGES: ReadonlySet<RepairId> = new Set<RepairId>([
  "relax_contracted_hours",
  "align_overlapping_requirements",
  "soften_hard_request",
  "extra_shift_willing_nurse",
  "relax_count_rule",
]);

/** The option changes a rule (by card uid) or a request (by nurse and date) the core names. */
function touchesCore(core: readonly ResolvedCoreMember[], option: RepairOption): boolean {
  const rules = new Set(core.map((m) => m.ruleId));
  return option.operations.some((op) => {
    if ("ruleId" in op) return rules.has(op.ruleId);
    if (op.type !== "set_shift_request" && op.type !== "set_off_request") return false;
    return core.some(
      (m) =>
        m.kind === "request" &&
        m.nurse === String(op.personId) &&
        m.date !== undefined &&
        m.date >= op.startDate &&
        m.date <= op.endDate,
    );
  });
}

export function rankRepairOptions(
  state: ScenarioUiState,
  findings: StaffingFinding[],
  opts: { runInfeasible: boolean; core?: readonly ResolvedCoreMember[] | null },
): RepairOption[] {
  const situation = classifySituation(findings, opts.runInfeasible);
  if (situation === null) return [];
  const ctx = makeCtx(state, opts.core ?? null);
  const options: RepairOption[] = [];
  for (const id of REPAIR_ORDER[situation]) {
    const built = BUILDERS[id](ctx, findings, situation);
    // Coordinator ruling (msnp): relaxing a rule outside a proven core cannot resolve it.
    // Each builder already picks on the core (`onCore`); this is the backstop.
    const offCore =
      built !== null && !!ctx.core?.length && RULE_CHANGES.has(id) && !touchesCore(ctx.core, built);
    if (built && !offCore && isSafeOption(state, built)) options.push(built);
    if (options.length === MAX_OPTIONS) break;
  }
  return options;
}

// --- The safety floor, in code --------------------------------------------

const sameRefs = (a: unknown, b: unknown) =>
  JSON.stringify(asList(a).map(String)) === JSON.stringify(asList(b).map(String));
const sameSet = (a: unknown, b: unknown) =>
  JSON.stringify(asList(a).map(String).sort()) === JSON.stringify(asList(b).map(String).sort());
/**
 * The same date refs, a span id and its ISO date being one, and no refs meaning ALL.
 * Refs, not the dates they cover now: ALL and "every date of this roster" differ next month.
 */
const sameDates = (
  ctx: Ctx,
  a: DateRef | DateRef[] | undefined,
  b: DateRef | DateRef[] | undefined,
) => {
  const refs = (d: typeof a) => (d == null ? ["ALL"] : asList(d).map((r) => formDate(ctx, r)));
  return sameSet(refs(a), refs(b));
};

/** A live rest rule `before` has that `after` deletes, turns off, narrows or makes weaker. */
function weakensRest(before: ScenarioUiState, after: ScenarioUiState): boolean {
  const scope = (c: SuccessionCard) => stableStringify([c.person, c.pattern, c.date ?? null]);
  return before.cardsByKind.successions.some((card) => {
    if (card.disabled) return false;
    const now = after.cardsByKind.successions.find((c) => c.uid === card.uid);
    return (
      !now ||
      !!now.disabled ||
      scope(now) !== scope(card) ||
      Math.sign(now.weight) !== Math.sign(card.weight) ||
      Math.abs(now.weight) < Math.abs(card.weight)
    );
  });
}

/**
 * The SAFETY_FLOOR line these operations break, or null. A DENYLIST, so it can judge
 * any operations, including a candidate the model wrote itself. `leaveAsked`: the
 * host asks the nurse before leave is removed (a prepared Preview always does, through
 * its assumptions; a repair option only when it is a named-nurse host question).
 * `repair`: the operations repair a roster (a ranked option or a tested candidate), not
 * a change the manager asked for. A repair never weakens a rest rule (user decision
 * 2026-09-30: rest rules are safety rules, tier H) and never touches protected leave.
 */
export function violatesSafetyFloor(
  state: ScenarioUiState,
  operations: readonly AssistantCommandV1[],
  opts: { leaveAsked: boolean; repair?: boolean },
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
  const loweredTo = (
    card: RequirementCard | undefined,
    before: number,
    n: number,
    iso?: string,
  ) => {
    if (n < 1) return zero;
    if (!card || n >= before) return null;
    return isNamed(card) || loweredTooFar(ctx, card, n, iso) ? skillMix : null;
  };
  const lowered = (uid: string, n: number) => {
    const card = requirementCard(ctx, uid);
    return loweredTo(card, card?.requiredNumPeople ?? Infinity, n);
  };
  // A repair's operations are judged on the schedule the ones before them leave.
  let current = state;
  for (const op of operations) {
    const applied = opts.repair ? applyAssistantCommands(current, [op]) : null;
    const before = current;
    if (applied?.ok) current = applied.next;
    if (applied?.ok && weakensRest(before, applied.next)) return rest;
    const broken = (() => {
      switch (op.type) {
        case "set_rule_enabled":
          // A rest rule is guidance: the manager may turn it off (it stays, to turn back on).
          return op.enabled || op.ruleKind === "successions"
            ? null
            : offByKind(op.ruleKind, op.ruleId);
        case "remove_rule":
          return offByKind(op.ruleKind, op.ruleId);
        case "edit_shift_sequence_rule": {
          const card = ctx.state.cardsByKind.successions.find((c) => c.uid === op.ruleId);
          // A repair's edit the host refuses is still an attempt on a rest rule.
          if (card && applied && !applied.ok) return rest;
          if (!card || Number.isFinite(card.weight)) return null;
          // Softening is allowed (guidance, not law); people, pattern and dates all stay:
          // narrowing any of them deletes the rule where it no longer reaches.
          const same =
            sameRefs(op.people, card.person) &&
            sameRefs(op.pattern, card.pattern) &&
            sameDates(ctx, op.dates, card.date);
          return same ? null : rest;
        }
        case "set_staffing_requirement_people":
          return lowered(op.ruleId, op.requiredNumPeople);
        case "set_staffing_requirement_on_date": {
          const card = requirementCard(ctx, op.ruleId);
          if (!card) return null;
          // The operation writes the AUTHORED count; the guard's numbers are the ward's
          // own, so the cover credit comes off it: its effect on the ward need.
          const { required, credit } = cardNeedOn(state, card, op.date);
          return loweredTo(card, required, op.requiredNumPeople - credit, op.date);
        }
        case "edit_staffing_requirement": {
          const card = requirementCard(ctx, op.ruleId);
          if (card) {
            const sameScope =
              sameRefs(op.shiftType, card.shiftType) && sameDates(ctx, op.dates, card.date);
            if (
              isSkillMix(card) &&
              !(sameScope && sameRefs(op.qualifiedPeople, card.qualifiedPeople))
            )
              return skillMix;
            // A shift or date it no longer covers is a requirement set to 0 there.
            if (!sameScope) return zero;
          }
          return lowered(op.ruleId, op.requiredNumPeople);
        }
        case "add_staffing_requirement":
          return asList(op.qualifiedPeople).some((r) => !isAll(r)) ? skillMix : null;
        case "set_skill_mix": {
          // Every existing entry stays, with the same people and a minimum no lower.
          const kept = (requirementCard(ctx, op.ruleId)?.skillMix ?? []).every((was) =>
            op.skillMix.some(
              (now) =>
                String(now.people) === String(was.people) && now.minNumPeople >= was.minNumPeople,
            ),
          );
          return kept ? null : skillMix;
        }
        case "remove_people_group":
          // Deleting a group prunes it from every skill mix and qualified list that names it.
          return countedGroup(ctx, op.groupId) ? skillMix : null;
        case "edit_people_group": {
          // A counted group re-writes that requirement when its members change. Renaming its
          // id drops the group the requirement names, the way a delete would.
          const group = ctx.state.staffGroups.find((g) => String(g.id) === op.groupId);
          const keeps = op.newGroupId === op.groupId && sameSet(op.members, group?.members);
          return countedGroup(ctx, op.groupId) && !keeps ? skillMix : null;
        }
        case "edit_count_rule": {
          const card = hardCount(op.ruleId);
          if (!card || typeof card.target !== "number") return null;
          if (op.weight !== weightText(card.weight) || op.expression !== card.expression)
            return limit;
          if (
            !sameSet(op.shiftTypes, card.countShiftTypes) ||
            !sameDates(ctx, op.dates, card.countDates)
          )
            return limit;
          const cap = capOf(String(card.expression), card.target, card.weight);
          if (Number.isFinite(cap) && op.target - card.target > MAX_CAP_RAISE) return limit;
          // A minimum ("x = T" is one too) never goes down.
          const floor = !Number.isFinite(cap) || card.expression === "x = T";
          if (floor && op.target < card.target) return limit;
          // Everyone it bound among the ward's own staff stays bound.
          const after = new Set(staffIn(ctx, op.people));
          return staffIn(ctx, card.person).every((p) => after.has(p)) ? null : limit;
        }
        case "clear_requests":
        case "move_leave":
          if (!opts.leaveAsked) return leave;
          return opts.repair && !asksOwnLeave(before, String(op.personId), op) ? leave : null;
        case "add_person":
          if (!PLACEHOLDER.test(op.name) || ctx.staffIds.has(op.name) || ctx.groupIds.has(op.name))
            return invented;
          // A nurse with hard days off is a loan the Preview asks the lender about.
          return op.groups.length > 0 && !loaned.has(op.name) ? skillGroup : null;
        case "edit_person": {
          if (op.name !== String(op.personId)) return invented;
          // Joining a skill group asserts a qualification. Only a borrow the Preview asks the
          // lender about (add_person with hard days off) may put a nurse in one: keeping a group she is
          // already in is no change, and a nurse added earlier in this change is in none yet.
          const joins = (groupId: string) =>
            countedGroup(ctx, groupId) &&
            !ctx.state.staffGroups.some(
              (group) =>
                String(group.id) === groupId &&
                asList(group.members).map(String).includes(String(op.personId)),
            );
          return op.groups.some(joins) ? skillGroup : null;
        }
        default:
          return null;
      }
    })();
    if (broken !== null) return broken;
  }
  return null;
}

/**
 * The largest skill-mix count on a head count's shift, its own skill mix included: it may
 * not go below it. With `iso`, on that date only; else on any date the card covers.
 */
function skillMixOn(ctx: Ctx, card: RequirementCard, iso?: string): number {
  const shifts = new Set(flattenShiftTypeRefs(card.shiftType).map(String));
  const dates = iso ? [iso] : requirementDateIsos(ctx.state, card);
  return Math.max(
    0,
    ...ctx.state.cardsByKind.requirements
      .filter(
        (c) =>
          !c.disabled &&
          isSkillMix(c) &&
          flattenShiftTypeRefs(c.shiftType).some((s) => shifts.has(String(s))),
      )
      .flatMap((c) => {
        const covered = new Set(requirementDateIsos(ctx.state, c));
        return dates
          .filter((d) => covered.has(d))
          .map((d) =>
            Math.max(isNamed(c) ? cardNeedOn(ctx.state, c, d).required : 0, skillMixFloor(c)),
          );
      }),
  );
}

/**
 * A head count at `n` (on `iso`, or every date) would break a skill mix: below one that
 * holds on its shift, or too few for its own groups that share no one (the ceiling is the
 * preferred count when it has one, as the proposal arms check it).
 */
const loweredTooFar = (ctx: Ctx, card: RequirementCard, n: number, iso?: string) =>
  n < skillMixOn(ctx, card, iso) ||
  skillMixOverflow(ctx.state, card.skillMix, card.preferredNumPeople ?? n) !== null;

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
  if (
    violatesSafetyFloor(state, option.operations, { leaveAsked: nurseAsked, repair: true }) !== null
  )
    return false;
  if (option.operations.filter((op) => op.type === "add_person").length > MAX_BORROWED)
    return false;
  return option.operations.every((op) => {
    switch (op.type) {
      case "set_staffing_requirement_people": {
        // Raise any plain head count; lower one only by 1 (the floor keeps it at 1 or
        // more), and only when it targets a single date. The operation writes the AUTHORED
        // count, so the cover credit comes off before it meets the ward need.
        const card = requirementCard(ctx, op.ruleId);
        if (!card || !isHeadCount(card) || !Number.isInteger(op.requiredNumPeople)) return false;
        const [iso] = requirementDateIsos(state, card);
        if (iso === undefined) return op.requiredNumPeople > card.requiredNumPeople;
        const need = cardNeedOn(state, card, iso);
        const after = op.requiredNumPeople - need.credit;
        if (after > need.required) return true;
        return after === need.required - 1 && requirementDateIds(state, card).length === 1;
      }
      case "set_staffing_requirement_on_date": {
        // Lower one covered date of a plain head count by exactly 1 (the floor keeps it at 1 or more).
        const card = requirementCard(ctx, op.ruleId);
        if (!card || !isHeadCount(card) || !Number.isInteger(op.requiredNumPeople)) return false;
        if (!requirementDateIsos(state, card).includes(op.date)) return false;
        // As above, in the ward's numbers: the written count less the cover credit is one
        // below the need. Without a cover this is `requiredOn(card, op.date) - 1`.
        const need = cardNeedOn(state, card, op.date);
        return op.requiredNumPeople - need.credit === need.required - 1;
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
      case "edit_contracted_hours": {
        // Lower the minimum only: who, when, the maximum and each shift's hours stay.
        const card = countCard(ctx, op.ruleId);
        if (!card || card.disabled || !isContractedHoursCard(card)) return false;
        const [floor, ceiling] = contractHours(card);
        const keep = (o: typeof op) =>
          JSON.stringify([o.description, o.people, o.dates, o.maxHours, o.hoursPerShift]);
        return (
          keep(op) === keep(contractEdit(ctx, card, floor)) &&
          op.maxHours * 2 === ceiling &&
          op.minHours >= 0 &&
          op.minHours * 2 < floor
        );
      }
      case "set_shift_request":
        // Soften a real nurse's request, or pin a nurse this loan adds to a shift.
        return typeof op.weight === "number"
          ? Number.isFinite(op.weight) &&
              (real(op.personId) || ctx.groupIds.has(String(op.personId)))
          : op.weight === "must" && loan && added.has(String(op.personId));
      case "set_off_request":
        // Pin off a nurse this loan adds, or soften a real nurse's own hard days off on
        // every date of the range. Anything else could paint over someone's leave.
        if (op.weight === "must") return loan && added.has(String(op.personId));
        if (typeof op.weight !== "number" || !Number.isFinite(op.weight) || op.weight <= 0)
          return false;
        {
          const offs = new Set(
            ctx.state.reqData
              .filter(
                (c) =>
                  c.kind === "off" &&
                  c.weight === Infinity &&
                  String(c.person) === String(op.personId),
              )
              .map((c) => isoOf(ctx, toDateId(c.date, range(ctx)))),
          );
          const span = ctx.items.filter((i) => i.iso >= op.startDate && i.iso <= op.endDate);
          return (
            offs.has(op.startDate) && offs.has(op.endDate) && span.every((i) => offs.has(i.iso))
          );
        }
      case "clear_requests":
        // One leave day at a time, and never sick or compassionate leave (msnp): the
        // floor above judged every leave cell the operation touches.
        return nurseAsked && real(op.personId) && op.startDate === op.endDate;
      case "move_leave":
        return nurseAsked && real(op.personId);
      case "add_person":
        // bead 2vtv: a new staff member joins no group; the manager names one in chat.
        if (option.repairId === "add_staff_member") return op.groups.length === 0;
        // A placeholder (the floor), in real groups, and a skill group only with a host question.
        return (
          loan &&
          op.groups.every((g) => ctx.groupIds.has(g)) &&
          (op.groups.length === 0 || option.enforcedBy === "host_question")
        );
      case "add_temporary_cover": {
        // A cover is a staffing credit, not a person: in period, a worked shift, known
        // groups, and a card she counts in, which is exactly what `coverStatuses` flags.
        const [status] = coverStatuses({ ...state, temporaryCover: [op] });
        return status.flag === null;
      }
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
      const inner =
        names.join(", ") || `the skill mix of "${outer}" (${f.mixPeople}, who share no one)`;
      return `${label}, ${shifts}: ${inner} need ${f.required} in total, but "${outer}" allows at most ${f.available}.`;
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

/** `core`: the solver's proven core of the failed run, when it has one. */
export function buildFeasibilityReport(
  state: ScenarioUiState,
  afterInfeasibleRun: boolean,
  core: readonly ResolvedCoreMember[] | null = null,
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
    options: rankRepairOptions(state, findings, {
      runInfeasible: afterInfeasibleRun,
      core: afterInfeasibleRun ? core : null,
    }),
    safetyFloor: SAFETY_FLOOR,
    instructions: FEASIBILITY_INSTRUCTIONS,
  };
}
