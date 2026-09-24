# Assistant: After Apply, Open the Changed Screen and Highlight What Changed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user presses Apply on an assistant Preview. Then the app opens the screen that owns most of the change and outlines the changed rows or cards for a few seconds. It announces "3 shift types added" to screen readers. It shows buttons for the other screens that the change reached.

**Architecture:** A new neutral module `web/lib/change-highlight/` holds three things: the change-key vocabulary (`keys.ts`, the same strings `lib/proposal/diff.ts` already emits), a pure planner (`plan.ts`: diff → primary screen + other screens + keys + announcement), and a tiny zustand channel (`store.ts`: which keys are highlighted, auto-cleared after 5 s). Screens import only `lib/change-highlight`. One hook puts `data-change-key` and `data-change-highlight` on their rows. Thus no scheduling code imports `lib/ai` or `components/ai` (the pattern of `lib/optimize/run-request.ts`). A new host card `components/ai/apply-navigation-notice.tsx` reads the Apply outcome. It opens the screen through the existing `useCapabilityNavigation`, which goes through the unsaved-draft nav guard, with a new `reveal: false` option. Then it sets the highlight and writes the steps to an `aria-live` region that is always mounted.

**Tech Stack:** Next.js 16 (`web/`), React 19, TypeScript 5, zustand 5, `@tanstack/react-virtual` 3 (requests matrix). Tests: vitest 4 + Testing Library + fake-indexeddb. Lint: oxlint + ast-grep.

**Spec:** Bead `nursing-sheduler-iwo` ("Assistant: after Apply, open the changed screen and highlight changed rows"), plus the controller's request of 2026-09-24. That request adds these items. The primary screen is the one with the most direct entries. The other screens get links. Accessibility: not colour alone, `prefers-reduced-motion`, `aria-live`. Targets use stable-id data attributes. The `.oxlintrc.json` boundary stays. The plan depends on the add-shift-types plan (`docs/superpowers/plans/2026-09-23-assistant-add-shift-types.md`). That work is in the code now (`add_shift_type` is at `web/lib/proposal/commands.ts:123`).

## Global Constraints

- No DOM automation for edits: the change is still the typed `prepare_scenario_change` → Preview → Apply transaction. This feature only opens a screen (host code) and renders attributes (React).
- Files outside `components/ai/**` and `lib/ai/**` must not import `@/lib/ai*` or `@/components/ai*` (`web/.oxlintrc.json`, pattern group "AI IS OPTIONAL"). `lib/change-highlight/**` imports nothing from the assistant. The assistant imports it.
- `lib/change-highlight/keys.ts` and `plan.ts` must not reach React (they are imported next to `lib/proposal`, which has `react-free.test.ts`). Only `store.ts` imports zustand.
- Do not edit `web/lib/proposal/diff.ts` (sibling plans edit it the same day). Drift between its keys and `keys.ts` is caught by a parity test (Task 1) instead.
- Navigation goes only through `useCapabilityNavigation` (`web/components/ai/use-capability-navigation.ts`). Never call `router.push` directly. That goes around the unsaved-draft guard.
- Highlight must not rely on colour alone (outline = shape change), must not animate under `prefers-reduced-motion: reduce`, and must be announced through `role="status" aria-live="polite"`.
- Colours only through CSS tokens (`var(--brand)`). ast-grep `authored-color-literal*` rejects literals.
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck` and `pnpm run lint` (`oxlint && ast-grep scan`. Use `run` so that pnpm 11 does not resolve a built-in command). Do not run `pnpm install` or `pnpm build`.
- The commit steps apply only to a session with commit authority (repo `CLAUDE.md`, conservative profile). Other sessions stage nothing and report the proposed command.
- Sibling plans of the same day also edit `ASSISTANT_AUTHORITY_STATEMENT` (`web/lib/ai/assistant/scenario-context.ts`) and `assistant-conversation.tsx`. For a conflict, keep both edits.

## Review Focus

1. **A change that only removes things** (remove a shift type, remove a rule). Nothing is left on screen to outline. Expected: the screen still opens, and the announcement says "1 shift type removed". No old key gets a highlight. (Test: Task 1, `removed entries are announced but never targeted`.)
2. **An unsaved draft is open on the current screen at Apply.** Expected: the shell's dialog appears. Stay keeps the user on the current screen, with no highlight. The notice says which screen has the change and shows a button to go there. (Test: Task 6, `stays put and offers a link when the user keeps their draft`.)
3. **A request cell far down the virtualized requests matrix.** Off-screen rows are not in the DOM. Expected: the matrix scrolls its own virtualizer to the first changed row. (Test: Task 5, `scrolls the virtualizer to the first changed row`.)
4. **Guided mode with a rule change.** The five rule screens are Advanced-only, so resolving `staffing-requirements` in Guided fails `mode_hidden`. Expected: the change opens the Guided Rules screen (`rule-library`) and outlines the rule row. (Tests: Task 1, `guided mode folds every rule scope into rule-library`. Task 4, `RulesScreen outlines the rule row an Apply changed`.)
5. **Focus after Apply.** `revealAnchor` moves focus into the destination screen, for example into the Dates start-date input. Expected: focus does not go to the destination's anchor. The user hears the live-region message instead. (Tests: Task 6, `reveal: false confirms the anchor without moving focus`, and the Task 7 integration assertion.)

---

## File Structure

- Create `web/lib/change-highlight/keys.ts`: change-key builders (`changeKeys`). Pure.
- Create `web/lib/change-highlight/keys.test.ts`: parity with `diffScenarioDocuments`.
- Create `web/lib/change-highlight/plan.ts`: `screenForScope`, `targetKeyFor`, `planChangeHighlight`. Pure.
- Create `web/lib/change-highlight/plan.test.ts`.
- Create `web/lib/change-highlight/store.ts`: highlight channel + `useChangeTarget` / `useChangeHighlightKeys` / `changeTargetProps`.
- Create `web/lib/change-highlight/store.test.ts`.
- Modify `web/lib/proposal/react-free.test.ts`: add `keys` and `plan` to the React-free list.
- Modify `web/app/globals.css`: `[data-change-highlight="true"]` rule.
- Modify screens (render targets): `components/dates/roster-period-card.tsx`, `components/dates/date-groups-card.tsx`, `components/people/people-table.tsx`, `components/shift-types/shift-type-grid.tsx`, `components/entity-editor/groups-section.tsx`, `components/card-editor/card-editor-shell.tsx`, the five `*-card-list.tsx`, `components/guided-rules/rule-row.tsx`, `components/requests/requests-matrix.tsx`.
- Modify `web/components/ai/use-capability-navigation.ts`: `reveal?: boolean` option.
- Modify `web/components/ai/use-assistant-proposals.ts`: applied outcome carries the Preview's `diff`.
- Create `web/components/ai/apply-navigation-notice.tsx` (+ `.test.tsx`).
- Modify `web/components/ai/assistant-conversation.tsx`: mount the notice.
- Modify `web/lib/ai/assistant/scenario-context.ts` (+ test): one sentence so the model's Preview message can say where Apply will take the user.
- Create `web/components/ai/apply-navigation.integration.test.tsx`.

---

### Task 1: Change keys and the highlight planner (pure)

**Files:**
- Create: `web/lib/change-highlight/keys.ts`
- Create: `web/lib/change-highlight/plan.ts`
- Test: `web/lib/change-highlight/keys.test.ts`, `web/lib/change-highlight/plan.test.ts`
- Modify: `web/lib/proposal/react-free.test.ts:21-29`

**Interfaces:**
- Consumes: `stableStringify` (`web/lib/proposal/digest.ts:21`), `diffScenarioDocuments`, `SCOPE_LABEL`, `DiffScope`, `ProposalDiff`, `ProposalDiffEntry` (`web/lib/proposal/diff.ts`), `AppMode` (`web/lib/mode/mode.ts:21`), `CardsByKind` (`@/lib/scenario`).
- Produces:
  - `changeKeys.rosterRange(): string`, `.dateGroup(id: string)`, `.person(id: unknown)`, `.peopleGroup(id: string)`, `.shift(id: unknown)`, `.shiftGroup(id: string)`, `.rule(kind: keyof CardsByKind, uid: string)`, `.cellRow(person: unknown)` (prefix `cell:<person>|`), `.cell(person: unknown, date: unknown)`.
  - `screenForScope(scope: DiffScope, mode: AppMode): string | null`
  - `targetKeyFor(entry: ProposalDiffEntry): string | null`
  - `interface ChangeScreen { capabilityId: string; label: string; directCount: number; keys: string[]; announcement: string }`
  - `interface ChangeHighlightPlan { primary: ChangeScreen | null; others: ChangeScreen[] }`
  - `planChangeHighlight(diff: Pick<ProposalDiff, "direct" | "cascade">, mode: AppMode): ChangeHighlightPlan`

- [ ] **Step 1: Write the failing parity test**

`web/lib/change-highlight/keys.test.ts`:

```ts
// The screens render these keys; the diff emits them. A drift here would silently
// highlight nothing, so every scope's key is pinned against the real diff.
import { describe, expect, it } from "vitest";
import { diffScenarioDocuments } from "@/lib/proposal/diff";
import { proposalScenario } from "@/lib/proposal/test-support";
import type { ScenarioUiState } from "@/lib/scenario";
import { changeKeys } from "./keys";

