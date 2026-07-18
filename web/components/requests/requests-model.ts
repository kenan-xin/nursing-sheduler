// Shift Requests editor — pure display/layout model (T11, spec 04 FR-SR-03..16).
// This is the side-effect-free backbone the matrix, derived tables, and cell/history
// editors all consume: row/column factories, the preference comparator + cell
// display split, aggregate sign / opacity, and the history H-n layout. No React, no
// store — everything here is a deterministic function so it is provable in the repo's
// `node` vitest env (mirrors `successions-model.ts`).
//
// Ground truth for every comparator/alpha/label constant is the old app
// (`web-frontend/src/app/shift-requests/page.tsx` + `utils/numberParsing.ts`); this
// module mirrors that behavior 1:1 onto the scalar `UiRequestCell` model. Where a
// cell holds a day-state (`leave`/`off`), it projects to a peer `{shiftType, weight}`
// preference (LEAVE → the reserved `LEAVE` selector at `LEAVE_PIN_WEIGHT`, OFF → the
// reserved `OFF` selector at its soft weight) exactly as the old app stored them.

import {
  LEAVE_PIN_WEIGHT,
  type DateRef,
  type GroupId,
  type PersonId,
  type PersonRef,
  type ShiftTypeRef,
  type UiPeopleGroup,
  type UiPerson,
  type UiRequestCell,
  type Weight,
} from "@/lib/scenario";
import { generateDateItems, utcDayOfWeek, type DateRange } from "@/lib/dates";

// --- Weight display (FR-SR-14 / FR-SR-43) -----------------------------------

const ABBREVIATION_UNITS: readonly { value: number; symbol: string }[] = [
  { value: 1e12, symbol: "t" },
  { value: 1e9, symbol: "b" },
  { value: 1e6, symbol: "m" },
  { value: 1e3, symbol: "k" },
];

/**
 * Format a weight for cell/summary display, 1:1 with the old app's
 * `getWeightDisplayLabel` (verified against `numberParsing.test.ts`):
 * `Infinity → "+∞"`, `-Infinity → "-∞"`, `0 → "0"`, otherwise a `+`-prefixed (for
 * positives) value abbreviated with `k`/`m`/`b`/`t` when evenly divisible by the
 * unit (one decimal place when divisible by unit/10) — e.g. `1200 → "+1.2k"`,
 * `5 → "+5"`, `-10000 → "-10k"`.
 *
 * NB: this is intentionally NOT `weight-field.tsx`'s `formatWeight`, which renders
 * `toLocaleString` thousands separators (`+1,200`) and never abbreviates — that
 * control's pill format is a different surface. FR-SR-14/43 require this abbreviated
 * form.
 */
export function weightDisplayLabel(weight: Weight): string {
  if (weight === Infinity) return "+∞";
  if (weight === -Infinity) return "-∞";
  if (weight === 0) return "0";
  const ret = weight > 0 ? `+${weight}` : String(weight);
  for (const { value, symbol } of ABBREVIATION_UNITS) {
    const digits = String(value).length; // e.g. "1000" → 4
    if (weight % value === 0) return ret.slice(0, -digits + 1) + symbol;
    if (weight % (value / 10) === 0) {
      return ret.slice(0, -digits + 1) + "." + ret.slice(-digits + 1, -digits + 2) + symbol;
    }
  }
  return ret;
}

// --- Cell preference view ----------------------------------------------------

/**
 * The `{shiftType, weight}` view the sort/display/sign/alpha helpers operate on.
 * A `UiRequestCell` (leave/off/request) projects to one of these via
 * {@link cellPreferenceOf}, matching the old app's peer-preference storage.
 */
export interface CellPreference {
  shiftType: ShiftTypeRef;
  weight: Weight;
}

/** Project a matrix cell to its `{shiftType, weight}` display preference. */
export function cellPreferenceOf(cell: UiRequestCell): CellPreference {
  switch (cell.kind) {
    case "leave":
      return { shiftType: "LEAVE", weight: LEAVE_PIN_WEIGHT };
    case "off":
      return { shiftType: "OFF", weight: cell.weight };
    case "request":
      return { shiftType: cell.shiftType, weight: cell.weight };
  }
}

