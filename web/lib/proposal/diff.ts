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
  CardsByKind,
  CountCard,
  RequirementCard,
  ScenarioUiState,
  SuccessionCard,
  UiRequestCell,
  UiShiftType,
} from "@/lib/scenario";
import { EXPRESSION_OPS, substituteTarget } from "@/components/card-editor/expression-model";
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
 * equation, a group or nested list one combined count.
 */
function describeRequirement(card: RequirementCard): string {
  const n = card.requiredNumPeople;
  const p = card.preferredNumPeople;
  const entries = Array.isArray(card.shiftType) ? card.shiftType : [card.shiftType];
  const labels = entries.map((entry) => flattenRefs(entry).map(String).join(" + "));
  const shifts = labels.length === 1 ? labels[0] : `each of ${labels.join(", ")}`;
  const dates = renderDates(card.date);
  const who = renderPeople(card.qualifiedPeople, "");
  const ban = who ? `; only ${who} may work ${labels.join(", ")}` : "";
  if (p == null || p === n) {
    return `Exactly ${n} ${n === 1 ? "person" : "people"} on ${shifts}, ${dates}${ban}`;
  }
  const lean =
    card.weight < 0 ? `${p} preferred` : card.weight > 0 ? `${n} preferred` : "no preference";
  return `${n} to ${p} people on ${shifts}, ${dates} (${lean}, weight ${card.weight})${ban}`;
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

/**
 * A count's strength, per `shift_count` in core (the objective is maximised): a linear
 * expression is a yes/no the weight REWARDS, so a negative weight pays for breaking it;
 * `|x - T|^2` is a squared gap, so a negative weight pulls toward T.
 */
function renderCountStrength(squared: boolean, weight: number, target: number): string {
  if (weight === 0) return "no effect (weight 0)";
  if (squared) {
    if (weight === -Infinity) return `must be exactly ${target}`;
    if (weight < 0) return `pulled toward ${target} (weight ${weight})`;
    return `refused by the solver (a positive weight is not allowed here)`;
  }
  if (weight === Infinity) return "must always hold";
  if (weight === -Infinity) return "must never hold, the solver forces the opposite";
  if (weight > 0) return `kept to where possible (weight ${weight})`;
  return `worked against, the solver is rewarded for breaking it (weight ${weight})`;
}

/** `null` for a list-shaped or contracted-hours count: no single sentence says it honestly. */
function describeCount(card: CountCard): string | null {
  if (typeof card.expression !== "string" || typeof card.target !== "number") return null;
  const op = EXPRESSION_OPS.find((candidate) => candidate.value === card.expression);
  if (!op) return null;
  const squared = op.value === "|x - T|^2";
  const amount = squared ? `Close to ${card.target}` : substituteTarget(op.title, card.target);
  const shifts = flattenRefs(card.countShiftTypes).map(String).join(" + ");
  const people = renderPeople(card.person, "");
  return `${amount} ${shifts} shifts for ${people ? `each of ${people}` : "everyone"}, across ${renderDates(card.countDates)}: ${renderCountStrength(squared, card.weight, card.target)}`;
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
    default:
      // Pairing and supervision: plain wording arrives with their authoring arms.
      return null;
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

function coordinateKey(cell: UiRequestCell): string {
  return `${stableStringify(cell.person)}|${stableStringify(cell.date)}`;
}

// ---------------------------------------------------------------------------
// The structural comparison
// ---------------------------------------------------------------------------

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
        after: to,
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
      render: (group) => `${group.members.length} member${group.members.length === 1 ? "" : "s"}`,
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
      }),
    );
  }

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
      case "clear_requests": {
        // Every painted date is asked-for, including a leave day a clear removes.
        const span = rosterDatesBetween(after, command.startDate, command.endDate);
        if (!span.ok) break;
        for (const date of span.ids) {
          keys.add(`cell:${stableStringify(command.personId)}|${stableStringify(date)}`);
        }
        break;
      }
      case "add_succession_rule":
        created("successions");
        break;
      case "add_count_rule":
        created("counts");
        break;
      case "add_staffing_requirement":
        created("requirements");
        break;
      case "edit_succession_rule":
        keys.add(`rule:successions:${command.ruleId}`);
        break;
      case "edit_count_rule":
        keys.add(`rule:counts:${command.ruleId}`);
        break;
      case "edit_staffing_requirement":
        keys.add(`rule:requirements:${command.ruleId}`);
        break;
      case "remove_rule":
        keys.add(`rule:${command.ruleKind}:${command.ruleId}`);
        break;
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
  const direct = all.filter((entry) => named.has(entry.key));
  const cascade = all.filter((entry) => !named.has(entry.key));

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