function keysAfter(patch: (state: ScenarioUiState) => Partial<ScenarioUiState>): string[] {
  const before = proposalScenario();
  const after = { ...before, ...patch(before) };
  return diffScenarioDocuments(before, after).map((entry) => entry.key);
}

describe("changeKeys matches the proposal diff", () => {
  it("roster period", () => {
    expect(keysAfter(() => ({ rangeEnd: "2026-04-20" }))).toContain(changeKeys.rosterRange());
  });
  it("date group", () => {
    expect(
      keysAfter((s) => ({ dateGroups: [...s.dateGroups, { id: "Nights", members: ["06"] }] })),
    ).toContain(changeKeys.dateGroup("Nights"));
  });
  it("person, string and numeric ids", () => {
    const keys = keysAfter((s) => ({ staff: [...s.staff, { id: "cy" }, { id: 7 }] }));
    expect(keys).toContain(changeKeys.person("cy"));
    expect(keys).toContain(changeKeys.person(7));
    expect(changeKeys.person(7)).not.toBe(changeKeys.person("7"));
  });
  it("staff group", () => {
    expect(
      keysAfter((s) => ({ staffGroups: [...s.staffGroups, { id: "Seniors", members: ["ana"] }] })),
    ).toContain(changeKeys.peopleGroup("Seniors"));
  });
  it("shift type and shift group", () => {
    const keys = keysAfter((s) => ({
      shifts: [...s.shifts, { id: "EVE" }],
      shiftGroups: [...s.shiftGroups, { id: "Days", members: ["Day"] }],
    }));
    expect(keys).toContain(changeKeys.shift("EVE"));
    expect(keys).toContain(changeKeys.shiftGroup("Days"));
  });
  it("rule card", () => {
    const keys = keysAfter((s) => ({
      cardsByKind: {
        ...s.cardsByKind,
        successions: [
          ...s.cardsByKind.successions,
          { uid: "succ-new", person: ["ALL"], pattern: ["Night", "Day"], weight: -1 },
        ],
      },
    }));
    expect(keys).toContain(changeKeys.rule("successions", "succ-new"));
  });
  it("request cell, and its row prefix", () => {
    const keys = keysAfter((s) => ({
      reqData: [...s.reqData, { uid: "c-new", person: "bo", date: "12", kind: "leave" }],
    }));
    expect(keys).toContain(changeKeys.cell("bo", "12"));
    expect(changeKeys.cell("bo", "12").startsWith(changeKeys.cellRow("bo"))).toBe(true);
  });
});
```

(A fixture literal can fail the type check against `ScenarioUiState`. For that slice, copy the element shape of `proposalScenario()` in `web/lib/proposal/test-support.ts:17-60`. Only the ids matter.)

- [ ] **Step 2: Run it and make sure that it fails**

Run: `cd web && pnpm vitest run lib/change-highlight/keys.test.ts`
Expected: FAIL: `Failed to resolve import "./keys"`.

- [ ] **Step 3: Implement `keys.ts`**

```ts
// The stable identity of a changed row or card.
//
// ONE VOCABULARY, TWO SIDES. `lib/proposal/diff.ts` names a change with these
// strings; a screen renders the same string on the row that shows it. The diff is
// not edited to import this module (other work edits it concurrently);
// `keys.test.ts` pins every builder against the real diff instead.
//
// NEUTRAL ON PURPOSE. Scheduling screens may not import assistant code
// (`.oxlintrc.json`, "AI IS OPTIONAL"), so the vocabulary lives here and both sides
// import it. No React: this sits beside lib/proposal, which must stay React-free.

import type { CardsByKind } from "@/lib/scenario";
import { stableStringify } from "@/lib/proposal/digest";

const cellRow = (person: unknown): string => `cell:${stableStringify(person)}|`;

export const changeKeys = {
  rosterRange: (): string => "dates:range",
  dateGroup: (id: string): string => `dategroup:${id}`,
  person: (id: unknown): string => `person:${stableStringify(id)}`,
  peopleGroup: (id: string): string => `peoplegroup:${id}`,
  shift: (id: unknown): string => `shift:${stableStringify(id)}`,
  shiftGroup: (id: string): string => `shiftgroup:${id}`,
  rule: (kind: keyof CardsByKind, uid: string): string => `rule:${kind}:${uid}`,
  /** Every cell key of one matrix row starts with this. */
  cellRow,
  cell: (person: unknown, date: unknown): string => `${cellRow(person)}${stableStringify(date)}`,
} as const;
```

- [ ] **Step 4: Run it and make sure that it passes**

Run: `cd web && pnpm vitest run lib/change-highlight/keys.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing planner tests**

`web/lib/change-highlight/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DiffScope, ProposalDiffEntry } from "@/lib/proposal/diff";
import { planChangeHighlight, screenForScope, targetKeyFor } from "./plan";

const entry = (
  key: string,
  scope: DiffScope,
  kind: ProposalDiffEntry["kind"] = "created",
): ProposalDiffEntry => ({ key, scope, label: key, before: null, after: "x", kind });

describe("screenForScope", () => {
  it("maps a scope to its own capability in Advanced", () => {
    expect(screenForScope("staffing-requirements", "advanced")).toBe("staffing-requirements");
    expect(screenForScope("shift-types", "advanced")).toBe("shift-types");
  });
  it("guided mode folds every rule scope into rule-library", () => {
    for (const scope of [
      "staffing-requirements",
      "shift-successions",
      "shift-counts",
      "shift-affinities",
      "shift-type-coverings",
    ] as const) {
      expect(screenForScope(scope, "guided")).toBe("rule-library");
    }
    expect(screenForScope("staff-list", "guided")).toBe("staff-list");
  });
  it("export layout has no screen", () => {
    expect(screenForScope("export-layout", "advanced")).toBeNull();
  });
});

describe("targetKeyFor", () => {
  it("passes direct row keys through", () => {
    expect(targetKeyFor(entry('shift:"EVE"', "shift-types"))).toBe('shift:"EVE"');
    expect(targetKeyFor(entry('cell:"bo"|"12"', "leave-and-requests"))).toBe('cell:"bo"|"12"');
  });
  it("removed entries are announced but never targeted", () => {
    expect(targetKeyFor(entry('shift:"EVE"', "shift-types", "removed"))).toBeNull();
  });
  it("points a folded days-off run and an availability line at the person's row", () => {
    expect(targetKeyFor(entry('offrun:"cy"|01|14', "leave-and-requests"))).toBe('person:"cy"');
    expect(targetKeyFor(entry('available:"cy"', "leave-and-requests"))).toBe('person:"cy"');
  });
  it("points a binds/narrowed consequence at its count rule", () => {
    expect(targetKeyFor(entry('binds:u1|"cy"', "shift-counts"))).toBe("rule:counts:u1");
    expect(targetKeyFor(entry("narrowed:u1", "shift-counts", "changed"))).toBe("rule:counts:u1");
  });
  it("has no target for the export layout", () => {
    expect(targetKeyFor(entry("export:layout", "export-layout", "changed"))).toBeNull();
  });
});

describe("planChangeHighlight", () => {
  it("picks the screen with the most direct entries and lists the rest", () => {
    const plan = planChangeHighlight(
      {
        direct: [
          entry('shift:"EVE"', "shift-types"),
          entry('shift:"LATE"', "shift-types"),
          entry('shift:"N2"', "shift-types"),
          entry('person:"cy"', "staff-list"),
        ],
        cascade: [entry('cell:"bo"|"29"', "leave-and-requests", "removed")],
      },
      "advanced",
    );
    expect(plan.primary).toMatchObject({
      capabilityId: "shift-types",
      label: "Shift types",
      directCount: 3,
      keys: ['shift:"EVE"', 'shift:"LATE"', 'shift:"N2"'],
      announcement: "3 shift types added",
    });
    expect(plan.others.map((s) => s.capabilityId)).toEqual(["staff-list", "leave-and-requests"]);
    expect(plan.others[1]).toMatchObject({ keys: [], announcement: "1 leave or request day removed" });
  });

  it("breaks a tie in setup order", () => {
    const plan = planChangeHighlight(
      { direct: [entry('person:"cy"', "staff-list"), entry("dates:range", "roster-period", "changed")], cascade: [] },
      "advanced",
    );
    expect(plan.primary?.capabilityId).toBe("roster-period");
  });

  it("highlights cascade entries on the screen it opens, and counts a rule once", () => {
    const plan = planChangeHighlight(
      {
        direct: [entry("rule:counts:u1", "shift-counts", "changed")],
        cascade: [entry("narrowed:u1", "shift-counts", "changed"), entry('binds:u2|"cy"', "shift-counts")],
      },
      "advanced",
    );
    expect(plan.primary?.keys).toEqual(["rule:counts:u1", "rule:counts:u2"]);
    expect(plan.primary?.announcement).toBe("1 shift count rule changed, 1 shift count rule affected");
  });

  it("merges rule scopes into the Guided Rules screen", () => {
    const plan = planChangeHighlight(
      {
        direct: [
          entry("rule:requirements:r9", "staffing-requirements"),
          entry("rule:successions:s9", "shift-successions"),
        ],
        cascade: [],
      },
      "guided",
    );
    expect(plan.primary).toMatchObject({ capabilityId: "rule-library", label: "Rules", directCount: 2 });
    expect(plan.others).toEqual([]);
  });

  it("returns no screen for an export-only change", () => {
    const plan = planChangeHighlight(
      { direct: [entry("export:layout", "export-layout", "changed")], cascade: [] },
      "advanced",
    );
    expect(plan).toEqual({ primary: null, others: [] });
  });
});
```