// --- Preference sorting (FR-SR-12) ------------------------------------------

/**
 * A shift-type order-index lookup: the 0-based position of a shift-type id within
 * the ordered `[...shiftTypeItems, ...shiftTypeGroups]` list, or `-1` when absent
 * (mirrors the old app's `findIndex`, where `-1` sorts an unknown id first).
 */
export type ShiftTypeOrderIndex = (id: ShiftTypeRef) => number;

/** Build a {@link ShiftTypeOrderIndex} from the ordered shift-type id list. */
export function buildShiftTypeOrderIndex(orderedIds: readonly ShiftTypeRef[]): ShiftTypeOrderIndex {
  const index = new Map<ShiftTypeRef, number>();
  orderedIds.forEach((id, i) => {
    if (!index.has(id)) index.set(id, i);
  });
  return (id) => index.get(id) ?? -1;
}

/**
 * FR-SR-12 comparator (exact): primary DESC magnitude `|weight|`; ties → DESC
 * signed weight (positive before negative); further ties → ASC index in the ordered
 * shift-type list. Returns a raw difference (Array.sort tolerates any sign), matching
 * the old app's `getPreferenceDisplay` sort.
 */
export function comparePreferences(
  a: CellPreference,
  b: CellPreference,
  orderIndex: ShiftTypeOrderIndex,
): number {
  const magA = Math.abs(a.weight);
  const magB = Math.abs(b.weight);
  if (magB !== magA) return magB - magA;
  if (b.weight !== a.weight) return b.weight - a.weight;
  return orderIndex(a.shiftType) - orderIndex(b.shiftType);
}

/** A stable copy of `prefs` ordered by {@link comparePreferences} (never mutates). */
export function sortPreferences(
  prefs: readonly CellPreference[],
  orderIndex: ShiftTypeOrderIndex,
): CellPreference[] {
  return [...prefs].sort((a, b) => comparePreferences(a, b, orderIndex));
}

// --- Cell display split (FR-SR-13 / FR-SR-14) -------------------------------

export interface CellDisplayEntry extends CellPreference {
  /** `"{shiftType} ({weightDisplayLabel})"` (FR-SR-14). */
  label: string;
}

export interface CellDisplay {
  /** The shown preferences (all when ≤3, else the top 2), sorted per FR-SR-12. */
  entries: CellDisplayEntry[];
  /** The `+{moreCount} more` overflow count (`total - 2`), or `0` when all shown. */
  moreCount: number;
}

/**
 * FR-SR-13/14: sort the cell's preferences, then show all when there are ≤3, else
 * the top 2 with a `+{total - 2} more` marker. Each shown entry carries its
 * `"{shiftType} ({label})"` string.
 */
export function cellDisplay(
  prefs: readonly CellPreference[],
  orderIndex: ShiftTypeOrderIndex,
): CellDisplay {
  const sorted = sortPreferences(prefs, orderIndex);
  const maxVisible = sorted.length <= 3 ? 3 : 2;
  const entries = sorted.slice(0, maxVisible).map((p) => ({
    shiftType: p.shiftType,
    weight: p.weight,
    label: `${p.shiftType} (${weightDisplayLabel(p.weight)})`,
  }));
  return { entries, moreCount: Math.max(0, sorted.length - maxVisible) };
}

// --- Aggregate sign & opacity (FR-SR-15 / FR-SR-16) -------------------------

/** FR-SR-15 aggregate sign of a cell's preference set. */
export type AggregateSign = "all-positive" | "all-negative" | "mixed";

/**
 * Non-binding reference tokens (spec 04 FR-SR-15): the rgba base color (opacity
 * comes from {@link cellAlpha}) and the text-color utility per sign. The concrete
 * mapping is the component's call; this is documentation of the old-app reference.
 */
