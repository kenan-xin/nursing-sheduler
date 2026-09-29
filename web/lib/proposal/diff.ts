// The HOST-DERIVED before/after diff and cascade (T07).
//
// A Preview is a change set, not model prose. Everything it states is computed
// HERE, by comparing the document the commands were validated against with the
// document they produce -- so a Preview cannot describe a consequence the operation
// does not have, and cannot omit one it does.
//
// DIRECT vs CASCADE is the distinction the setup flow turns on. A direct entry is
// something the user asked for; a cascade entry is something the app will do as a
// result -- a request destroyed because its date left the roster period, a rule
// rewritten because an id was re-keyed. The flow requires the second set to be shown
// atomically with the first, and requires later setup domains it touches to be
// marked NEEDS REVIEW after Apply. Both fall out of the same structural comparison.
//
// WHY A STRUCTURAL DIFF RATHER THAN PER-ARM DESCRIPTIONS. A per-arm description
// states what its author believed the arm does. The range cascade alone reaches date
// groups, every preference card, the request matrix and the export layout, through
// two different mechanisms (purge and re-key). Comparing documents cannot forget a
// surface, and it keeps working when an arm's transform is improved underneath it.

import type {
  AffinityCard,
  CardsByKind,
  ContractedHoursCountCard,
  CountCard,
  CoveringCard,
  RequirementCard,
  ScenarioUiState,
  SuccessionCard,
  UiRequestCell,
  UiShiftType,
  UiTemporaryCover,
} from "@/lib/scenario";
import {
  describeCountStrength,
  EXPRESSION_OPS,
  substituteTarget,
} from "@/components/card-editor/expression-model";
import {
  AFFINITY_SAME_SHIFT,
  isEditableAffinityCard,
} from "@/components/affinities/affinities-model";
import {
  COVERING_SAME_SHIFT,
  isEditableCoveringCard,
} from "@/components/coverings/coverings-model";
import { isContractedHoursCard } from "@/components/counts/counts-model";
import { formatHalfHours } from "@/components/counts/half-hour-codec";
import { groupLeaveReach, leaveReachText } from "@/components/requests/requests-model";
import { calendarSpan } from "./assumptions";
import { generateDateItems } from "@/lib/dates";
import { formatShortDate } from "@/lib/dates/date-id";
import { cardNeedOn, coverStatuses } from "@/lib/scenario/temporary-cover";
import { requiredOn } from "@/lib/rules/shortfalls";
import {
  MAX_WORKED_IN_7,
  REST_DAYS_RULE_DESCRIPTION,
  REST_DAYS_WEIGHT,
  isRestDaysRuleCard,
} from "@/lib/rules/rest-days";
import type { AssistantCommandV1 } from "./commands";
import { stableStringify } from "./digest";
import { rosterDatesBetween } from "./operations";

/**
 * Where a change lands, named as the capability the user would go to see it.
 *
 * These are capability-registry ids (except `export-layout`, whose route is
 * deferred), so "which screens does this affect?" needs no second mapping table and
 * cannot drift from the deployed registry -- `diff.test.ts` pins that.
 */
export type DiffScope =
  | "roster-period"
  | "staff-list"
  | "shift-types"
  | "staffing-requirements"
  | "shift-successions"
  | "shift-counts"
  | "shift-affinities"
  | "shift-type-coverings"
  | "leave-and-requests"
  | "export-layout";

/** The one scope with no capability entry: the Export Layout route is deferred. */
const SCOPE_WITHOUT_CAPABILITY: DiffScope = "export-layout";

/** The progressive setup domains, in dependency order (guided-setup flow). */
export const SETUP_DOMAINS = ["dates", "people", "shifts", "rules", "requests"] as const;
export type SetupDomain = (typeof SETUP_DOMAINS)[number];

const SCOPE_DOMAIN: Record<DiffScope, SetupDomain> = {
  "roster-period": "dates",
  "staff-list": "people",
  "shift-types": "shifts",
  "staffing-requirements": "rules",
  "shift-successions": "rules",
  "shift-counts": "rules",
  "shift-affinities": "rules",
  "shift-type-coverings": "rules",
  "leave-and-requests": "requests",
  "export-layout": "requests",
};

const RULE_SCOPE: Record<keyof CardsByKind, DiffScope> = {
  requirements: "staffing-requirements",
  successions: "shift-successions",
  counts: "shift-counts",
  affinities: "shift-affinities",
  coverings: "shift-type-coverings",
};

export type DiffChangeKind = "changed" | "created" | "removed";

export interface ProposalDiffEntry {
  /** Stable identity of the changed thing. De-dups, and pins assertions. */
  key: string;
  scope: DiffScope;
  /** What changed, in the user's words. */
  label: string;
  /** Rendered values; `null` where the thing did not exist on that side. */
  before: string | null;
  after: string | null;
  kind: DiffChangeKind;
}

export interface ProposalDiff {
  /** What the user asked for. */
  direct: ProposalDiffEntry[];
  /** What the app will do as a consequence. Shown with the direct set, never after it. */
  cascade: ProposalDiffEntry[];
  /** Every capability (screen) the change reaches. */
  capabilityIds: string[];
  /** Setup domains a cascade invalidated — "Needs review" after Apply. */
  needsReview: SetupDomain[];
}

// ---------------------------------------------------------------------------
// Rendering helpers -- deliberately plain, because a ward manager reads them
// ---------------------------------------------------------------------------

/** A request cell as a ward manager says it. */
function describeCell(cell: UiRequestCell): string {
  if (cell.kind === "leave") return "On leave";
  const [must, never, wants, avoids] =
    cell.kind === "off"
      ? [
          "Must have the day off",
          "Must not have the day off",
          "Wants the day off",
          "Would rather not be off",
        ]
      : [
          `Must work ${cell.shiftType}`,
          `Must not work ${cell.shiftType}`,
          `Wants ${cell.shiftType}`,
          `Would rather not work ${cell.shiftType}`,
        ];
  if (cell.weight === Infinity) return must;
  if (cell.weight === -Infinity) return never;
  if (cell.weight === 0 && cell.kind === "off") return "Asked for the day off";
  return cell.weight < 0 ? `${avoids} (weight ${cell.weight})` : `${wants} (weight ${cell.weight})`;
}