- [ ] **Step 6: Run them and make sure that they fail**

Run: `cd web && pnpm vitest run lib/change-highlight/plan.test.ts`
Expected: FAIL: `Failed to resolve import "./plan"`.

- [ ] **Step 7: Implement `plan.ts`**

```ts
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
    .map(([capabilityId, slot]): ChangeScreen => ({
      capabilityId,
      label: SCREEN_LABEL[capabilityId] ?? capabilityId,
      directCount: slot.direct,
      keys: [
        ...new Set(slot.entries.map(targetKeyFor).filter((key): key is string => key !== null)),
      ],
      announcement: announce(slot.entries),
    }))
    .sort(
      (a, b) =>
        b.directCount - a.directCount ||
        SCREEN_ORDER.indexOf(a.capabilityId) - SCREEN_ORDER.indexOf(b.capabilityId),
    );
  return { primary: screens[0] ?? null, others: screens.slice(1) };
}
```

- [ ] **Step 8: Add both modules to the React-free guard**

In `web/lib/proposal/react-free.test.ts`, inside the `it.each([...])` list, add:

```ts
    ["change keys", () => import("@/lib/change-highlight/keys")],
    ["change highlight plan", () => import("@/lib/change-highlight/plan")],
```

- [ ] **Step 9: Run the tests**

Run: `cd web && pnpm vitest run lib/change-highlight lib/proposal/react-free.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/lib/change-highlight/keys.ts web/lib/change-highlight/keys.test.ts web/lib/change-highlight/plan.ts web/lib/change-highlight/plan.test.ts web/lib/proposal/react-free.test.ts
git commit -m "feat(change-highlight): change keys + apply highlight planner"
```

---

### Task 2: The highlight channel and its outline style

**Files:**
- Create: `web/lib/change-highlight/store.ts`
- Test: `web/lib/change-highlight/store.test.ts`
- Modify: `web/app/globals.css` (append next to the other attribute rules, before the `@media (prefers-reduced-motion: reduce)` block at ~line 1072)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `CHANGE_HIGHLIGHT_MS = 5_000`
  - `CHANGE_TARGET_ATTRIBUTE = "data-change-key"`, `CHANGE_HIGHLIGHT_ATTRIBUTE = "data-change-highlight"`, `CHANGE_HIGHLIGHT_SELECTOR = '[data-change-highlight="true"]'`
  - `useChangeHighlightStore` (zustand, state `{ keys: ReadonlySet<string> }`)
  - `showChangeHighlight(keys: readonly string[], durationMs?: number): void`
  - `clearChangeHighlight(): void`
  - `changeTargetProps(key: string | undefined, highlighted: boolean): Record<string, string>`
  - `useChangeTarget(key: string | undefined): Record<string, string>` (a hook to spread on the row)
  - `useChangeHighlightKeys(): ReadonlySet<string>` (a hook for the matrix)

- [ ] **Step 1: Write the failing test**

`web/lib/change-highlight/store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_HIGHLIGHT_MS,
  changeTargetProps,
  clearChangeHighlight,
  showChangeHighlight,
  useChangeHighlightStore,
} from "./store";

const keys = () => [...useChangeHighlightStore.getState().keys];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearChangeHighlight();
  vi.useRealTimers();
});

describe("the change highlight channel", () => {
  it("holds the keys, then clears itself", () => {
    showChangeHighlight(["a", "b"]);
    expect(keys()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(CHANGE_HIGHLIGHT_MS - 1);
    expect(keys()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(keys()).toEqual([]);
  });

  it("a second highlight replaces the first and restarts the clock", () => {
    showChangeHighlight(["a"]);
    vi.advanceTimersByTime(CHANGE_HIGHLIGHT_MS - 10);
    showChangeHighlight(["b"]);
    vi.advanceTimersByTime(20);
    expect(keys()).toEqual(["b"]);
  });

  it("clear drops everything at once", () => {
    showChangeHighlight(["a"]);
    clearChangeHighlight();
    expect(keys()).toEqual([]);
  });
});

describe("changeTargetProps", () => {
  it("always names the target, and marks it only while highlighted", () => {
    expect(changeTargetProps("k", false)).toEqual({ "data-change-key": "k" });
    expect(changeTargetProps("k", true)).toEqual({
      "data-change-key": "k",
      "data-change-highlight": "true",
    });
  });
  it("renders nothing for a row with no key (a built-in rule)", () => {
    expect(changeTargetProps(undefined, true)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and make sure that it fails**

Run: `cd web && pnpm vitest run lib/change-highlight/store.test.ts`
Expected: FAIL: `Failed to resolve import "./store"`.

- [ ] **Step 3: Implement `store.ts`**

```ts
// Which rows a just-applied change should outline, for a few seconds.
//
// The one seam between the assistant's Apply and the scheduling screens. The Apply
// notice writes here after it has navigated; a screen's rows read here through
// `useChangeTarget`. It lives in lib/, not lib/ai, because scheduling code may never
// import assistant code (`.oxlintrc.json`, "AI IS OPTIONAL") -- the same reason
// `lib/optimize/run-request.ts` lives where it does.
//
// Screens render the KEY always and the HIGHLIGHT only while it is live, so the
// attribute is a stable target id and not a styling toggle a re-skin could drop.

import { create } from "zustand";

// ponytail: fixed duration. Make it a setting only if users ask for longer.
export const CHANGE_HIGHLIGHT_MS = 5_000;
export const CHANGE_TARGET_ATTRIBUTE = "data-change-key";
export const CHANGE_HIGHLIGHT_ATTRIBUTE = "data-change-highlight";
export const CHANGE_HIGHLIGHT_SELECTOR = `[${CHANGE_HIGHLIGHT_ATTRIBUTE}="true"]`;

const NONE: ReadonlySet<string> = new Set();

export const useChangeHighlightStore = create<{ keys: ReadonlySet<string> }>()(() => ({
  keys: NONE,
}));

let timer: ReturnType<typeof setTimeout> | undefined;

export function clearChangeHighlight(): void {
  clearTimeout(timer);
  timer = undefined;
  useChangeHighlightStore.setState({ keys: NONE });
}

export function showChangeHighlight(
  keys: readonly string[],
  durationMs: number = CHANGE_HIGHLIGHT_MS,
): void {
  clearTimeout(timer);
  useChangeHighlightStore.setState({ keys: new Set(keys) });
  timer = setTimeout(clearChangeHighlight, durationMs);
}

export function changeTargetProps(
  key: string | undefined,
  highlighted: boolean,
): Record<string, string> {
  if (key === undefined) return {};
  return highlighted
    ? { [CHANGE_TARGET_ATTRIBUTE]: key, [CHANGE_HIGHLIGHT_ATTRIBUTE]: "true" }
    : { [CHANGE_TARGET_ATTRIBUTE]: key };
}

/** Spread on the row: `<tr {...useChangeTarget(changeKeys.person(item.id))}>`. */
export function useChangeTarget(key: string | undefined): Record<string, string> {
  const highlighted = useChangeHighlightStore(
    (state) => key !== undefined && state.keys.has(key),
  );
  return changeTargetProps(key, highlighted);
}

/** For lists that render many targets at once (the requests matrix). */
export function useChangeHighlightKeys(): ReadonlySet<string> {
  return useChangeHighlightStore((state) => state.keys);
}
```

- [ ] **Step 4: Add the outline rule to `web/app/globals.css`**

Append before the `@media (prefers-reduced-motion: reduce)` block:

```css
/* A row or card a just-applied assistant change touched (lib/change-highlight).
   The OUTLINE is the cue: a 3px ring is a shape change that reads without colour
   vision (WCAG 1.4.1), and --brand clears 3:1 against every surface (1.4.11).
   Inset, so a parent's overflow clip or a neighbouring grid cell cannot hide it. */
[data-change-highlight="true"] {
  outline: 3px solid var(--brand);
  outline-offset: -3px;
}

/* The ring settles in only for users who have not asked for less motion; the global
   reduced-motion rule below would also still it, this keeps it off by default. */
@media (prefers-reduced-motion: no-preference) {
  [data-change-highlight="true"] {
    animation: ns-change-in var(--dur-base) cubic-bezier(0.4, 0, 0.2, 1);
  }
}