export const AGGREGATE_SIGN_REFERENCE: Readonly<
  Record<AggregateSign, { rgb: string; textClass: string }>
> = {
  "all-positive": { rgb: "74, 222, 128", textClass: "text-green-800" },
  "all-negative": { rgb: "248, 113, 113", textClass: "text-red-800" },
  mixed: { rgb: "250, 204, 21", textClass: "text-yellow-800" },
};

/**
 * FR-SR-15: `all-positive` when every weight `> 0`, `all-negative` when every weight
 * `< 0`, otherwise `mixed`. Callers pass a NON-EMPTY set (an empty cell renders blank
 * and never reaches here); mirrors the old app's `every` checks.
 */
export function aggregateSign(prefs: readonly CellPreference[]): AggregateSign {
  if (prefs.every((p) => p.weight > 0)) return "all-positive";
  if (prefs.every((p) => p.weight < 0)) return "all-negative";
  return "mixed";
}

const GLOBAL_MAX_WEIGHT = 1_000_000;

/**
 * FR-SR-16 (exact): `α = max(0.05, log2(maxWeight) / log2(1_000_000))`, where
 * `maxWeight = min(1_000_000, max over prefs of (|weight| if finite else 1_000_000))`
 * — infinite weights count as `1_000_000`, and α is floored at `0.05` (so a
 * zero-weight cell floors to `0.05`, and a `±∞` cell renders at α ≈ 1). Callers pass
 * a non-empty set.
 */
export function cellAlpha(prefs: readonly CellPreference[]): number {
  const maxWeight = Math.min(
    GLOBAL_MAX_WEIGHT,
    Math.max(
      ...prefs.map((p) => (Number.isFinite(p.weight) ? Math.abs(p.weight) : GLOBAL_MAX_WEIGHT)),
    ),
  );
  return Math.max(0.05, Math.log2(maxWeight) / Math.log2(GLOBAL_MAX_WEIGHT));
}

// --- Rows (FR-SR-03) ---------------------------------------------------------

export interface GroupRequestRow {
  isGroup: true;
  id: GroupId;
  /** A group row's label is just its id (FR-SR-03). */
  label: string;
  description?: string;
  members: PersonRef[];
}

export interface PersonRequestRow {
  isGroup: false;
  id: PersonId;
  /** `"{personIndex}. {id}"` (FR-SR-03), where `personIndex` is 1-based. */
  label: string;
  description?: string;
  /** 1-based index of the person within `staff` (matches the label prefix). */
  personIndex: number;
}

export type RequestRow = GroupRequestRow | PersonRequestRow;

/**
 * FR-SR-03: rows are `[...peopleGroups, ...people]` (groups first). A group row's
 * label is its id; a person row's label is `"{1-based index}. {id}"`. Both surface
 * `description` when present.
 */
export function buildRows(
  staffGroups: readonly UiPeopleGroup[],
  staff: readonly UiPerson[],
): RequestRow[] {
  const groupRows: RequestRow[] = staffGroups.map((g) => ({
    isGroup: true,
    id: g.id,
    label: String(g.id),
    description: g.description,
    members: [...g.members],
  }));
  const personRows: RequestRow[] = staff.map((p, i) => ({
    isGroup: false,
    id: p.id,
    label: `${i + 1}. ${p.id}`,
    description: p.description,
    personIndex: i + 1,
  }));
  return [...groupRows, ...personRows];
}

// --- History layout (FR-SR-05..09) ------------------------------------------

export interface HistoryLayout {
  /** `max(person.history.length) + 1` — always ≥1 (one spare to append). */
  count: number;
  /** Column labels leftmost→rightmost: `H-{count-index}` for index 0..count-1. */
  labels: string[];
}

/** FR-SR-05: `max(0, ...history lengths) + 1` (always ≥1, one spare to append). */
export function historyColumnCount(people: readonly UiPerson[]): number {
  return Math.max(0, ...people.map((p) => p.history?.length ?? 0)) + 1;
}