function describeCoordinateCells(cells: readonly UiRequestCell[]): string | null {
  if (cells.length === 0) return null;
  return cells.map(describeCell).sort().join(", ");
}

/** "690" minutes -> "11h 30m"; a whole number of hours drops the minutes. */
function renderPaidMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/**
 * A shift as a ward manager reads it: name, then clock times, overnight made
 * explicit. `restMinutes` changes the stored (and model-filled) paid duration, so a
 * shift with a break also states the break and, when the paid minutes are already at
 * hand, what they come to -- the user must see it before Apply, not discover it later.
 */
function renderShift(shift: UiShiftType): string {
  const name = shift.description?.trim() || `${shift.id}`;
  if (!shift.startTime || !shift.endTime) return name;
  // Grid-valid "HH:MM" strings compare correctly as text.
  const overnight = shift.endTime < shift.startTime ? " (ends next day)" : "";
  const clocks = `${name} · ${shift.startTime}–${shift.endTime}${overnight}`;
  if (!shift.restMinutes) return clocks;
  const paid =
    shift.durationMinutes != null ? ` (${renderPaidMinutes(shift.durationMinutes)} paid)` : "";
  return `${clocks} · ${shift.restMinutes} min break${paid}`;
}

function ruleTitle(card: { description?: string; uid: string }, kind: keyof CardsByKind): string {
  const described = card.description?.trim();
  return described || `${RULE_SCOPE[kind].replace(/-/g, " ")} ${card.uid.slice(0, 8)}`;
}

const DATE_SCOPE_WORDS: Record<string, string> = {
  ALL: "every date",
  WEEKDAY: "weekdays",
  WEEKEND: "weekends",
  MONDAY: "Mondays",
  TUESDAY: "Tuesdays",
  WEDNESDAY: "Wednesdays",
  THURSDAY: "Thursdays",
  FRIDAY: "Fridays",
  SATURDAY: "Saturdays",
  SUNDAY: "Sundays",
};

function flattenRefs(refs: unknown): unknown[] {
  if (refs == null) return [];
  return Array.isArray(refs) ? refs.flatMap(flattenRefs) : [refs];
}

function renderDates(refs: unknown): string {
  const list = flattenRefs(refs);
  if (list.length === 0) return "every date";
  return list.map((ref) => DATE_SCOPE_WORDS[String(ref).toUpperCase()] ?? String(ref)).join(", ");
}

/** `everyone` when the refs are empty or ALL (the backend's null-as-all). */
function renderPeople(refs: unknown, everyone: string): string {
  const list = flattenRefs(refs);
  if (list.length === 0 || list.some((ref) => String(ref).toUpperCase() === "ALL")) return everyone;
  return list.map(String).join(", ");
}

function renderStrength(weight: number): string {
  if (weight === Infinity) return "must always hold";
  if (weight === -Infinity) return "must never happen";
  if (weight > 0) return `encouraged (weight ${weight})`;
  if (weight < 0) return `discouraged (weight ${weight})`;
  return "no effect (weight 0)";
}

/**
 * Restates `shift_type_requirements` in core: no preferred count means EXACTLY n; a
 * preferred count p means n to p, its weight (0 or less) pulling toward p; qualified
 * people bans everyone else from those shifts. Each top-level entry is its own
 * equation, a group or nested list one combined count. A skill mix adds floors for
 * named groups among those people and bans nobody.
 */
function requirementShifts(card: RequirementCard): { labels: string[]; shifts: string } {
  const entries = Array.isArray(card.shiftType) ? card.shiftType : [card.shiftType];
  const labels = entries.map((entry) => flattenRefs(entry).map(String).join(" + "));
  return { labels, shifts: labels.length === 1 ? labels[0] : `each of ${labels.join(", ")}` };
}

function describeRequirement(card: RequirementCard): string {
  const n = card.requiredNumPeople;
  const p = card.preferredNumPeople;
  const { labels, shifts } = requirementShifts(card);
  const dates = renderDates(card.date);
  const except = (card.requiredNumPeopleOverrides ?? [])
    .map(([iso, count]) => `${formatShortDate(iso)}: ${count}`)
    .join(", ");
  const exceptions = except ? `, except ${except}` : "";
  const who = renderPeople(card.qualifiedPeople, "");
  const ban = who ? `; only ${who} may work ${labels.join(", ")}` : "";
  const mix = card.skillMix?.length
    ? `; at least ${card.skillMix.map((e) => `${e.minNumPeople} from “${e.people}”`).join(", ")} — anyone can fill the other places`
    : "";
  if (p == null || p === n) {
    return `Exactly ${n} ${n === 1 ? "person" : "people"} on ${shifts}, ${dates}${exceptions}${ban}${mix}`;
  }
  if (card.weight < 0) {
    return `At least ${n}, ideally ${p} people on ${shifts}, ${dates}${exceptions} (weight ${card.weight})${ban}${mix}`;
  }
  const lean = card.weight > 0 ? `${n} preferred` : "no preference";
  return `${n} to ${p} people on ${shifts}, ${dates}${exceptions} (${lean}, weight ${card.weight})${ban}${mix}`;
}

/** A count as the Preview says it: `2`, or `2 to 3` with a distinct preferred count. */
function renderCount(required: number, preferred: number | null | undefined): string {
  return preferred == null || preferred === required
    ? `${required}`
    : `${required} to ${preferred}`;
}

/** `exactly 2`, or `2 to 3` left as it stands when a distinct preferred count is stated. */
const exactLead = (count: string) => (count.includes(" to ") ? count : `exactly ${count}`);

/** A day's count as the Preview says it: `2`, or `2 to 3` with a distinct preferred count. */
function countOn(card: RequirementCard, iso: string): string {
  return renderCount(requiredOn(card, iso), card.preferredNumPeople);
}

/**
 * An exception-only change, one line per date: "14 Oct: exactly 2 → 1 on N". Any other
 * change returns undefined, so the full sentence shows.
 */