@keyframes ns-change-in {
  from {
    outline-offset: 3px;
  }
  to {
    outline-offset: -3px;
  }
}
```

- [ ] **Step 5: Run tests and lint**

Run: `cd web && pnpm vitest run lib/change-highlight/store.test.ts && pnpm run lint`
Expected: PASS. Lint is clean (`authored-color-literal` accepts `var(--brand)`).

- [ ] **Step 6: Commit**

```bash
git add web/lib/change-highlight/store.ts web/lib/change-highlight/store.test.ts web/app/globals.css
git commit -m "feat(change-highlight): highlight channel + non-colour outline style"
```

---

### Task 3: Set-up screens render change targets (Dates, Staff, Shift types, groups)

**Files:**
- Modify: `web/components/dates/roster-period-card.tsx:156-160` (root `<section>`)
- Modify: `web/components/dates/date-groups-card.tsx:474-501` (`GroupViewCard` root `<div>`)
- Modify: `web/components/people/people-table.tsx:502-548` (`ReadRow` `<tr>`), `:473` (`<GroupsSection>` call)
- Modify: `web/components/shift-types/shift-type-grid.tsx:519-562` (`ShiftCard` root `<div>`), `:414` (`<GroupsSection>` call)
- Modify: `web/components/entity-editor/groups-section.tsx:226-247` (props), `:381` (`<GroupRow>` call), `:437-525` (`GroupRow`)
- Test: `web/components/dates/roster-period-card.test.tsx`, `web/components/dates/date-groups-card.test.tsx`, `web/components/people/people-table.test.tsx`, `web/components/shift-types/shift-type-grid.test.tsx`

**Interfaces:**
- Consumes: `changeKeys` (Task 1). `useChangeTarget`, `showChangeHighlight`, `clearChangeHighlight` (Task 2).
- Produces: `GroupsSectionProps.groupChangeKey?: (groupId: string) => string`. It is optional, so `groups-section.test.tsx` needs no change. Both screens give it.

- [ ] **Step 1: Write the failing tests**

Append to `web/components/dates/roster-period-card.test.tsx` (add `act` to the Testing Library import and the two new imports at the top):

```tsx
import { changeKeys } from "@/lib/change-highlight/keys";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";

describe("RosterPeriodCard — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("outlines the card when an Apply changed the roster period", () => {
    render(<RosterPeriodCard range={VALID_RANGE} importedHolidaysPresent onCommit={vi.fn()} />);
    const card = screen.getByTestId("roster-period-card");
    expect(card).toHaveAttribute("data-change-key", changeKeys.rosterRange());
    expect(card).not.toHaveAttribute("data-change-highlight");
    act(() => showChangeHighlight([changeKeys.rosterRange()]));
    expect(card).toHaveAttribute("data-change-highlight", "true");
  });
});
```

Append to `web/components/dates/date-groups-card.test.tsx` (same imports, plus `act`):

```tsx
describe("DateGroupsCard — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("outlines the date group an Apply added", () => {
    renderCard(AUG);
    act(() => showChangeHighlight([changeKeys.dateGroup("SummerRun")]));
    expect(screen.getByTestId("editable-group-SummerRun")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
  });
});
```

Append to `web/components/people/people-table.test.tsx` (imports as above):

```tsx
describe("PeopleTable — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("outlines the person and staff group an Apply changed, and nothing else", async () => {
    await seed({
      staff: [{ id: "Aisha Rahman", history: [] }, { id: "Bo", history: [] }],
      staffGroups: [{ id: "Seniors", members: ["Aisha Rahman"] }],
    });
    render(<PeopleTable />);
    act(() =>
      showChangeHighlight([changeKeys.person("Aisha Rahman"), changeKeys.peopleGroup("Seniors")]),
    );
    expect(screen.getByTestId(`people-row-${sk("Aisha Rahman")}`)).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId(`people-row-${sk("Bo")}`)).not.toHaveAttribute(
      "data-change-highlight",
    );
    expect(screen.getByTestId("group-row-Seniors")).toHaveAttribute("data-change-highlight", "true");
  });
});
```

Append to `web/components/shift-types/shift-type-grid.test.tsx` (imports as above):

```tsx
describe("ShiftTypeGrid — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("outlines the shift card and shift group an Apply added", async () => {
    await seed({
      shifts: [{ id: "Day" }, { id: "EVE" }],
      shiftGroups: [{ id: "Late", members: ["EVE"] }],
    });
    render(<ShiftTypeGrid />);
    act(() => showChangeHighlight([changeKeys.shift("EVE"), changeKeys.shiftGroup("Late")]));
    expect(screen.getByTestId("shift-card-string:EVE")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId("shift-card-string:Day")).not.toHaveAttribute(
      "data-change-highlight",
    );
    expect(screen.getByTestId("group-row-Late")).toHaveAttribute("data-change-highlight", "true");
  });
});
```

(`shift-card-string:EVE` is `shift-card-${entityKey("EVE")}`. `entityKey` is at `components/entity-editor/core/descriptor.ts:28`.)

- [ ] **Step 2: Run them and make sure that they fail**

Run: `cd web && pnpm vitest run components/dates/roster-period-card.test.tsx components/dates/date-groups-card.test.tsx components/people/people-table.test.tsx components/shift-types/shift-type-grid.test.tsx -t "change highlight"`
Expected: FAIL: attribute `data-change-key` / `data-change-highlight` missing.

- [ ] **Step 3: Render the targets**

`roster-period-card.tsx`: imports, then in the component body before `return`, and on the `<section>`:

```tsx
import { changeKeys } from "@/lib/change-highlight/keys";
import { useChangeTarget } from "@/lib/change-highlight/store";
// ...
  const changeTarget = useChangeTarget(changeKeys.rosterRange());
// ...
    <section
      className={cn(surfaceVariants({ role: "surface", geometry: "card" }))}
      data-testid="roster-period-card"
      {...capabilityAnchorProps(DATES_ROSTER_PERIOD_ANCHOR)}
      {...changeTarget}
    >
```

(Call the hook at the top of the component body with the other hooks, not after any early return.)

`date-groups-card.tsx` `GroupViewCard`: first line of the body, then on the root `<div>` next to `data-testid={`editable-group-${group.id}`}`:

```tsx
  const changeTarget = useChangeTarget(changeKeys.dateGroup(group.id));
// ...
      data-testid={`editable-group-${group.id}`}
      {...changeTarget}
```

`people-table.tsx` `ReadRow`: first line of the body, and on the `<tr>`:

```tsx
  const changeTarget = useChangeTarget(changeKeys.person(item.id));
// ...
    <tr
      data-testid={`people-row-${itemKey}`}
      {...changeTarget}
```

`shift-type-grid.tsx` `ShiftCard`: first line of the body, and on the root `<div>`:

```tsx
  const changeTarget = useChangeTarget(changeKeys.shift(item.id));
// ...
    <div
      data-testid={`shift-card-${cardKey}`}
      {...changeTarget}
```

`groups-section.tsx`:

```tsx
// In GroupsSectionProps (after `config?`):
  /** The change-highlight key for a group row (lib/change-highlight). The Staff and
   *  Shift screens name their groups differently, so each passes its own. */
  groupChangeKey?: (groupId: string) => string;

// Destructure `groupChangeKey` in GroupsSection, and pass it on at the <GroupRow> call (~line 381):
            changeKey={groupChangeKey?.(group.id)}

// GroupRow: add `changeKey,` to the destructure and `changeKey: string | undefined;` to its prop type.
// First line of GroupRow's body (BEFORE the `if (isEditing)` early return -- a hook):
  const changeTarget = useChangeTarget(changeKey);
// ...and on the read-mode root <div> (the one with draggable={canDrag}):
      data-testid={`group-row-${group.id}`}
      {...changeTarget}
```

Callers:

```tsx
// people-table.tsx, <GroupsSection ...> at ~line 473:
        groupChangeKey={changeKeys.peopleGroup}
// shift-type-grid.tsx, <GroupsSection ...> at ~line 414:
        groupChangeKey={changeKeys.shiftGroup}
```

Every modified file imports `changeKeys` from `@/lib/change-highlight/keys` and/or `useChangeTarget` from `@/lib/change-highlight/store` as it uses them.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd web && pnpm vitest run components/dates components/people components/shift-types components/entity-editor && pnpm typecheck && pnpm run lint`
Expected: PASS. No new lint errors (no screen imports `@/lib/ai*` / `@/components/ai*`).

- [ ] **Step 5: Commit**

```bash
git add web/components/dates web/components/people web/components/shift-types web/components/entity-editor/groups-section.tsx
git commit -m "feat(screens): set-up rows render change-highlight targets"
```

---

### Task 4: Rule screens render change targets (five Advanced lists + Guided Rules)

**Files:**
- Modify: `web/components/card-editor/card-editor-shell.tsx:435-500` (`CardListItem`)
- Modify: `web/components/requirements/requirement-card-list.tsx:~71`, `web/components/successions/succession-card-list.tsx:~85`, `web/components/counts/count-card-list.tsx:~185`, `web/components/affinities/affinity-card-list.tsx:~49`, `web/components/coverings/covering-card-list.tsx:~49` (each `<CardListItem key={card.uid} ...>`)
- Modify: `web/components/guided-rules/rule-row.tsx:~88-95` (`<li>`)
- Test: `web/components/card-editor/card-editor-shell.test.tsx`, `web/components/guided-rules/rules-screen.test.tsx`