/** FR-SR-06: labels for index `0..count-1` as `H-{count-index}` (leftmost highest). */
export function historyColumnLabels(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `H-${count - index}`);
}

/** The header layout (count + labels) for the history block (FR-SR-05/06). */
export function historyLayout(people: readonly UiPerson[]): HistoryLayout {
  const count = historyColumnCount(people);
  return { count, labels: historyColumnLabels(count) };
}

/** FR-SR-07: right-alignment offset for a person = `count - history.length`. */
export function historyOffset(person: UiPerson, count: number): number {
  return count - (person.history?.length ?? 0);
}

/**
 * FR-SR-07: the value at a rendered `columnIndex` for a person — `null` when
 * `columnIndex < offset` (blank left padding), else `history[columnIndex - offset]`.
 * Because `history[0]` is the NEWEST entry (newest-first storage), it renders at the
 * leftmost REAL slot (`columnIndex === offset`), which carries the highest H-number
 * that person occupies; the trailing/oldest entry renders at the rightmost slot
 * (`H-1`). People-group rows have no history — this helper is person-only (FR-SR-09).
 */
export function historyValueAt(
  person: UiPerson,
  columnIndex: number,
  count: number,
): string | null {
  const offset = historyOffset(person, count);
  if (columnIndex < offset) return null;
  return person.history?.[columnIndex - offset] ?? null;
}

/**
 * FR-SR-08: a history slot is interactive when `columnIndex >= offset - 1` — the real
 * entries plus exactly one empty padding cell to their left; cells further left are
 * inert.
 */
export function isHistorySlotClickable(
  person: UiPerson,
  columnIndex: number,
  count: number,
): boolean {
  return columnIndex >= historyOffset(person, count) - 1;
}

// --- Columns (FR-SR-04 / FR-SR-10) ------------------------------------------

/** The three synthetic keyword date-group columns, in render order (FR-SR-04). */
export const SYNTHETIC_DATE_GROUP_IDS = ["ALL", "WEEKDAY", "WEEKEND"] as const;
const SYNTHETIC_DATE_GROUP_ID_SET: ReadonlySet<string> = new Set(SYNTHETIC_DATE_GROUP_IDS);

export interface DateGroupColumn {
  kind: "date-group";
  /** The group id used for matching (synthetic keyword id or a custom group id). */
  ref: DateRef;
  label: string;
  description?: string;
  /** `true` for the ALL/WEEKDAY/WEEKEND keyword columns. */
  synthetic: boolean;
  /** Number of date items the column covers (synthetic columns only). */
  count?: number;
}

export interface DateItemColumn {
  kind: "date-item";
  /** The date-item id used for matching. */
  ref: DateRef;
  iso: string;
  label: string;
  /** FR-SR-10: weekend when `utcDayOfWeek ∈ {0,6}` (date items only). */
  weekend: boolean;
}

export type RequestColumn = DateGroupColumn | DateItemColumn;

interface UiDateGroupLike {
  id: GroupId;
  description?: string;
}

/**
 * FR-SR-04/10: the ordered body columns after the People/history block —
 * `[synthetic ALL/WEEKDAY/WEEKEND][custom dateGroups][date items]`:
 *
 * - Synthetic keyword columns (in order): `ALL` (all dates), `WEEKDAY`
 *   (`utcDayOfWeek ∉ {0,6}`), `WEEKEND` (`utcDayOfWeek ∈ {0,6}`), each carrying its
 *   covered-date `count`, derived from `generateDateItems(range)`.
 * - Custom `dateGroups`, EXCLUDING any whose id is a reserved synthetic id
 *   (ALL/WEEKDAY/WEEKEND) so the keyword columns are never duplicated.
 * - The individual date items, each carrying `iso` and a `weekend` flag (the only
 *   columns that are ever weekend-styled).
 */