function requirementChange(from: RequirementCard, to: RequirementCard): string | undefined {
  const rest = ({ requiredNumPeopleOverrides: _o, ...card }: RequirementCard) =>
    stableStringify(card);
  if (rest(from) !== rest(to)) return undefined;
  const dates = [
    ...new Set(
      [...(from.requiredNumPeopleOverrides ?? []), ...(to.requiredNumPeopleOverrides ?? [])].map(
        ([iso]) => iso,
      ),
    ),
  ].sort();
  const lines = dates
    .filter((iso) => requiredOn(from, iso) !== requiredOn(to, iso))
    .map((iso) => {
      const was = countOn(from, iso);
      const lead = exactLead(was);
      return `${formatShortDate(iso)}: ${lead} → ${countOn(to, iso)} on ${requirementShifts(to).shifts}`;
    });
  return lines.length > 0 ? lines.join("; ") : undefined;
}

function describeSuccession(card: SuccessionCard): string {
  const positions = Array.isArray(card.pattern) ? card.pattern : [card.pattern];
  const pattern = positions
    .map((position) =>
      Array.isArray(position) ? position.map(String).join(" or ") : String(position),
    )
    .join(" → ");
  return `${pattern} on consecutive days for ${renderPeople(card.person, "everyone")}, ${renderDates(card.date)}: ${renderStrength(card.weight)}`;
}

/** A contracted-hours card (4h5a): the hours, what each shift and leave day counts, a must. */
function describeContract(card: ContractedHoursCountCard): string | null {
  const { target } = card;
  const hours = Array.isArray(target)
    ? `${formatHalfHours(target[0])} to ${formatHalfHours(target[1])}`
    : `exactly ${formatHalfHours(target)}`;
  const credits = (card.countShiftTypeCoefficients ?? [])
    .map(([id, value]) => `${id === "LEAVE" ? "a leave day" : id} ${formatHalfHours(value)}`)
    .join(", ");
  const people = renderPeople(card.person, "");
  return `${people ? `Each of ${people}` : "Everyone"} works ${hours} across ${renderDates(card.countDates)}${credits ? ` (${credits})` : ""}: must hold`;
}

/** `null` for a list-shaped count: no single sentence says it honestly. */
function describeCount(card: CountCard): string | null {
  if (isContractedHoursCard(card)) return describeContract(card);
  if (isRestDaysRuleCard(card) && card.weight === REST_DAYS_WEIGHT) {
    const people = renderPeople(card.person, "");
    return `${people ? `Each of ${people}` : "Every nurse"} gets ${REST_DAYS_RULE_DESCRIPTION} (at most ${MAX_WORKED_IN_7} shifts); strong preference`;
  }
  if (typeof card.expression !== "string" || typeof card.target !== "number") return null;
  const op = EXPRESSION_OPS.find((candidate) => candidate.value === card.expression);
  if (!op) return null;
  const squared = op.value === "|x - T|^2";
  const amount = squared ? `Close to ${card.target}` : substituteTarget(op.title, card.target);
  const shifts = flattenRefs(card.countShiftTypes).map(String).join(" + ");
  const people = renderPeople(card.person, "");
  return `${amount} ${shifts} shifts for ${people ? `each of ${people}` : "everyone"}, across ${renderDates(card.countDates)}: ${describeCountStrength(squared, card.weight, card.target)}`;
}

/** A pairing's strength, per `shift_affinity` in core: the weight is gained on each date both sides work. */
function renderPairingStrength(weight: number): string {
  if (weight === Infinity) return "must work together on every date";
  if (weight === -Infinity) return "never together";
  if (weight > 0) return `together where possible (weight ${weight})`;
  if (weight < 0) return `apart where possible (weight ${weight})`;
  return "no effect (weight 0)";
}

/** `null` for a grouped card: flattening its groups would state a different rule. */
function describePairing(card: AffinityCard): string | null {
  if (!isEditableAffinityCard(card)) return null;
  const shifts = flattenRefs(card.shiftTypes).map(String).join(" or ");
  return `${renderPeople(card.people1, "everyone")} with ${renderPeople(card.people2, "everyone")} ${AFFINITY_SAME_SHIFT} (${shifts}), ${renderDates(card.date)}: ${renderPairingStrength(card.weight)}`;
}

/** Restates `shift_type_covering` in core: a hard implication, so no strength. */
function describeSupervision(card: CoveringCard): string | null {
  if (!isEditableCoveringCard(card)) return null;
  const shifts = flattenRefs(card.shiftTypes).map(String).join(" or ");
  return `Whenever ${renderPeople(card.preceptees, "everyone")} works ${shifts}, at least one of ${renderPeople(card.preceptors, "everyone")} works ${COVERING_SAME_SHIFT}, ${renderDates(card.date)}`;
}

/** The plain sentence for the families the assistant authors; `null` keeps the opaque form. */
function describeRule(kind: keyof CardsByKind, card: Record<string, unknown>): string | null {
  switch (kind) {
    case "requirements":
      return describeRequirement(card as unknown as RequirementCard);
    case "successions":
      return describeSuccession(card as unknown as SuccessionCard);
    case "counts":
      return describeCount(card as unknown as CountCard);
    case "affinities":
      return describePairing(card as unknown as AffinityCard);
    case "coverings":
      return describeSupervision(card as unknown as CoveringCard);
  }
}

/**
 * A rule's rendered body, markers excluded -- `disabled` is reported as on/off instead.
 * The title is part of the body so a rename alone is still a visible change. The
 * sentence omits coefficients; an assistant edit can only change those by changing the
 * counted shifts, which the sentence does show.
 */
function ruleBody(card: Record<string, unknown>, kind: keyof CardsByKind): string {
  const { uid: _uid, disabled, applied: _applied, ...rest } = card;
  const plain = describeRule(kind, card);
  if (plain === null) return `${disabled ? "Off" : "On"} · ${stableStringify(rest)}`;
  const title = typeof card.description === "string" ? card.description.trim() : "";
  return `${disabled ? "Off" : "On"} · ${title ? `“${title}” · ` : ""}${plain}`;
}

function renderStaffGroup(members: readonly string[], description: string | undefined): string {
  const list = members.length ? members.join(", ") : "No members";
  const described = description?.trim();
  return described ? `${list} · “${described}”` : list;
}

function coordinateKey(cell: UiRequestCell): string {
  return `${stableStringify(cell.person)}|${stableStringify(cell.date)}`;
}

// ---------------------------------------------------------------------------
// The structural comparison
// ---------------------------------------------------------------------------

/** A shift type's label, as every other shift line in a Preview names it. */
function shiftNameOf(state: ScenarioUiState, shiftId: string): string {
  return state.shifts.find((shift) => String(shift.id) === shiftId)?.description?.trim() || shiftId;
}

