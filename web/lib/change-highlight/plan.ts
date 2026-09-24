// Which screen an applied change should open, what to outline there, and what to say.
//
// Pure, React-free, and assistant-free: the Apply notice consumes it, and nothing here
// knows a model exists. A DiffScope is already a capability id (diff.ts pins that), so
// the only mapping is the Guided fold: the five rule screens are Advanced-only, and in
// Guided every rule is a row on the Rules screen (`rule-library`).

import type { AppMode } from "@/lib/mode/mode";
import {
  SCOPE_LABEL,
  type DiffScope,
  type ProposalDiff,
  type ProposalDiffEntry,
} from "@/lib/proposal/diff";

const RULE_SCOPES: ReadonlySet<DiffScope> = new Set<DiffScope>([
  "staffing-requirements",
  "shift-successions",
  "shift-counts",
  "shift-affinities",
  "shift-type-coverings",
]);

/** Tie-break: the order a ward manager walks set-up. */
const SCREEN_ORDER: readonly string[] = [
  "roster-period",
  "staff-list",
  "shift-types",
  "rule-library",
  "staffing-requirements",
  "shift-successions",
  "shift-counts",
  "shift-affinities",
  "shift-type-coverings",
  "leave-and-requests",
];

const SCREEN_LABEL: Readonly<Record<string, string>> = { ...SCOPE_LABEL, "rule-library": "Rules" };

/** [key prefix, singular, plural]. `available:` is absent: it restates an added person. */
const NOUNS: readonly (readonly [string, string, string])[] = [
  ["dates:range", "roster period", "roster periods"],
  ["dategroup:", "date group", "date groups"],
  ["peoplegroup:", "staff group", "staff groups"],
  ["person:", "person", "people"],
  ["shiftgroup:", "shift group", "shift groups"],
  ["shift:", "shift type", "shift types"],
  ["rule:requirements:", "staffing requirement", "staffing requirements"],
  ["rule:successions:", "shift sequence rule", "shift sequence rules"],
  ["rule:counts:", "shift count rule", "shift count rules"],
  ["rule:affinities:", "pairing rule", "pairing rules"],
  ["rule:coverings:", "supervision rule", "supervision rules"],
  ["binds:", "shift count rule", "shift count rules"],
  ["narrowed:", "shift count rule", "shift count rules"],
  ["cell:", "leave or request day", "leave or request days"],
  ["offrun:", "days-off request", "days-off requests"],
];

const VERB: Record<ProposalDiffEntry["kind"], string> = {
  created: "added",
  changed: "changed",
  removed: "removed",
};

/** A consequence for a rule the user did not edit: it now binds someone new, or narrowed. */
const AFFECTS = /^(binds|narrowed):/;

export function screenForScope(scope: DiffScope, mode: AppMode): string | null {
  if (scope === "export-layout") return null;
  if (mode === "guided" && RULE_SCOPES.has(scope)) return "rule-library";
  return scope;
}

/** The key the owning screen renders for this entry, or null when nothing is left to point at. */
export function targetKeyFor(entry: ProposalDiffEntry): string | null {
  if (entry.kind === "removed") return null;
  const { key } = entry;
  if (key === "export:layout") return null;
  // offrun:<person>|<start>|<end>; the person is already stableStringified and may hold "|".
  const offrun = /^offrun:(.*)\|[^|]*\|[^|]*$/.exec(key);
  if (offrun) return `person:${offrun[1]}`;
  if (key.startsWith("available:")) return `person:${key.slice("available:".length)}`;
  // binds:<uid>|<person>; a uid never holds "|".
  if (key.startsWith("binds:")) return `rule:counts:${key.slice("binds:".length).split("|")[0]}`;
  if (key.startsWith("narrowed:")) return `rule:counts:${key.slice("narrowed:".length)}`;
  return key;
}

/** "3 shift types added, 1 shift group changed". Each on-screen thing counts once. */
function announce(entries: readonly ProposalDiffEntry[]): string {
  const seen = new Set<string>();
  const counts = new Map<string, { one: string; many: string; verb: string; n: number }>();
  for (const entry of entries) {
    const identity = targetKeyFor(entry) ?? entry.key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const noun = NOUNS.find(([prefix]) => entry.key.startsWith(prefix));
    if (!noun) continue;
    const verb = AFFECTS.test(entry.key) ? "affected" : VERB[entry.kind];
    const bucket = `${noun[1]}|${verb}`;
    const slot = counts.get(bucket) ?? { one: noun[1], many: noun[2], verb, n: 0 };
    slot.n += 1;
    counts.set(bucket, slot);
  }
  return [...counts.values()]
    .map(({ one, many, verb, n }) => `${n} ${n === 1 ? one : many} ${verb}`)
    .join(", ");
}

export interface ChangeScreen {
  /** Capability id to open through the host navigation. */
  capabilityId: string;
  /** Screen name for buttons and the announcement. */
  label: string;
  /** Entries the user asked for on this screen; picks the primary screen. */
  directCount: number;
  /** Keys to outline here, deduplicated. Removed things have none. */
  keys: string[];
  /** The aria-live text, e.g. "3 shift types added". */
  announcement: string;
}

export interface ChangeHighlightPlan {
  primary: ChangeScreen | null;
  others: ChangeScreen[];
}

export function planChangeHighlight(
  diff: Pick<ProposalDiff, "direct" | "cascade">,
  mode: AppMode,
): ChangeHighlightPlan {
  const byScreen = new Map<string, { direct: number; entries: ProposalDiffEntry[] }>();
  const add = (entry: ProposalDiffEntry, direct: boolean) => {
    const screen = screenForScope(entry.scope, mode);
    if (screen === null) return;
    const slot = byScreen.get(screen) ?? { direct: 0, entries: [] };
    if (direct) slot.direct += 1;
    slot.entries.push(entry);
    byScreen.set(screen, slot);
  };
  // Direct first, so a rule the user edited is announced as "changed", not "affected".
  for (const entry of diff.direct) add(entry, true);
  for (const entry of diff.cascade) add(entry, false);

  const screens = [...byScreen]
    .map(
      ([capabilityId, slot]): ChangeScreen => ({
        capabilityId,
        label: SCREEN_LABEL[capabilityId] ?? capabilityId,
        directCount: slot.direct,
        keys: [
          ...new Set(slot.entries.map(targetKeyFor).filter((key): key is string => key !== null)),
        ],
        announcement: announce(slot.entries),
      }),
    )
    .sort(
      (a, b) =>
        b.directCount - a.directCount ||
        SCREEN_ORDER.indexOf(a.capabilityId) - SCREEN_ORDER.indexOf(b.capabilityId),
    );
  return { primary: screens[0] ?? null, others: screens.slice(1) };
}