**Interfaces:**
- Consumes: `changeKeys.rule`, `useChangeTarget`, `showChangeHighlight`, `clearChangeHighlight`.
- Produces: `CardListItem` gains a REQUIRED `changeKey: string` prop. Required so the compiler proves all five lists pass it (its only callers besides its test).

- [ ] **Step 1: Write the failing tests**

In `web/components/card-editor/card-editor-shell.test.tsx`: add `changeKey="rule:coverings:c0"` to the two existing `<CardListItem ...>` renders (lines ~96 and ~142), and append:

```tsx
import { act } from "@testing-library/react";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";

describe("CardListItem — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("names its target and outlines only while highlighted", () => {
    render(
      <ul>
        <CardListItem
          index={0}
          title="Night cap"
          fields={[]}
          actions={null}
          testId="count-card-0"
          changeKey="rule:counts:u1"
        />
      </ul>,
    );
    const card = screen.getByTestId("count-card-0");
    expect(card).toHaveAttribute("data-change-key", "rule:counts:u1");
    expect(card).not.toHaveAttribute("data-change-highlight");
    act(() => showChangeHighlight(["rule:counts:u1"]));
    expect(card).toHaveAttribute("data-change-highlight", "true");
  });
});
```

(Merge the `act` import into the existing `@testing-library/react` import. Add `afterEach` to the vitest import where it is missing.)

Append to `web/components/guided-rules/rules-screen.test.tsx`:

```tsx
import { changeKeys } from "@/lib/change-highlight/keys";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";

describe("RulesScreen — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("RulesScreen outlines the rule row an Apply changed, never a built-in", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    act(() => showChangeHighlight([changeKeys.rule("requirements", "r1")]));
    expect(screen.getByTestId("rule-row-requirements:r1")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId(/rule-row-builtin/)).not.toHaveAttribute("data-change-key");
  });
});
```

- [ ] **Step 2: Run them and make sure that they fail**

Run: `cd web && pnpm vitest run components/card-editor/card-editor-shell.test.tsx components/guided-rules/rules-screen.test.tsx -t "change highlight"`
Expected: FAIL (typecheck in vitest is lenient, so the failure is the missing attribute).

- [ ] **Step 3: Implement**

`card-editor-shell.tsx` `CardListItem`: add `changeKey,` to the destructure, `/** lib/change-highlight key, e.g. changeKeys.rule("counts", card.uid). */ changeKey: string;` to its prop type, then:

```tsx
  const changeTarget = useChangeTarget(changeKey);
  return (
    <li
      {...changeTarget}
      draggable={draggable}
```

Each of the five lists, on its `<CardListItem key={card.uid} ...>`:

```tsx
            changeKey={changeKeys.rule("requirements", card.uid)}   // requirement-card-list.tsx
            changeKey={changeKeys.rule("successions", card.uid)}    // succession-card-list.tsx
            changeKey={changeKeys.rule("counts", card.uid)}         // count-card-list.tsx
            changeKey={changeKeys.rule("affinities", card.uid)}     // affinity-card-list.tsx
            changeKey={changeKeys.rule("coverings", card.uid)}      // covering-card-list.tsx
```

`rule-row.tsx`: first line of the `RuleRow` body, and on the `<li>`:

```tsx
  // A built-in structural row has no card behind it, so it is never a change target.
  const changeTarget = useChangeTarget(
    row.kind && row.constraintId ? changeKeys.rule(row.kind, row.constraintId) : undefined,
  );
// ...
      data-testid={`rule-row-${row.id}`}
      data-disabled={row.enabled ? undefined : "true"}
      {...changeTarget}
```

(`GuidedRuleRow.kind?` / `constraintId?` are at `components/guided-rules/types.ts:65-67`. `GuidedRuleConstraintKind` is assignable to `keyof CardsByKind`. For a `tsc` error, widen the `kind` parameter of `changeKeys.rule` to `GuidedRuleConstraintKind | keyof CardsByKind` in the Task 1 file.)

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd web && pnpm vitest run components/card-editor components/guided-rules components/requirements components/successions components/counts components/affinities components/coverings && pnpm typecheck && pnpm run lint`
Expected: PASS. `tsc` is clean, which proves that all five lists give `changeKey`.

- [ ] **Step 5: Commit**

```bash
git add web/components/card-editor/card-editor-shell.tsx web/components/card-editor/card-editor-shell.test.tsx web/components/*/[a-z]*-card-list.tsx web/components/guided-rules/rule-row.tsx web/components/guided-rules/rules-screen.test.tsx
git commit -m "feat(screens): rule cards and guided rule rows render change targets"
```

---

### Task 5: Requests matrix renders cell and row targets (virtualized)

**Files:**
- Modify: `web/components/requests/requests-matrix.tsx`: hook near `useVirtualizer` (~line 288), row label `<div>` (~line 429), cell presentation (~line 520)
- Test: `web/components/requests/requests-matrix.test.tsx`

**Interfaces:**
- Consumes: `changeKeys.person`, `changeKeys.cell`, `changeKeys.cellRow`, `useChangeHighlightKeys`, `changeTargetProps`, `showChangeHighlight`, `clearChangeHighlight`.
- Produces: matrix cells carry `data-change-key = changeKeys.cell(row.id, col.ref)`. The sticky row label carries `changeKeys.person(row.id)` (target for folded days-off runs and availability lines, Task 1 `targetKeyFor`).

- [ ] **Step 1: Write the failing tests**

Append to `web/components/requests/requests-matrix.test.tsx` (merge `act` into the Testing Library import):

```tsx
import { changeKeys } from "@/lib/change-highlight/keys";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";

describe("RequestsMatrix — change highlight", () => {
  afterEach(() => clearChangeHighlight());

  it("outlines the changed cell and the row of a folded days-off run", () => {
    render(<RequestsMatrix {...makeProps()} />);
    act(() =>
      showChangeHighlight([changeKeys.cell("Alice", "2026-05-01"), changeKeys.person("Bob")]),
    );
    expect(screen.getByTestId("cell-Alice-2026-05-01")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId("cell-Alice-2026-05-02")).not.toHaveAttribute(
      "data-change-highlight",
    );
    const bobLabel = Array.from(document.querySelectorAll("[data-change-key]")).find(
      (el) => el.getAttribute("data-change-key") === changeKeys.person("Bob"),
    );
    expect(bobLabel).toHaveAttribute("data-change-highlight", "true");
  });

  it("scrolls the virtualizer to the first changed row", () => {
    const scrollTo = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(scrollTo);
    render(<RequestsMatrix {...makeProps()} />);
    act(() => showChangeHighlight([changeKeys.cell("Bob", "2026-05-02")]));
    expect(scrollTo).toHaveBeenCalled();
  });
});
```

(The `scrollToIndex` of `@tanstack/react-virtual` ends in `scrollElement.scrollTo(...)`. The pinned version can set `scrollTop` instead. In that case, assert that `scrollTop` changed. Read `scrollToOffset` and `elementScroll` in `node_modules/@tanstack/virtual-core/dist/esm/index.js` to find out.)

- [ ] **Step 2: Run them and make sure that they fail**

Run: `cd web && pnpm vitest run components/requests/requests-matrix.test.tsx -t "change highlight"`
Expected: FAIL: no `data-change-highlight` on the cell.

- [ ] **Step 3: Implement**

Imports:

```tsx
import { changeKeys } from "@/lib/change-highlight/keys";
import { changeTargetProps, useChangeHighlightKeys } from "@/lib/change-highlight/store";
```

Directly after the `useVirtualizer({...})` call (~line 288), before any early return:

```tsx
  // Off-screen rows are not in the DOM, so the matrix brings the first changed row
  // into view itself. One read of the set; each cell below is a Set lookup.
  const highlighted = useChangeHighlightKeys();
  useEffect(() => {
    if (highlighted.size === 0) return;
    const index = rows.findIndex((row) => {
      if (highlighted.has(changeKeys.person(row.id))) return true;
      const prefix = changeKeys.cellRow(row.id);
      for (const key of highlighted) if (key.startsWith(prefix)) return true;
      return false;
    });
    // ponytail: rows only; add horizontal scroll to the column if wide rosters hide it.
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [highlighted, rows, virtualizer]);
```

(Add `useEffect` to the React import of the file, where it is not there yet.)

Sticky row label `<div className="sticky left-0 z-10 ...">` (~line 429):

```tsx
                <div
                  className="sticky left-0 z-10 flex items-center gap-2 truncate border-b border-r border-line bg-surface px-3"
                  title={row.description}
                  {...changeTargetProps(
                    changeKeys.person(row.id),
                    highlighted.has(changeKeys.person(row.id)),
                  )}
                >
```

In the `columns.map` body, after `const key = coordKey(row.id, colRef);`:

```tsx
                  const changeKey = changeKeys.cell(row.id, colRef);
```

and in `cellPresentation` add:

```tsx
                    ...changeTargetProps(changeKey, highlighted.has(changeKey)),
```

(`cellPresentation` is spread onto both the `<button>` and the `<div>` variant, so both get it.)

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `cd web && pnpm vitest run components/requests && pnpm typecheck && pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/components/requests/requests-matrix.tsx web/components/requests/requests-matrix.test.tsx
git commit -m "feat(requests): matrix cells and rows render change targets, scroll to first"
```

---

### Task 6: Apply notice — navigate, highlight, announce, link the rest

**Files:**
- Modify: `web/components/ai/use-capability-navigation.ts:85-110` (options), `:248-262` (reveal branch)
- Modify: `web/components/ai/use-assistant-proposals.ts:31-35` (`ApplyOutcomeView`), `:~195-230` (`apply`)
- Create: `web/components/ai/apply-navigation-notice.tsx`
- Modify: `web/components/ai/assistant-conversation.tsx:~26-30` (import), `:~171` (mount after `<AssistantReceipts>`)
- Modify: `web/lib/ai/assistant/scenario-context.ts:~99` (one sentence), `web/lib/ai/assistant/scenario-context.test.ts:~76`
- Test: `web/components/ai/use-capability-navigation.test.tsx`, `web/components/ai/apply-navigation-notice.test.tsx`, `web/components/ai/assistant-proposal.test.tsx`

**Interfaces:**
- Consumes: `planChangeHighlight`, `ChangeHighlightPlan`, `ChangeScreen` (Task 1). `showChangeHighlight`, `CHANGE_HIGHLIGHT_SELECTOR` (Task 2). `useCapabilityNavigation`, `readCapabilityContext`, `CAPABILITY_UNAVAILABLE`.
- Produces:
  - `NavigateToCapabilityOptions.reveal?: boolean`. With `false`, the hook finds the anchor but returns `status: "navigated"` without scroll/focus.
  - `ApplyOutcomeView` applied variant gains `diff: ProposalDiff`.
  - `ApplyNavigationNotice({ controller }: { controller: AssistantProposalController })`, `describeStep(step: ApplyStep): string`, `type ApplyStep = { screen: ChangeScreen; status: "opening" | "shown" | "stayed" | "failed" }`.
  - DOM contract: `data-testid="apply-navigation-status"` (always-mounted `role="status"` live region), `apply-navigation`, `apply-navigation-step`, `apply-navigation-link` (with `data-capability-id`), `apply-navigation-done`.

- [ ] **Step 1: Write the failing navigation test**

Append to `web/components/ai/use-capability-navigation.test.tsx`:

```tsx
describe("reveal: false", () => {
  it("reveal: false confirms the anchor without moving focus", async () => {
    window.history.replaceState({}, "", "/shift-types");
    mountAnchor("shift-types.add-shift-type");
    const before = document.activeElement;
    const outcome = await navigate("shift-types", { ...FAST, reveal: false });
    expect(outcome).toMatchObject({ status: "navigated", capabilityId: "shift-types" });
    expect(document.activeElement).toBe(before);
  });

  it("still refuses when the anchor never mounts", async () => {
    window.history.replaceState({}, "", "/shift-types");
    const outcome = await navigate("shift-types", { ...FAST, reveal: false });
    expect(outcome).toMatchObject({ status: CAPABILITY_UNAVAILABLE, reason: "anchor_missing" });
  });
});
```

- [ ] **Step 2: Run it and make sure that it fails**

Run: `cd web && pnpm vitest run components/ai/use-capability-navigation.test.tsx -t "reveal: false"`
Expected: FAIL: first test gets `status: "focused"`.

- [ ] **Step 3: Implement `reveal`**

In `NavigateToCapabilityOptions`:

```ts
  /**
   * `false`: confirm the screen's anchor is live (proof the screen mounted) but leave
   * scroll and focus alone. Apply uses it: focus stays in the assistant panel and the
   * changed rows, not the screen's first control, are what is brought into view.
   * Omitted means reveal, as every help-tool call does today.
   */
  readonly reveal?: boolean;