/** A cover's identity, exactly as the Staff row states it as its own change key. */
function coverIdentity(cover: Pick<UiTemporaryCover, "name" | "date" | "shiftType">): string {
  return `${cover.name}|${cover.date}|${String(cover.shiftType)}`;
}

/** A cover as a value in a Preview: "Night, 5 Nov". */
function coverValue(after: ScenarioUiState, cover: UiTemporaryCover): string {
  return `${shiftNameOf(after, String(cover.shiftType))}, ${formatShortDate(cover.date)}`;
}

/**
 * The cover ROWS themselves (d582): "Temporary cover “Haseena (Ward 3)”  Nothing → Night,
 * 5 Nov". A cover is stored apart from the cards, so without these the Preview would state
 * what a cover did to the counts and never that the cover itself was booked or taken
 * away. The key is the one the Staff row carries as its change key, so Apply can outline
 * the row it is about.
 */
function coverRowEntries(before: ScenarioUiState, after: ScenarioUiState): Entry[] {
  const had = new Set(before.temporaryCover.map(coverIdentity));
  const has = new Set(after.temporaryCover.map(coverIdentity));
  const entries: Entry[] = [];
  for (const cover of after.temporaryCover) {
    if (had.has(coverIdentity(cover))) continue;
    entries.push({
      key: `cover:${coverIdentity(cover)}`,
      scope: "staff-list",
      label: `Temporary cover “${cover.name}”`,
      before: null,
      after: coverValue(after, cover),
      kind: "created",
    });
  }
  for (const cover of before.temporaryCover) {
    if (has.has(coverIdentity(cover))) continue;
    entries.push({
      key: `cover:${coverIdentity(cover)}`,
      scope: "staff-list",
      label: `Temporary cover “${cover.name}”`,
      before: coverValue(after, cover),
      after: null,
      kind: "removed",
    });
  }
  return entries;
}

/**
 * What a NEWLY booked cover does not do (F1, F4), said next to the count lines it does
 * draw. The count lines state the arithmetic; these state where it did not happen:
 *
 *   • F1 -- a card restricted to groups she is not in is not lowered by her at all, so
 *     her credit on that date is nothing where a manager may expect it to count.
 *   • F4 -- credit landing on a slot that is already covered is EXTRA: the ward need is
 *     clamped at 0, so the count cannot go below it and the surplus is stated instead.
 *
 * These are CONSEQUENCES, not requests -- nobody asks for a surplus -- so they are
 * cascade entries, and `directKeys` does not name them.
 *
 * ADD SIDE ONLY: taking a cover away restores exactly what the count line already says
 * ("exactly 2 → 3"), so the reverse has nothing it could hide.
 */
function coverWarningEntries(before: ScenarioUiState, after: ScenarioUiState): Entry[] {
  const had = new Set(before.temporaryCover.map(coverIdentity));
  const statuses = new Map(coverStatuses(after).map((status) => [status.index, status]));
  // F4 is a fact about a SLOT, not about one cover: three covers on a two-slot rule are
  // one surplus, whoever booked the last one. So the slots are collected first and the
  // note is stated once, however many new covers reach it.
  const surplus = new Map<string, { cardUid: string; iso: string; shiftId: string }>();
  const entries: Entry[] = [];
  after.temporaryCover.forEach((cover, index) => {
    if (had.has(coverIdentity(cover))) return;
    const status = statuses.get(index);
    if (status === undefined) return;
    const { name } = cover;
    const shiftId = String(cover.shiftType);
    for (const rule of status.restrictedBy) {
      entries.push({
        key: `cover-note:${coverIdentity(cover)}|restricted|${rule.group}`,
        scope: "staffing-requirements",
        label: `Temporary cover “${name}” does not count for “${rule.label}”`,
        before: null,
        after: `Under ${rule.label}, only ${rule.group} work ${shiftId}. ${name} is not in ${rule.group}.`,
        kind: "created",
      });
    }
    for (const effect of status.effects) {
      surplus.set(`${effect.cardUid}|${effect.iso}|${effect.shiftId}`, effect);
    }
  });
  for (const effect of surplus.values()) {
    const card = after.cardsByKind.requirements.find(
      (candidate) => candidate.uid === effect.cardUid,
    );
    if (card === undefined) continue;
    const need = cardNeedOn(after, card, effect.iso, effect.shiftId);
    if (need.extra === 0) continue;
    entries.push({
      key: `cover-note:extra|${effect.cardUid}|${effect.iso}|${effect.shiftId}`,
      scope: "staffing-requirements",
      label: `${shiftNameOf(after, effect.shiftId)} on ${formatShortDate(effect.iso)}`,
      before: null,
      after: `${need.credit} covers are booked, so ${need.extra} ${
        need.extra === 1 ? "is" : "are"
      } extra.`,
      kind: "created",
    });
  }
  return entries;
}

/**
 * The count lines a temporary cover draws: one per card, date and shift her credit
 * reaches, stating the effective count on each side (d582). `coverStatuses` names exactly
 * those slots -- a cover the ward cannot resolve has no effects, and a card she does not
 * count in is not in the list -- so a cover that lowers nothing draws no line, and her
 * credit `wardNeed`s the count at 0 rather than below it (F4). The cards are untouched by
 * a cover, so nothing else in this diff states the change.
 */
function coverCountEntries(before: ScenarioUiState, after: ScenarioUiState): Entry[] {
  const slots = new Map<string, { cardUid: string; iso: string; shiftId: string }>();
  for (const state of [before, after]) {
    for (const status of coverStatuses(state)) {
      for (const { cardUid, iso, shiftId } of status.effects) {
        slots.set(`${cardUid}|${iso}|${shiftId}`, { cardUid, iso, shiftId });
      }
    }
  }
  const entries: Entry[] = [];
  for (const { cardUid, iso, shiftId } of [...slots.values()].sort(
    (a, b) =>
      a.iso.localeCompare(b.iso) ||
      a.shiftId.localeCompare(b.shiftId) ||
      a.cardUid.localeCompare(b.cardUid),
  )) {
    const from = before.cardsByKind.requirements.find((card) => card.uid === cardUid);
    const to = after.cardsByKind.requirements.find((card) => card.uid === cardUid);
    // A card that is itself added or removed states so on its own line.
    if (!from || !to) continue;
    const counted = (state: ScenarioUiState, card: RequirementCard) => {
      const need = cardNeedOn(state, card, iso, shiftId);
      return renderCount(need.required, need.preferred);
    };
    entries.push({
      key: `cover:${cardUid}|${iso}|${shiftId}`,
      scope: "staffing-requirements",
      label: `${shiftNameOf(after, shiftId)} on ${formatShortDate(iso)}`,
      before: exactLead(counted(before, from)),
      after: `${counted(after, to)} (${ruleTitle(to, "requirements")})`,
      kind: "changed",
    });
  }
  return entries;
}