export function buildColumns(
  range: DateRange,
  dateGroups: readonly UiDateGroupLike[],
): RequestColumn[] {
  const items = generateDateItems(range);
  const weekendCount = items.filter((it) => isWeekendDow(utcDayOfWeek(it.iso))).length;

  const synthetic: DateGroupColumn[] = [
    { kind: "date-group", ref: "ALL", label: "ALL", synthetic: true, count: items.length },
    {
      kind: "date-group",
      ref: "WEEKDAY",
      label: "WEEKDAY",
      synthetic: true,
      count: items.length - weekendCount,
    },
    { kind: "date-group", ref: "WEEKEND", label: "WEEKEND", synthetic: true, count: weekendCount },
  ];

  const custom: DateGroupColumn[] = dateGroups
    .filter((g) => !SYNTHETIC_DATE_GROUP_ID_SET.has(String(g.id)))
    .map((g) => ({
      kind: "date-group",
      ref: g.id,
      label: String(g.id),
      description: g.description,
      synthetic: false,
    }));

  const dateItemColumns: DateItemColumn[] = items.map((it) => ({
    kind: "date-item",
    ref: it.id,
    iso: it.iso,
    label: it.id,
    weekend: isWeekendDow(utcDayOfWeek(it.iso)),
  }));

  return [...synthetic, ...custom, ...dateItemColumns];
}

function isWeekendDow(dow: number): boolean {
  return dow === 0 || dow === 6;
}

// --- Cell preference set (FR-SR-11) -----------------------------------------

/**
 * FR-SR-11: every `reqData` cell at the coordinate `(personRef, colRef)` — the cells
 * whose `person === personRef` and `date === colRef`. `personRef` is a person-item id
 * OR a people-group id; `colRef` is a date-item id OR a date-group/keyword id. Uses
 * strict `===` so a numeric id never collapses with a same-spelling string id (T09
 * exact-identity parity). The returned set may hold a day-state and/or request cells.
 */
export function cellPreferenceSet(
  reqData: readonly UiRequestCell[],
  personRef: PersonRef,
  colRef: DateRef,
): UiRequestCell[] {
  return reqData.filter((cell) => cell.person === personRef && cell.date === colRef);
}

// --- Day-state precedence projection (conflict / preservation boundary) ------

/**
 * The shared day-state precedence read (LEAVE > OFF > worked) for DERIVED
 * projections of `reqData` — the matrix cell renderer applies the same rule
 * per coordinate. Raw coexisting cells are PRESERVED in `reqData` (import
 * fidelity); this resolves them for display: group cells by `(person, date)`;
 * a coordinate holding any `leave` cell emits only its leave cells, else one
 * holding any `off` cell emits only its off cells, else it emits all its
 * worked request cells (one per shiftType). Shadowed lower-precedence cells
 * are dropped from the projection (never from the raw data). Grouping uses
 * strict Map keys (no string coercion), preserving the T09 exact-identity
 * rule; output order follows each coordinate's / cell's first-appearance order.
 */
export function resolveDayStatePrecedence(reqData: readonly UiRequestCell[]): UiRequestCell[] {
  const byCoord = new Map<PersonRef, Map<DateRef, UiRequestCell[]>>();
  // Coordinates in true first-appearance order (a person-major Map iteration
  // would reorder interleaved people).
  const coordOrder: UiRequestCell[][] = [];
  for (const cell of reqData) {
    let byDate = byCoord.get(cell.person);
    if (!byDate) byCoord.set(cell.person, (byDate = new Map()));
    let cells = byDate.get(cell.date);
    if (!cells) {
      cells = [];
      byDate.set(cell.date, cells);
      coordOrder.push(cells);
    }
    cells.push(cell);
  }
  const resolved: UiRequestCell[] = [];
  for (const cells of coordOrder) {
    const leaves = cells.filter((c) => c.kind === "leave");
    if (leaves.length > 0) {
      resolved.push(...leaves);
      continue;
    }
    const offs = cells.filter((c) => c.kind === "off");
    if (offs.length > 0) {
      resolved.push(...offs);
      continue;
    }
    resolved.push(...cells);
  }
  return resolved;
}