```

Replace the final block (after `if (!authorized()) return revoked();` that precedes `revealAnchor`):

```ts
      if (!authorized()) return revoked();
      if (options.reveal === false) {
        return {
          status: "navigated",
          capabilityId,
          routeId: after.value.routeId,
          screenName: after.value.screenName,
          registry: after.stamp,
        };
      }
      const reveal = revealAnchor(lookup.element);
```

Run: `cd web && pnpm vitest run components/ai/use-capability-navigation.test.tsx`
Expected: PASS (all, including the existing suite).

- [ ] **Step 4: Carry the Preview's diff on the applied outcome**

`use-assistant-proposals.ts`:

```ts
import {
  describeProposalReadiness,
  type LiveProposalBasis,
  type ProposalDiff,
  type ProposalReadiness,
} from "@/lib/proposal";

export type ApplyOutcomeView =
  | {
      kind: "applied";
      receiptId: string;
      documentRevision: number;
      reloadRequired: boolean;
      /** The Preview's diff. Apply only commits against the basis the Preview was
       *  derived from, so this is what was written, split into direct and cascade
       *  (the receipt's summary merges the two). */
      diff: ProposalDiff;
    }
  | { kind: "failed"; message: string };
```

In `apply`: change the guard to `if (!proposalId || !proposal || applying) return;`, add `diff: proposal.diff,` to the `setOutcome({ kind: "applied", ... })` object, and add `proposal` to the `useCallback` dependency list.

- [ ] **Step 5: Write the failing notice tests**

`web/components/ai/apply-navigation-notice.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// The Apply notice: navigate to the screen owning most of the change, outline it,
// say so in a live region, and offer the other screens. Navigation is mocked here;
// the real hook is exercised end to end in apply-navigation.integration.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProposalDiff, ProposalDiffEntry, DiffScope } from "@/lib/proposal";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import {
  clearChangeHighlight,
  useChangeHighlightStore,
  useChangeTarget,
} from "@/lib/change-highlight/store";
import { useModeStore } from "@/lib/mode/mode";
import type { ApplyOutcomeView, AssistantProposalController } from "./use-assistant-proposals";
import { ApplyNavigationNotice } from "./apply-navigation-notice";

const navigate = vi.fn();
vi.mock("./use-capability-navigation", () => ({ useCapabilityNavigation: () => navigate }));

const entry = (key: string, scope: DiffScope): ProposalDiffEntry => ({
  key,
  scope,
  label: key,
  before: null,
  after: "x",
  kind: "created",
});

const DIFF: ProposalDiff = {
  direct: [
    entry('shift:"EVE"', "shift-types"),
    entry('shift:"LATE"', "shift-types"),
    entry('shift:"N2"', "shift-types"),
    entry('person:"cy"', "staff-list"),
  ],
  cascade: [],
  capabilityIds: ["shift-types", "staff-list"],
  needsReview: [],
};

function controller(outcome: ApplyOutcomeView | null): AssistantProposalController {
  return {
    proposal: null,
    readiness: null,
    applying: false,
    outcome,
    receipts: [],
    confirm: vi.fn(),
    withdraw: vi.fn(),
    revise: vi.fn(),
    cancel: vi.fn(),
    apply: vi.fn(),
    undo: vi.fn(),
    refresh: vi.fn(),
  };
}

const applied = (receiptId = "r1"): ApplyOutcomeView => ({
  kind: "applied",
  receiptId,
  documentRevision: 2,
  reloadRequired: false,
  diff: DIFF,
});

const highlighted = () => [...useChangeHighlightStore.getState().keys];

/** A screen row, as Task 3 renders one, so the scroll has a real target. */
function ChangedRow() {
  return <div {...useChangeTarget('shift:"EVE"')} />;
}
const arrived = (capabilityId: string) => ({
  status: "navigated",
  capabilityId,
  routeId: capabilityId,
  screenName: capabilityId,
  registry: { appBuildVersion: "t", manifestSha256: "t" },
});

beforeEach(() => {
  navigate.mockReset();
  navigate.mockImplementation(async (id: string) => arrived(id));
  useModeStore.setState({ mode: "advanced", adoption: "ready" });
});
afterEach(() => {
  cleanup();
  clearChangeHighlight();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
});