type Entry = ProposalDiffEntry;

/** The only fields a rule diff reads by name; the rest is compared opaquely. */
interface AnyRuleCard {
  uid: string;
  description?: string;
  disabled?: boolean;
}

function compareKeyed<T>(
  before: readonly T[],
  after: readonly T[],
  options: {
    scope: DiffScope;
    identity: (item: T) => string;
    label: (item: T) => string;
    render: (item: T) => string;
    /** The `after` of a changed item, when the whole new value would bury the change. */
    renderChange?: (from: T, to: T) => string | undefined;
    keyPrefix: string;
  },
): Entry[] {
  const beforeById = new Map(before.map((item) => [options.identity(item), item]));
  const afterById = new Map(after.map((item) => [options.identity(item), item]));
  const entries: Entry[] = [];

  for (const [id, item] of beforeById) {
    const next = afterById.get(id);
    const key = `${options.keyPrefix}:${id}`;
    if (!next) {
      entries.push({
        key,
        scope: options.scope,
        label: options.label(item),
        before: options.render(item),
        after: null,
        kind: "removed",
      });
      continue;
    }
    const from = options.render(item);
    const to = options.render(next);
    if (from !== to) {
      entries.push({
        key,
        scope: options.scope,
        label: options.label(next),
        before: from,
        after: options.renderChange?.(item, next) ?? to,
        kind: "changed",
      });
    }
  }
  for (const [id, item] of afterById) {
    if (beforeById.has(id)) continue;
    entries.push({
      key: `${options.keyPrefix}:${id}`,
      scope: options.scope,
      label: options.label(item),
      before: null,
      after: options.render(item),
      kind: "created",
    });
  }
  return entries;
}

function compareRequestMatrix(before: ScenarioUiState, after: ScenarioUiState): Entry[] {
  const group = (cells: readonly UiRequestCell[]): Map<string, UiRequestCell[]> => {
    const byCoordinate = new Map<string, UiRequestCell[]>();
    for (const cell of cells) {
      const key = coordinateKey(cell);
      const bucket = byCoordinate.get(key);
      if (bucket) bucket.push(cell);
      else byCoordinate.set(key, [cell]);
    }
    return byCoordinate;
  };

  const beforeCells = group(before.reqData);
  const afterCells = group(after.reqData);
  const entries: Entry[] = [];

  for (const key of new Set([...beforeCells.keys(), ...afterCells.keys()])) {
    const from = describeCoordinateCells(beforeCells.get(key) ?? []);
    const to = describeCoordinateCells(afterCells.get(key) ?? []);
    if (from === to) continue;
    const [person, date] = key.split("|");
    entries.push({
      key: `cell:${key}`,
      scope: "leave-and-requests",
      label: `${JSON.parse(person)} on ${JSON.parse(date)}`,
      before: from,
      after: to,
      kind: from === null ? "created" : to === null ? "removed" : "changed",
    });
  }
  return entries;
}

/** Every structural difference between two documents, unclassified. */
export function diffScenarioDocuments(
  before: ScenarioUiState,
  after: ScenarioUiState,
): ProposalDiffEntry[] {
  const entries: Entry[] = [];

  if (before.rangeStart !== after.rangeStart || before.rangeEnd !== after.rangeEnd) {
    const render = (state: ScenarioUiState) =>
      state.rangeStart && state.rangeEnd ? `${state.rangeStart} to ${state.rangeEnd}` : "Not set";
    entries.push({
      key: "dates:range",
      scope: "roster-period",
      label: "Roster period",
      before: render(before),
      after: render(after),
      kind: "changed",
    });
  }

  entries.push(
    ...compareKeyed(before.dateGroups, after.dateGroups, {
      scope: "roster-period",
      keyPrefix: "dategroup",
      identity: (group) => group.id,
      label: (group) => `Date group “${group.id}”`,
      render: (group) => `${group.members.length} date${group.members.length === 1 ? "" : "s"}`,
    }),
    ...compareKeyed(before.staff, after.staff, {
      scope: "staff-list",
      keyPrefix: "person",
      identity: (person) => stableStringify(person.id),
      label: (person) => `${person.id}`,
      render: (person) => person.description?.trim() || `${person.id}`,
    }),
    ...compareKeyed(before.staffGroups, after.staffGroups, {
      scope: "staff-list",
      keyPrefix: "peoplegroup",
      identity: (group) => group.id,
      label: (group) => `Staff group “${group.id}”`,
      render: (group) => renderStaffGroup(group.members.map(String), group.description),
      // A changed group states who joined and who left, not the whole roll call.
      renderChange: (from, to) => {
        const had = new Set(from.members.map((member) => stableStringify(member)));
        const has = new Set(to.members.map((member) => stableStringify(member)));
        const delta = [
          ...to.members.filter((m) => !had.has(stableStringify(m))).map((m) => `+ ${m}`),
          ...from.members.filter((m) => !has.has(stableStringify(m))).map((m) => `− ${m}`),
        ];
        return renderStaffGroup(delta.length ? delta : to.members.map(String), to.description);
      },
    }),
    ...compareKeyed(before.shifts, after.shifts, {
      scope: "shift-types",
      keyPrefix: "shift",
      identity: (shift) => stableStringify(shift.id),
      label: (shift) => `${shift.id}`,
      render: renderShift,
    }),
    ...compareKeyed(before.shiftGroups, after.shiftGroups, {
      scope: "shift-types",
      keyPrefix: "shiftgroup",
      identity: (group) => group.id,
      label: (group) => `Shift group “${group.id}”`,
      render: (group) =>
        group.members.length ? group.members.map(String).join(", ") : "No shifts",
    }),
  );

  for (const kind of Object.keys(RULE_SCOPE) as (keyof CardsByKind)[]) {
    // The five card kinds share no structural type, and they do not need one here:
    // every field beyond `uid`/`description` is compared through the same opaque
    // stable encoding, so widening to the fields the labels actually read is exact
    // rather than lossy.
    const cardsOf = (state: ScenarioUiState): readonly AnyRuleCard[] =>
      state.cardsByKind[kind] as readonly AnyRuleCard[];
    entries.push(
      ...compareKeyed(cardsOf(before), cardsOf(after), {
        scope: RULE_SCOPE[kind],
        keyPrefix: `rule:${kind}`,
        identity: (card) => card.uid,
        label: (card) => ruleTitle(card, kind),
        render: (card) => ruleBody(card as unknown as Record<string, unknown>, kind),
        renderChange:
          kind === "requirements"
            ? (from, to) =>
                requirementChange(
                  from as unknown as RequirementCard,
                  to as unknown as RequirementCard,
                )
            : undefined,
      }),
    );
  }

  entries.push(...coverRowEntries(before, after));

  entries.push(...coverCountEntries(before, after));

  entries.push(...coverWarningEntries(before, after));

  entries.push(...compareRequestMatrix(before, after));

  const exportBefore = stableStringify(before.exportLayout);
  const exportAfter = stableStringify(after.exportLayout);
  if (exportBefore !== exportAfter) {
    const count = (state: ScenarioUiState) =>
      state.exportLayout.formatting.length +
      state.exportLayout.extraColumns.length +
      state.exportLayout.extraRows.length;
    entries.push({
      key: "export:layout",
      scope: "export-layout",
      label: "Export layout rules",
      before: `${count(before)} rule${count(before) === 1 ? "" : "s"}`,
      after: `${count(after)} rule${count(after) === 1 ? "" : "s"}`,
      kind: "changed",
    });
  }

  return entries;
}

type PaintCommand = Extract<
  AssistantCommandV1,
  { type: "add_leave" | "set_off_request" | "set_shift_request" | "clear_requests" }
>;

/** The `cell:` keys a paint command covers, in the document that holds its cells. */
function paintedCellKeys(command: PaintCommand, state: ScenarioUiState): string[] {
  const span = rosterDatesBetween(state, command.startDate, command.endDate);
  if (!span.ok) return [];
  return span.ids.map(
    (date) => `cell:${stableStringify(command.personId)}|${stableStringify(date)}`,
  );
}

/**
 * A rename is ONE change to a ward manager, but the structural comparison sees the old
 * id removed and the new one created. Fold each such pair into one entry.
 */
function mergeRenames(entries: Entry[], commands: readonly AssistantCommandV1[]): Entry[] {
  let merged = entries;
  for (const command of commands) {
    let rename: { from: string; to: string; label: string } | null = null;
    // Same "changed text" rule as the arms in `operations.ts`.
    if (command.type === "edit_person" && command.name !== String(command.personId)) {
      rename = {
        from: `person:${stableStringify(command.personId)}`,
        to: `person:${stableStringify(command.name.trim())}`,
        label: `Renamed “${String(command.personId)}” to “${command.name.trim()}”`,
      };
    } else if (command.type === "edit_people_group" && command.newGroupId !== command.groupId) {
      rename = {
        from: `peoplegroup:${command.groupId}`,
        to: `peoplegroup:${command.newGroupId.trim()}`,
        label: `Renamed staff group “${command.groupId}” to “${command.newGroupId.trim()}”`,
      };
    }
    if (!rename) continue;
    const { from, to, label } = rename;
    const removed = merged.find((entry) => entry.key === from && entry.kind === "removed");
    const created = merged.find((entry) => entry.key === to && entry.kind === "created");
    if (!removed || !created) continue;
    merged = [
      ...merged.filter((entry) => entry !== removed && entry !== created),
      { ...created, label, before: removed.before, kind: "changed" },
    ];
  }
  return merged;
}

/**
 * Twenty-eight "must have the day off" rows would hide the one that matters. Days a
 * must-be-off run CREATES fold into one summary per command; a day that already held
 * something (a leave, a request) stays its own entry, so the Preview never understates
 * what is replaced.
 */
function collapseOffRuns(
  entries: Entry[],
  commands: readonly AssistantCommandV1[],
  after: ScenarioUiState,
): Entry[] {
  let collapsed = entries;
  for (const command of commands) {
    if (command.type !== "set_off_request" || command.weight !== "must") continue;
    const keys = new Set(paintedCellKeys(command, after));
    const created = collapsed.filter((entry) => entry.kind === "created" && keys.has(entry.key));
    if (created.length < 2) continue;
    collapsed = [
      ...collapsed.filter((entry) => !created.includes(entry)),
      {
        key: `offrun:${stableStringify(command.personId)}|${command.startDate}|${command.endDate}`,
        scope: "leave-and-requests",
        label: `${String(command.personId)}: Must have the day off`,
        before: null,
        after: `${created.length} days, ${command.startDate} to ${command.endDate}`,
        kind: "created",
      },
    ];
  }
  return collapsed;
}

/**
 * Leave on a staff-group row pins every member on every date (bb8t). The per-date
 * rows only name the group, so one line states the person-days it reaches; the
 * Preview is the confirmation, so it must say so before Apply.
 */
function groupLeaveLines(commands: readonly AssistantCommandV1[], after: ScenarioUiState): Entry[] {
  return commands.flatMap((command): Entry[] => {
    if (command.type !== "add_leave") return [];
    const span = rosterDatesBetween(after, command.startDate, command.endDate);
    if (!span.ok) return [];
    const reach = groupLeaveReach(
      after,
      span.ids.map((date) => [command.personId, date] as const),
    );
    if (!reach) return [];
    return [
      {
        key: `groupleave:${stableStringify(command.personId)}|${command.startDate}|${command.endDate}`,
        scope: "leave-and-requests",
        label: `${String(command.personId)}: paid leave for every member`,
        before: null,
        after: `Pins paid leave for ${leaveReachText(reach)}`,
        kind: "created",
      },
    ];
  });
}

/**
 * A person added in this change and marked must-be-off around the days they cover (a
 * borrowed nurse) gets one line saying when they ARE here -- the thing the manager
 * actually asked for. Only when those days are one unbroken run; otherwise the runs
 * above already say it.
 */