describe("ApplyNavigationNotice", () => {
  it("keeps an empty live region mounted before anything is applied", () => {
    render(<ApplyNavigationNotice controller={controller(null)} />);
    const status = screen.getByTestId("apply-navigation-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the primary screen without stealing focus, outlines it, and announces it", async () => {
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(
      <>
        <ChangedRow />
        <ApplyNavigationNotice controller={controller(applied())} />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
        "Opened Shift types. 3 shift types added.",
      ),
    );
    expect(navigate).toHaveBeenCalledWith("shift-types", { reveal: false });
    expect(highlighted()).toEqual(['shift:"EVE"', 'shift:"LATE"', 'shift:"N2"']);
    // Reduced motion: the scroll is never asked to be smooth.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
  });

  it("offers the other screens, and a link opens and outlines that one", async () => {
    const user = userEvent.setup();
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    const link = await screen.findByRole("button", { name: /Staff \(1 person added\)/ });
    expect(link).toHaveAttribute("data-capability-id", "staff-list");
    await user.click(link);
    await waitFor(() => expect(highlighted()).toEqual(['person:"cy"']));
    expect(navigate).toHaveBeenLastCalledWith("staff-list", { reveal: false });
    expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
      "Opened Staff. 1 person added.",
    );
  });

  it("stays put and offers a link when the user keeps their draft", async () => {
    navigate.mockResolvedValueOnce({
      status: CAPABILITY_UNAVAILABLE,
      reason: "navigation_cancelled",
      registry: { appBuildVersion: "t", manifestSha256: "t" },
    });
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() =>
      expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
        "Stayed here so your unsaved edit is kept. The change is on Shift types. 3 shift types added.",
      ),
    );
    expect(highlighted()).toEqual([]);
    expect(
      screen.getAllByTestId("apply-navigation-link").map((b) => b.getAttribute("data-capability-id")),
    ).toEqual(["shift-types", "staff-list"]);
  });

  it("navigates once per receipt, however often it re-renders", async () => {
    const view = render(<ApplyNavigationNotice controller={controller(applied())} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    view.rerender(<ApplyNavigationNotice controller={controller(applied())} />);
    await act(async () => {});
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("Done hides the notice but keeps the live region", async () => {
    const user = userEvent.setup();
    render(<ApplyNavigationNotice controller={controller(applied())} />);
    await user.click(await screen.findByTestId("apply-navigation-done"));
    expect(screen.queryByTestId("apply-navigation")).toBeNull();
    expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent("");
  });
});
```

- [ ] **Step 6: Run it and make sure that it fails**

Run: `cd web && pnpm vitest run components/ai/apply-navigation-notice.test.tsx`
Expected: FAIL: `Failed to resolve import "./apply-navigation-notice"`.

- [ ] **Step 7: Implement the notice**

`web/components/ai/apply-navigation-notice.tsx`:

```tsx
"use client";

// After Apply: open the screen that owns the change and point at what changed.
//
// HOST NARRATION, NOT A MODEL TURN. Everything here is the app's: the plan comes from
// the Preview's host-derived diff, the navigation is the host's guarded navigation,
// and the words are this file's. Asking the model to narrate would send a provider
// request the user did not make, about a result the model cannot observe.
//
// A SIBLING OF THE TRANSCRIPT, like the Preview and the receipts: it is live state
// with live buttons, so it is mounted only in the live conversation.
//
// FOCUS STAYS PUT. Navigation runs with `reveal: false`, so the destination's first
// control is not focused; the live region says what happened and the changed rows
// are scrolled into view instead. The scroll passes no `behavior`, so it is instant
// and honours prefers-reduced-motion without a check here.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import {
  planChangeHighlight,
  type ChangeHighlightPlan,
  type ChangeScreen,
} from "@/lib/change-highlight/plan";
import { CHANGE_HIGHLIGHT_SELECTOR, showChangeHighlight } from "@/lib/change-highlight/store";
import { readCapabilityContext } from "./capability-context";
import { useCapabilityNavigation } from "./use-capability-navigation";
import type { AssistantProposalController } from "./use-assistant-proposals";

export interface ApplyStep {
  screen: ChangeScreen;
  status: "opening" | "shown" | "stayed" | "failed";
}

export function describeStep({ screen, status }: ApplyStep): string {
  const what = screen.announcement ? ` ${screen.announcement}.` : "";
  switch (status) {
    case "opening":
      return `Opening ${screen.label}…`;
    case "shown":
      return `Opened ${screen.label}.${what}`;
    case "stayed":
      return `Stayed here so your unsaved edit is kept. The change is on ${screen.label}.${what}`;
    case "failed":
      return `${screen.label} could not be opened.${what}`;
  }
}