function availabilityLines(
  commands: readonly AssistantCommandV1[],
  after: ScenarioUiState,
): Entry[] {
  const days = generateDateItems({ start: after.rangeStart, end: after.rangeEnd });
  const entries: Entry[] = [];
  for (const command of commands) {
    if (command.type !== "add_person") continue;
    const person = stableStringify(command.name.trim());
    const off = new Set(
      after.reqData
        .filter(
          (cell) =>
            cell.kind === "off" &&
            cell.weight === Infinity &&
            stableStringify(cell.person) === person,
        )
        .map((cell) => stableStringify(cell.date)),
    );
    if (off.size === 0) continue;
    const here = days.flatMap((day, index) => (off.has(stableStringify(day.id)) ? [] : [index]));
    if (here.length === 0 || here[here.length - 1] - here[0] !== here.length - 1) continue;
    entries.push({
      key: `available:${person}`,
      scope: "leave-and-requests",
      label: command.name.trim(),
      before: null,
      after: `Available: ${calendarSpan(days[here[0]].iso, days[here[here.length - 1]].iso)}`,
      kind: "created",
    });
  }
  return entries;
}

/**
 * Every rule that targets ALL or a group binds whoever joins it. For an ENABLED HARD
 * count rule (contracted hours, a hard shift-count) that can make the roster
 * infeasible without a word: a borrowed nurse's must-be-off days never count toward
 * a contracted-hours or shift minimum. So each such rule a person becomes bound by --
 * by being added (ALL and their groups) or by joining a group -- is stated as a
 * consequence.
 */
function newlyBoundHardRules(
  before: ScenarioUiState,
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): Entry[] {
  // Renames are not joins: map the new ids back to the ones `before` knows.
  const personWas = new Map<string, string>();
  const groupWas = new Map<string, string>();
  for (const command of commands) {
    if (command.type === "edit_person" && command.name !== String(command.personId)) {
      personWas.set(stableStringify(command.name.trim()), stableStringify(command.personId));
    } else if (command.type === "edit_people_group") {
      groupWas.set(command.newGroupId.trim(), command.groupId);
    }
  }
  const groupsOf = (state: ScenarioUiState, person: string) =>
    state.staffGroups
      .filter((group) => group.members.some((member) => stableStringify(member) === person))
      .map((group) => group.id);
  const existed = new Set(before.staff.map((person) => stableStringify(person.id)));
  const hard = after.cardsByKind.counts.filter(
    (card) => !card.disabled && Math.abs(card.weight) === Infinity,
  );

  const entries: Entry[] = [];
  for (const person of after.staff) {
    const id = stableStringify(person.id);
    const was = personWas.get(id) ?? id;
    const isNew = !existed.has(was);
    const had = new Set(isNew ? [] : groupsOf(before, was));
    const joined = groupsOf(after, id).filter((group) => !had.has(groupWas.get(group) ?? group));
    if (isNew) joined.unshift("ALL");
    for (const card of hard) {
      const refs = flattenRefs(card.person).map(String);
      const everyone = refs.length === 0 || refs.some((ref) => ref.toUpperCase() === "ALL");
      const via = joined.find((group) => (group === "ALL" ? everyone : refs.includes(group)));
      if (via === undefined) continue;
      entries.push({
        key: `binds:${card.uid}|${id}`,
        scope: "shift-counts",
        label: `“${ruleTitle(card, "counts")}” now also binds ${person.id}`,
        before: null,
        after: `Hard rule for ${via === "ALL" ? "everyone" : `“${via}”`}; days they must have off do not count toward it`,
        kind: "created",
      });
    }
  }
  return entries;
}

/**
 * A count rule for everyone or a group that the change rewrites to a fixed list of
 * names (how a borrowed nurse is kept out of the ward's own limits) no longer follows
 * the group: a nurse hired or added to it later is not bound. Said, so it is not a
 * silent loss.
 */
function narrowedToNamedPeople(
  before: ScenarioUiState,
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): Entry[] {
  const groupsIn = (state: ScenarioUiState, refs: unknown) => {
    const groups = new Set(state.staffGroups.map((group) => String(group.id)));
    return flattenRefs(refs)
      .map(String)
      .filter((ref) => ref.toUpperCase() === "ALL" || groups.has(ref));
  };
  return commands.flatMap((command): Entry[] => {
    if (command.type !== "edit_count_rule") return [];
    const was = before.cardsByKind.counts.find((card) => card.uid === command.ruleId);
    const now = after.cardsByKind.counts.find((card) => card.uid === command.ruleId);
    if (!was || !now) return [];
    const lost = groupsIn(before, was.person).filter(
      (group) => !groupsIn(after, now.person).includes(group),
    );
    if (lost.length === 0) return [];
    const whom = lost.map((g) => (g.toUpperCase() === "ALL" ? "everyone" : `“${g}”`)).join(", ");
    return [
      {
        key: `narrowed:${command.ruleId}`,
        scope: "shift-counts",
        label: `“${ruleTitle(now, "counts")}” now names its people one by one`,
        before: `For ${whom}`,
        after: "Nurses hired later, or added to the group later, are not covered by it",
        kind: "changed",
      },
    ];
  });
}

/**
 * The keys a command NAMES, so a consequence is never mistaken for a request.
 *
 * A key the command names but the diff does not contain simply does not appear --
 * this set classifies entries, it never invents them.
 */
function directKeys(
  commands: readonly AssistantCommandV1[],
  before: ScenarioUiState,
  after: ScenarioUiState,
): Set<string> {
  const keys = new Set<string>();
  // A new card's uid is minted by the host, so the command cannot name it; every card
  // of that kind the change created is what the user asked for (no cascade creates a
  // rule card).
  const created = (kind: keyof CardsByKind) => {
    const had = new Set((before.cardsByKind[kind] as readonly AnyRuleCard[]).map((c) => c.uid));
    for (const card of after.cardsByKind[kind] as readonly AnyRuleCard[]) {
      if (!had.has(card.uid)) keys.add(`rule:${kind}:${card.uid}`);
    }
  };
  for (const command of commands) {
    switch (command.type) {
      case "set_roster_range":
        keys.add("dates:range");
        break;
      case "set_rule_enabled":
        keys.add(`rule:${command.ruleKind}:${command.ruleId}`);
        break;
      case "set_staffing_requirement_people":
        keys.add(`rule:requirements:${command.ruleId}`);
        break;
      case "move_leave":
        keys.add(`cell:${stableStringify(command.personId)}|${stableStringify(command.fromDate)}`);
        keys.add(`cell:${stableStringify(command.personId)}|${stableStringify(command.toDate)}`);
        break;
      case "add_shift_type":
        // The host trims the code (Shifts page rule), so the key must too.
        keys.add(`shift:${stableStringify(command.code.trim())}`);
        break;
      case "add_shift_group":
        keys.add(`shiftgroup:${command.groupId.trim()}`);
        break;
      case "add_leave":
      case "set_off_request":
      case "set_shift_request":
      case "clear_requests":
        // Every painted date is asked-for, including a leave day a clear removes.
        for (const key of paintedCellKeys(command, after)) keys.add(key);
        break;
      case "add_shift_sequence_rule":
        created("successions");
        break;
      case "add_count_rule":
      case "add_rest_days_rule":
      case "add_contracted_hours":
        created("counts");
        break;
      case "add_staffing_requirement":
        created("requirements");
        break;
      case "edit_shift_sequence_rule":
        keys.add(`rule:successions:${command.ruleId}`);
        break;
      case "edit_count_rule":
      case "edit_contracted_hours":
        keys.add(`rule:counts:${command.ruleId}`);
        break;
      case "edit_staffing_requirement":
      case "set_skill_mix":
      case "set_staffing_requirement_on_date":
        keys.add(`rule:requirements:${command.ruleId}`);
        break;
      case "remove_rule":
        keys.add(`rule:${command.ruleKind}:${command.ruleId}`);
        break;
      case "add_pairing_rule":
        created("affinities");
        break;
      case "add_supervision_rule":
        created("coverings");
        break;
      case "edit_pairing_rule":
        keys.add(`rule:affinities:${command.ruleId}`);
        break;
      case "edit_supervision_rule":
        keys.add(`rule:coverings:${command.ruleId}`);
        break;
      case "add_person":
        // The host trims names (Staff screen rule), so the keys must too.
        keys.add(`person:${stableStringify(command.name.trim())}`);
        for (const groupId of command.groups) keys.add(`peoplegroup:${groupId}`);
        break;
      case "edit_person":
        keys.add(`person:${stableStringify(command.personId)}`);
        keys.add(`person:${stableStringify(command.name.trim())}`);
        for (const groupId of command.groups) keys.add(`peoplegroup:${groupId}`);
        // Groups they LEAVE (or that follow their rename) were asked for too.
        for (const group of before.staffGroups) {
          if (group.members.some((member) => member === command.personId)) {
            keys.add(`peoplegroup:${group.id}`);
          }
        }
        break;
      case "remove_person":
        keys.add(`person:${stableStringify(command.personId)}`);
        break;
      case "add_people_group":
        keys.add(`peoplegroup:${command.groupId.trim()}`);
        break;
      case "edit_people_group":
        keys.add(`peoplegroup:${command.groupId}`);
        keys.add(`peoplegroup:${command.newGroupId.trim()}`);
        break;
      case "remove_people_group":
        keys.add(`peoplegroup:${command.groupId}`);
        break;
      case "add_temporary_cover":
      case "remove_temporary_cover": {
        // The row, and every count line her credit draws. The host trims names (the Staff
        // form does), so the key must too. An ADD is compared in `after` -- that is the
        // document holding her -- and a REMOVE in `before`, the one that still does.
        const named = {
          name: command.name.trim(),
          date: command.date,
          shiftType: String(command.shiftType),
        };
        const state = command.type === "add_temporary_cover" ? after : before;
        keys.add(`cover:${coverIdentity(named)}`);
        const at = state.temporaryCover.findIndex(
          (cover) => coverIdentity(cover) === coverIdentity(named),
        );
        for (const effect of coverStatuses(state).find((status) => status.index === at)?.effects ??
          []) {
          keys.add(`cover:${effect.cardUid}|${effect.iso}|${effect.shiftId}`);
        }
        break;
      }
    }
  }
  return keys;
}

/** The complete host-derived change set a Preview renders. */
export function deriveProposalDiff(
  before: ScenarioUiState,
  after: ScenarioUiState,
  commands: readonly AssistantCommandV1[],
): ProposalDiff {
  const named = directKeys(commands, before, after);
  const all = diffScenarioDocuments(before, after);
  const direct = [
    ...collapseOffRuns(
      mergeRenames(
        all.filter((entry) => named.has(entry.key)),
        commands,
      ),
      commands,
      after,
    ),
    ...availabilityLines(commands, after),
    ...groupLeaveLines(commands, after),
  ];
  const cascade = [
    ...all.filter((entry) => !named.has(entry.key)),
    ...newlyBoundHardRules(before, after, commands),
    ...narrowedToNamedPeople(before, after, commands),
  ];

  const directDomains = new Set(direct.map((entry) => SCOPE_DOMAIN[entry.scope]));
  const needsReview = SETUP_DOMAINS.filter(
    (domain) =>
      !directDomains.has(domain) && cascade.some((entry) => SCOPE_DOMAIN[entry.scope] === domain),
  );

  const capabilityIds = [
    ...new Set(
      all.map((entry) => entry.scope).filter((scope) => scope !== SCOPE_WITHOUT_CAPABILITY),
    ),
  ].sort();

  return { direct, cascade, capabilityIds, needsReview };
}

/** The screen label a Preview shows for a scope. */
export const SCOPE_LABEL: Record<DiffScope, string> = {
  "roster-period": "Dates",
  "staff-list": "Staff",
  "shift-types": "Shift types",
  "staffing-requirements": "Staffing requirements",
  "shift-successions": "Shift sequences",
  "shift-counts": "Shift counts",
  "shift-affinities": "Pairings",
  "shift-type-coverings": "Supervision",
  "leave-and-requests": "Leave and requests",
  "export-layout": "Export layout",
};

/** The setup-domain label the “Needs review” markers use. */
export const SETUP_DOMAIN_LABEL: Record<SetupDomain, string> = {
  dates: "Dates",
  people: "People and groups",
  shifts: "Shift types",
  rules: "Rules and staffing",
  requests: "Leave and requests",
};