export function ApplyNavigationNotice({ controller }: { controller: AssistantProposalController }) {
  const navigate = useCapabilityNavigation();
  const [plan, setPlan] = useState<ChangeHighlightPlan | null>(null);
  const [step, setStep] = useState<ApplyStep | null>(null);
  const handled = useRef<string | null>(null);
  const { outcome } = controller;

  const show = useCallback(
    async (screen: ChangeScreen) => {
      setStep({ screen, status: "opening" });
      // The user's Apply (or link) click is its own authority, so no turn check. An
      // open unsaved draft still gets the shell's confirm, like a manual jump.
      const result = await navigate(screen.capabilityId, { reveal: false });
      if (result.status === CAPABILITY_UNAVAILABLE) {
        setStep({
          screen,
          status: result.reason === "navigation_cancelled" ? "stayed" : "failed",
        });
        return;
      }
      showChangeHighlight(screen.keys);
      // After the rows re-render with the attribute. The requests matrix scrolls its
      // own virtualizer; this covers every non-virtualized screen.
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(CHANGE_HIGHLIGHT_SELECTOR)
          ?.scrollIntoView?.({ block: "center" });
      });
      setStep({ screen, status: "shown" });
    },
    [navigate],
  );

  useEffect(() => {
    if (outcome?.kind !== "applied" || handled.current === outcome.receiptId) return;
    handled.current = outcome.receiptId;
    const next = planChangeHighlight(outcome.diff, readCapabilityContext().mode);
    setPlan(next);
    setStep(null);
    if (next.primary) void show(next.primary);
  }, [outcome, show]);

  // A new Preview replaces this notice; the user is reviewing the next change now.
  const visible = plan !== null && controller.proposal === null;
  const screens = plan ? [plan.primary, ...plan.others].filter((s): s is ChangeScreen => !!s) : [];
  const current = step && (step.status === "shown" || step.status === "opening") ? step : null;
  const links = screens.filter((s) => s.capabilityId !== current?.screen.capabilityId);

  return (
    <>
      {/* Always mounted: a region that appears with its text already inside is not
          reliably announced. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="apply-navigation-status">
        {visible && step ? describeStep(step) : ""}
      </p>
      {visible ? (
        <Surface
          level="well"
          geometry="control"
          className="mx-3 mb-2 flex shrink-0 flex-col gap-2 p-3"
          data-testid="apply-navigation"
          aria-label="Where the change is"
        >
          <ol className="flex flex-col gap-0.5 text-meta text-ink2">
            <li>Change applied.</li>
            {step ? <li data-testid="apply-navigation-step">{describeStep(step)}</li> : null}
          </ol>
          {links.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-meta text-ink3">Show changes on:</span>
              {links.map((screen) => (
                <Button
                  key={screen.capabilityId}
                  variant="outline"
                  size="sm"
                  data-testid="apply-navigation-link"
                  data-capability-id={screen.capabilityId}
                  onClick={() => void show(screen)}
                >
                  {screen.label} ({screen.announcement})
                </Button>
              ))}
            </div>
          ) : null}
          <div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="apply-navigation-done"
              onClick={() => setPlan(null)}
            >
              Done
            </Button>
          </div>
        </Surface>
      ) : null}
    </>
  );
}
```

(The `sr-only` utility exists: `roster-period-card.tsx:299` uses it.)

- [ ] **Step 8: Mount it in the live conversation**

`assistant-conversation.tsx`:

```tsx
import { ApplyNavigationNotice } from "./apply-navigation-notice";
// ...
      <AssistantReceipts controller={proposals} />
      <ApplyNavigationNotice controller={proposals} />
```

Mount it only in `AssistantLiveConversation`, never in `AssistantHistoricalConversation`.

Add to `web/components/ai/assistant-proposal.test.tsx`, in the describe block that renders both conversations (search for `AssistantHistoricalConversation`), one assertion each:

```tsx
    // live rendering:
    expect(screen.getByTestId("apply-navigation-status")).toBeInTheDocument();
    // historical rendering:
    expect(screen.queryByTestId("apply-navigation-status")).toBeNull();
```

- [ ] **Step 9: Tell the model where Apply goes**

`web/lib/ai/assistant/scenario-context.ts`, in `ASSISTANT_AUTHORITY_STATEMENT`, after the line that starts with `Never claim`:

```ts
  "When the user presses Apply, the app itself opens the screen that holds the change and outlines what changed; when you prepare a change, tell the user which screen that will be.",
```

`scenario-context.test.ts`, in "tells the model to propose supported changes…":

```ts
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/opens the screen that holds the change/);
```

- [ ] **Step 10: Run the AI suite, typecheck, lint**

Run: `cd web && pnpm vitest run components/ai lib/ai/assistant/scenario-context.test.ts && pnpm typecheck && pnpm run lint`
Expected: PASS. (`apply-navigation-notice.tsx` is under `components/ai`, so its `lib/change-highlight` imports point the allowed way.)

- [ ] **Step 11: Commit**

```bash
git add web/components/ai/use-capability-navigation.ts web/components/ai/use-capability-navigation.test.tsx web/components/ai/use-assistant-proposals.ts web/components/ai/apply-navigation-notice.tsx web/components/ai/apply-navigation-notice.test.tsx web/components/ai/assistant-conversation.tsx web/components/ai/assistant-proposal.test.tsx web/lib/ai/assistant/scenario-context.ts web/lib/ai/assistant/scenario-context.test.ts
git commit -m "feat(assistant): after Apply, open the changed screen, outline it, announce it"
```

---

### Task 7: Integration — Apply → navigate → highlight, end to end

**Files:**
- Create: `web/components/ai/apply-navigation.integration.test.tsx`

**Interfaces:**
- Consumes: everything above, unmocked except the Next router and `sonner`: real repository (`installTestAuthority`), real `ProposalPreviewCard`, real `useAssistantProposals`, real `useCapabilityNavigation` (with its nav guard), real `ShiftTypeGrid`.
- Produces: nothing new.

- [ ] **Step 1: Write the test**

```tsx
// @vitest-environment jsdom
//
// Apply → navigate → highlight, with nothing faked but the router and toasts.
// The router commits its URL LATE, like a real App Router transition, so this also
// proves the notice waits for arrival rather than highlighting on the screen it left.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { capabilityRegistryStamp } from "@/lib/capability/registry";
import { CAPABILITY_ANCHOR_ATTRIBUTE } from "@/lib/capability/anchor-contract";
import { clearChangeHighlight } from "@/lib/change-highlight/store";
import { proposalScenario } from "@/lib/proposal/test-support";
import { useModeStore } from "@/lib/mode/mode";
import { assistantProposalCommands } from "@/lib/store";
import { loadScenario } from "@/lib/store/lifecycle";
import { clearTestAuthority, installTestAuthority } from "@/lib/store/test-authority";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { ShiftTypeGrid } from "@/components/shift-types/shift-type-grid";
import { ProposalPreviewCard } from "./proposal-preview-card";
import { ApplyNavigationNotice } from "./apply-navigation-notice";
import { useAssistantProposals } from "./use-assistant-proposals";

const push = vi.fn((path: string) => {
  setTimeout(() => window.history.replaceState({}, "", path), 20);
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => window.location.pathname,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function Assistant() {
  const controller = useAssistantProposals();
  return (
    <>
      <ProposalPreviewCard controller={controller} />
      <ApplyNavigationNotice controller={controller} />
    </>
  );
}

beforeEach(async () => {
  push.mockClear();
  assistantActions.resetForTest();
  await installTestAuthority();
  await loadScenario(proposalScenario());
  useModeStore.setState({ mode: "guided", adoption: "ready" });
  window.history.replaceState({}, "", "/dates");
});

afterEach(() => {
  cleanup();
  clearTestAuthority();
  clearChangeHighlight();
  useModeStore.setState({ mode: "guided", adoption: "unhydrated" });
  window.history.replaceState({}, "", "/");
});

describe("Apply → navigate → highlight", () => {
  it("opens Shift types, outlines the new card, announces it, and leaves focus alone", async () => {
    const user = userEvent.setup();
    const prepared = await assistantProposalCommands.prepare({
      proposalId: crypto.randomUUID(),
      threadId: "thread-1",
      turnId: "turn-1",
      registryStamp: capabilityRegistryStamp(),
      commands: [
        {
          type: "add_shift_type",
          code: "EVE",
          name: "Evening",
          startTime: "14:00",
          endTime: "22:00",
          restMinutes: 0,
        },
      ],
      rationale: "You asked for an evening shift.",
      evidence: [],
      outcome: "untested",
    });
    if (!prepared.ok) throw new Error("fixture proposal was refused");
    assistantActions.showProposal(prepared.proposal.proposalId, useAssistantStore.getState().turnEpoch);

    render(
      <>
        <Assistant />
        <ShiftTypeGrid />
      </>,
    );

    const apply = await screen.findByTestId("proposal-apply");
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);

    await waitFor(() => expect(push.mock.calls[0]?.[0]).toBe("/shift-types"));
    const card = await screen.findByTestId("shift-card-string:EVE");
    await waitFor(() => expect(card).toHaveAttribute("data-change-highlight", "true"));
    expect(screen.getByTestId("shift-card-string:Day")).not.toHaveAttribute(
      "data-change-highlight",
    );
    expect(screen.getByTestId("apply-navigation-status")).toHaveTextContent(
      "Opened Shift types. 1 shift type added.",
    );
    // Apply does not move focus onto the Shifts screen's Add button.
    expect(document.activeElement?.getAttribute(CAPABILITY_ANCHOR_ATTRIBUTE)).not.toBe(
      "shift-types.add-shift-type",
    );
  });
});
```

(If `prepare` rejects `evidence: []`, copy the single `user_statement` evidence entry from `assistant-proposal.test.tsx:88`.)

- [ ] **Step 2: Run it**

Run: `cd web && pnpm vitest run components/ai/apply-navigation.integration.test.tsx`
Expected: PASS. For a failure on arrival, look at the `push` calls first. With no open draft, `dispatchNavIntent` commits at once. `use-capability-navigation.test.tsx` shows this without the shell mounted.

- [ ] **Step 3: Full gates**

Run: `cd web && pnpm vitest run && pnpm typecheck && pnpm run lint`
Expected: all PASS. The boundary proof is lint: no file outside `components/ai` / `lib/ai` imports them (`no-restricted-imports`, "AI IS OPTIONAL").

- [ ] **Step 4: Commit**

```bash
git add web/components/ai/apply-navigation.integration.test.tsx
git commit -m "test(assistant): Apply navigates to the owning screen and outlines the change"
```

---

## Decisions

1. **A neutral channel, `lib/change-highlight/`** (keys, plan, store), like `lib/optimize/run-request.ts`. Screens import only this channel. `.oxlintrc.json` does not change.
2. **The target id is the diff key**, rendered as `data-change-key`. There is no second id scheme. `keys.test.ts` pins parity with `diffScenarioDocuments`. `diff.ts` does not change, because sibling plans edit it the same day.
3. **React state, not DOM changes, for the highlight.** Rows read a zustand set through `useChangeTarget`. This survives re-renders. It also works for the virtualized requests matrix, which keeps off-screen rows out of the DOM.
4. **The primary screen has the most direct entries.** A tie goes to the earlier screen in set-up order. Cascade entries on the opened screen also get the outline. Each other screen that the change reached gets a button.
5. **Guided puts the five rule scopes on `rule-library`**, because the five rule screens are Advanced-only. The Guided row id `requirements:<uid>` maps one to one onto `rule:requirements:<uid>`.
6. **Derived entries point at the thing on screen.** `offrun:` and `available:` go to the person's matrix row. `binds:` and `narrowed:` go to the count rule. A removed entry gets an announcement but no outline. `export:layout` has no screen.
7. **The diff comes from the Preview, on the applied outcome.** The receipt summary merges direct and cascade entries, so it cannot pick the primary screen. Apply commits only against the basis of the Preview, so the two diffs are the same.
8. **`reveal: false` on host navigation.** The hook still finds the anchor, which proves that the screen mounted. It does not focus the first control of the destination. Focus stays in the panel.
9. **Accessibility.** A 3px inset outline in `var(--brand)` is a shape change (WCAG 1.4.1). The settle animation runs only under `prefers-reduced-motion: no-preference`. The scroll is instant. An `aria-live="polite"` status region, always mounted, says "Opened Shift types. 3 shift types added."
10. **The app writes the step text.** The model does not. A new sentence in the authority statement tells the model to name the screen that Apply opens. Apply does not start a model turn.
11. **The highlight lasts 5 s.** The next highlight clears it early (see the `ponytail:` note in `store.ts`).

## Open questions

1. **Must Apply start a model turn, so that the assistant streams its own text for each step?** Recommended: no. That sends a provider request that the user did not ask for, about a result that the model cannot see. The host steps and the new authority sentence (the Preview reply names the screen) cover the need. Look at this again only after users ask for it.
2. **Open the screen at once, or only after a "Show me" click?** Recommended: at once, as the bead says. The unsaved-draft guard keeps work in progress safe, and the notice keeps the other screens one click away.
3. **Keep the highlight until the user does something, instead of 5 s?** Recommended: 5 s. The notice keeps the text record. An outline that stays looks like a validation state.
4. **Scroll the requests matrix sideways to the changed column?** Recommended: not now (see the `ponytail:` note). Rows scroll into view, and the default window shows about two weeks. Add the column scroll after wide rosters hide changed days.
5. **Give the "Affects:" line of the receipt card the same "Show changes on" buttons?** Recommended: not in this bead. The notice covers the moment after Apply. File a follow-up bead after users ask to go back to old receipts.

## Assumptions

- `add_shift_type` is in the code (`web/lib/proposal/commands.ts:123`). The integration test uses it.
- With no open draft and no shell mounted, `dispatchNavIntent` commits at once. `use-capability-navigation.test.tsx` shows this today.
- `GuidedRuleConstraintKind` is the same union as `keyof CardsByKind` (the five kinds). Task 4 tells how to widen the type for a `tsc` error.
- In jsdom, the `scrollToIndex` of `@tanstack/react-virtual` reaches `HTMLElement.scrollTo`. Task 5 tells what to assert for a different pinned version.
- The `sr-only` utility exists (`components/dates/roster-period-card.tsx:299`).
- `var(--brand)` gives 3:1 contrast against the surfaces in each accent and theme, because focus rings already use the accent tokens. This plan does not measure it again.
