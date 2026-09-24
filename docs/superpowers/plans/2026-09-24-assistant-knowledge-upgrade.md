# Assistant Knowledge Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the Schedule assistant what the solver cannot do, how staffing numbers work, and how to behave on Singapore ward questions without inventing law, through help text, the authority statement, one tool description and the setup playbook.

**Architecture:** No new tools and no new code paths. Knowledge goes where the model already reads it: a new concept entry in the help registry (`help-content.ts`, served on demand by `explain_app_capability` and matched by `suggest_scheduling_rule`), sentences in existing help entries, five short lines in `ASSISTANT_AUTHORITY_STATEMENT` (sent every turn, so they stay short), the succession weight description in `commands.ts`, and `SETUP_STEPS.ask` hints in the playbook. Each change gets a unit test that pins the wording's key fact. Each behaviour is verified live by the eval cases in the eval pipeline spec §8.

**Tech Stack:** TypeScript, Vitest, zod 4. The capability manifest hash is regenerated with `pnpm capability:generate`.

**Spec:** `docs/research/2026-09-24-assistant/00-synthesis.md` (backlog ranks 2-10, knowledge gaps K1-K12) and `docs/superpowers/specs/2026-09-24-assistant-eval-pipeline.md` §8 (cases 10-20).

## Global Constraints

- Help text states what the CURRENT app does. No legal, clinical or MOH claim, no URL, no planned behaviour (`help-content.ts` header rule).
- The assistant never states a law, MOH/MOM rule, nurse ratio or rest-hour minimum as fact. Singapore facts in any text are phrased "many wards", never "the rule is".
- The `staffing-requirements` summary must not contain "at least" (pinned by `lib/proposal/commands.test.ts`) and must keep "nobody else may work" and "skill-mix".
- Never teach twin-shift skill mix (commits `3c6de87`, `b6f3786`). Skill-mix rules stay "not available yet" (bead 2ti).
- Out of scope: roster swaps (bead 73z), skill-mix rules (2ti), per-date override (2se), a host refusal of `infinity` on successions (backlog rank 11).
- Authority statement lines stay one sentence each where possible. The statement is sent on every hop.
- Bump `PLAYBOOK_VERSION` to `"2026-09-24.4"` when the playbook wording changes.
- Code style: 2 spaces, semicolons, double quotes, trailing commas.
- Do not commit unless the user asks. The commit steps are the commands to run on approval.

## Review Focus

1. **A policy phrased with different words** ("no more than five days on the trot", "at least 11 hours off between shifts"). Expected: `suggest_scheduling_rule` still returns `scheduler-limits` among its candidates. Test in Task 1 (three phrasings).
2. **The new concept entry shows up in a mode that hides it.** Expected: `scheduler-limits` is in both modes (it has no route), so `explain_app_capability` works in Guided. Test in Task 1 (`listCapabilities` in guided mode).
3. **A help edit that silently breaks a pinned fact** ("exact number", "nobody else may work", "skill-mix"). Expected: the existing `commands.test.ts` assertions still pass. Task 3 runs them.
4. **The model reads "prefer a finite weight" and stops using `-infinity` for the hard N→Day forbid.** Expected: the description still says `-infinity` means never. Test in Task 4.
5. **The authority statement grows past its purpose.** Expected: each new line is under 45 words. Test in Task 2.

---

## File map

| File | Change |
|---|---|
| `web/lib/capability/help-content.ts` | New entry `scheduler-limits`. Sentences added to `roster-period`, `staffing-requirements`, `shift-successions`, `shift-counts`, `generate-roster` |
| `web/lib/capability/help-content.test.ts` | New. Pins the key facts in help text |
| `web/lib/capability/guidance.test.ts` | Limit phrasings match `scheduler-limits` |
| `web/lib/capability/registry.generated.ts` | Regenerated |
| `web/lib/ai/assistant/scenario-context.ts` | Five authority lines |
| `web/lib/ai/assistant/scenario-context.test.ts` | Pins the five lines |
| `web/lib/proposal/commands.ts` | Succession-specific weight description |
| `web/lib/proposal/commands.test.ts` | Pins it |
| `web/lib/ai/assistant/playbook.ts` | `SETUP_STEPS.ask` hints for `shiftTypes` and `rules`. Version bump |
| `web/lib/ai/assistant/playbook.test.ts` | Pins the hints |

---

### Task 1: The `scheduler-limits` help entry

**Files:**
- Modify: `web/lib/capability/help-content.ts` (add one entry after `hard-and-soft-rules`, line ~112), `web/lib/capability/guidance.test.ts`, `web/lib/capability/registry.generated.ts` (regenerated)
- Create: `web/lib/capability/help-content.test.ts`

**Interfaces:**
- Produces: capability id `"scheduler-limits"` (joins the `CapabilityId` union). Task 2 names it in the authority statement.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/capability/guidance.test.ts` inside `describe("rule guidance", ...)`:

```ts
  it.each([
    "nobody works more than 5 consecutive days, any shift",
    "at least 11 hours rest between shifts",
    "balance nights with last month's roster",
  ])("points %s at what the scheduler cannot do", (policy) => {
    const result = suggestRuleCandidates(policy, context());
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value.map((c) => c.capabilityId)).toContain("scheduler-limits");
  });
```

Create `web/lib/capability/help-content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CAPABILITY_ENTRIES } from "./help-content";
import { listCapabilities } from "./resolve";

const summary = (id: string) => CAPABILITY_ENTRIES.find((e) => e.id === id)?.nurseFacingSummary ?? "";

describe("what the scheduler cannot do (scheduler-limits)", () => {
  const text = summary("scheduler-limits");

  it("says it does not read clock times or hours between shifts", () => {
    expect(text).toMatch(/clock times/);
    expect(text).toMatch(/between shifts/);
  });
  it("says mixed-shift runs need a weekly working-day limit too", () => {
    expect(text).toMatch(/in a row/);
    expect(text).toMatch(/per week/);
  });
  it("says limits use fixed dates, not a rolling window", () => {
    expect(text).toMatch(/rolling/);
  });
  it("says it remembers nothing from earlier rosters, owed days included", () => {
    expect(text).toMatch(/one roster period at a time/);
    expect(text).toMatch(/public holiday/);
  });
  it("says it checks no law or policy, without stating any law", () => {
    expect(text).toMatch(/checks no employment law/);
    expect(text).not.toMatch(/\d+\s*hours? (of )?rest/i);
    expect(text).not.toMatch(/ratio of|1:\d/);
  });
  it("is served in both modes", () => {
    for (const mode of ["guided", "advanced"] as const) {
      const listed = listCapabilities({ mode, modeResolved: true, gates: [] });
      if (listed.status !== "ok") throw new Error("expected ok");
      expect(listed.value.map((c) => c.id)).toContain("scheduler-limits");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && pnpm vitest run lib/capability/help-content.test.ts lib/capability/guidance.test.ts`
Expected: FAIL. `scheduler-limits` is not an entry.

- [ ] **Step 3: Add the entry**

In `web/lib/capability/help-content.ts`, add a tool list after `CONCEPT_TOOLS` (line ~29):

```ts
/** A concept a described policy can land on: describe it, and let rule guidance find it. */
const LIMIT_TOOLS = [...CONCEPT_TOOLS, "suggest_scheduling_rule"] as const;
```

Add this entry right after the `hard-and-soft-rules` entry:

```ts
  {
    id: "scheduler-limits",
    title: "What the scheduler cannot do",
    nurseFacingSummary:
      "The scheduler does not read clock times. It never works out overlaps or the hours " +
      "between shifts, so rest between shifts is written as shift orders it must not use, " +
      "such as no day shift straight after a night. It cannot count days in a row across " +
      "different shifts: a shift-order rule matches only that exact pattern, so add a limit " +
      "on working days per week as well. Limits count over fixed dates, never a rolling " +
      "seven days. It plans one roster period at a time and remembers nothing from earlier " +
      "rosters: not last month's nights or weekends, and not a day off owed for a public " +
      "holiday. It checks no employment law, ministry guidance or hospital policy, only the " +
      "rules written here.",
    concepts: [
      "limits",
      "days in a row",
      "consecutive days",
      "rolling window",
      "hours between shifts",
      "rest hours",
      "clock time",
      "overlap",
      "last month",
      "carry over",
      "owed day",
      "day in lieu",
      "law",
      "ratio",
    ],
    modes: BOTH_MODES,
    featureGates: [],
    toolAccess: LIMIT_TOOLS,
    supportedCommands: [],
  },
```

- [ ] **Step 4: Regenerate the manifest and run the tests**

Run: `cd web && pnpm capability:generate && pnpm vitest run lib/capability`
Expected: PASS. If `build-manifest` validation rejects `suggest_scheduling_rule` on an entry without a route, read `validateCapabilitySources` in `web/lib/capability/build-manifest.ts` (line ~154) and follow the rule it states. The guidance tool needs no route, so the likely fix is none. If the stemmer misses a phrasing in the `it.each`, add the missing word from `matchedTerms` to `concepts`, not to the test.

- [ ] **Step 5: Review the manifest diff and commit**

Run: `git diff web/lib/capability/registry.generated.ts`
Expected: only the hash, entry count (+1) and byte length change.

```bash
git add web/lib/capability/help-content.ts web/lib/capability/help-content.test.ts web/lib/capability/guidance.test.ts web/lib/capability/registry.generated.ts
git commit -m "feat(assistant): scheduler-limits help entry (clock time, runs, rolling, memory, law)"
```

---

### Task 2: Five authority lines

**Files:**
- Modify: `web/lib/ai/assistant/scenario-context.ts` (`ASSISTANT_AUTHORITY_STATEMENT`, insert before the line "The people you help are nurses and nurse managers, not technical users.")
- Test: `web/lib/ai/assistant/scenario-context.test.ts`

**Interfaces:**
- Consumes: capability id `scheduler-limits` (Task 1)
- Produces: exported constant `KNOWLEDGE_LINES: readonly string[]`, joined into `ASSISTANT_AUTHORITY_STATEMENT`

- [ ] **Step 1: Write the failing test**

Append to `web/lib/ai/assistant/scenario-context.test.ts`:

```ts
describe("what the assistant knows about the ward and the solver", () => {
  it("is not a source of law, and hands the rule back to the ward", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/not a source of law or policy/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/ward decides/);
  });
  it("says a staffing number is exact and where the preferred count lives", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/exact, not a minimum/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/Staffing requirements screen/);
  });
  it("checks the limits before promising a rule", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/explain_app_capability/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/scheduler-limits/);
  });
  it("warns that a new run can change everyone's shifts", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/change everyone's shifts/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/Roster screen/);
  });
  it("leaves a same-day-off clash to the manager", () => {
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/never decide it yourself/);
  });
  it("keeps every knowledge line short", () => {
    for (const line of KNOWLEDGE_LINES) expect(line.split(/\s+/).length, line).toBeLessThan(45);
  });
});
```

Add `KNOWLEDGE_LINES` to the file's import from `./scenario-context`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts`
Expected: FAIL, `KNOWLEDGE_LINES` is not exported.

- [ ] **Step 3: Add the lines**

In `web/lib/ai/assistant/scenario-context.ts`, above `ASSISTANT_AUTHORITY_STATEMENT`:

```ts
/**
 * What the model must know about wards and the solver on EVERY turn (2026-09-24
 * knowledge upgrade, backlog ranks 2, 4, 6, 10). Longer explanations live in the help
 * registry (`scheduler-limits` and the rule entries) and are read on demand.
 */
export const KNOWLEDGE_LINES: readonly string[] = [
  "You are not a source of law or policy: never state an employment law, ministry rule, nurse ratio or minimum rest time as fact; say the ward decides, and offer to set up the ward's own rule.",
  "A staffing number is exact, not a minimum: for 'at least 2, ideally 3', prepare 2 and say the preferred 3 is set on the Staffing requirements screen.",
  "Before promising a rule, make sure the app can express it; when unsure, read explain_app_capability for scheduler-limits and say plainly what it cannot do.",
  "A new optimiser run can change everyone's shifts: for one change to a roster staff already have, such as a nurse on MC, say so and point to hand edits on the Roster screen before offering a run.",
  "When two people want the same day off and only one can go, offer the manager the choice with offer_choices; never decide it yourself.",
];
```

Then in the `ASSISTANT_AUTHORITY_STATEMENT` array, insert `...KNOWLEDGE_LINES,` directly before `"The people you help are nurses and nurse managers, not technical users.",`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts components/ai`
Expected: PASS. The `components/ai` run checks nothing else pins the statement's exact length.

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/assistant/scenario-context.ts web/lib/ai/assistant/scenario-context.test.ts
git commit -m "feat(assistant): no-law line, exact counts, limits check, re-run warning, same-day tie-break"
```

---

### Task 3: Sentences in the existing help entries

**Files:**
- Modify: `web/lib/capability/help-content.ts` (entries `roster-period`, `staffing-requirements`, `shift-successions`, `shift-counts`, `generate-roster`), `web/lib/capability/registry.generated.ts`
- Test: `web/lib/capability/help-content.test.ts`

**Interfaces:**
- Consumes: the file from Task 1
- Produces: nothing new. Wording only.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/capability/help-content.test.ts`:

```ts
describe("the rule entries carry the solver facts", () => {
  it("staffing: exact, the preferred count on this screen, one shift code per group", () => {
    const text = summary("staffing-requirements");
    expect(text).toMatch(/preferred number is set here/);
    expect(text).toMatch(/separate shift code/);
    expect(text).not.toMatch(/at least/i);
    expect(text).toContain("nobody else may work");
    expect(text).toContain("skill-mix");
  });
  it("successions: exact pattern only; a must-follow is risky", () => {
    const text = summary("shift-successions");
    expect(text).toMatch(/exact pattern/);
    expect(text).toMatch(/must follow/);
  });
  it("counts: a balance rule spreads nights and weekends", () => {
    const text = summary("shift-counts");
    expect(text).toMatch(/as close to/);
    expect(text).toMatch(/same few people/);
  });
  it("generate-roster: score, not proven best, and re-runs", () => {
    const text = summary("generate-roster");
    expect(text).toMatch(/score/);
    expect(text).toMatch(/not proven/);
    expect(text).toMatch(/different roster/);
  });
  it("roster-period: holiday groups need the import", () => {
    expect(summary("roster-period")).toMatch(/empty until/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm vitest run lib/capability/help-content.test.ts`
Expected: FAIL on the five new tests.

- [ ] **Step 3: Edit the five summaries**

Append each sentence to the end of the entry's `nurseFacingSummary` (add a `" " +` join):

`roster-period`:
```ts
      " Public holiday and workday groups stay empty until the public holidays are imported."
```

`staffing-requirements`:
```ts
      " For a number with a preferred extra (2, ideally 3), the preferred number is set here. " +
      "Two different groups named as the only people for the same shift block each other, so " +
      "each ward or team needs a separate shift code."
```

`shift-successions`:
```ts
      " A rule matches only its exact pattern of shifts. Use 'must never' to forbid a pattern; " +
      "making a pattern one people must follow can make a workable roster impossible, so use a " +
      "strong preference instead."
```

`shift-counts`:
```ts
      " A balance rule keeps each person's count as close to a target as it can. Without one, " +
      "the optimiser may give most nights or weekends to the same few people."
```

`generate-roster`:
```ts
      " The score only compares rosters for this same set-up. A roster that is valid but not " +
      "proven best is still usable. Running again can give a different roster that is just as " +
      "good, and it can change anyone's shifts."
```

- [ ] **Step 4: Regenerate and run every pinned test**

Run: `cd web && pnpm capability:generate && pnpm vitest run lib/capability lib/proposal/commands.test.ts`
Expected: PASS, including the existing "exact number", "nobody else may work" and "skill-mix" assertions in `commands.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add web/lib/capability/help-content.ts web/lib/capability/help-content.test.ts web/lib/capability/registry.generated.ts
git commit -m "feat(assistant): help text states exact counts, patterns, balance, score, PH import"
```

---

### Task 4: Succession weight description

**Files:**
- Modify: `web/lib/proposal/commands.ts` (`successionFields`, line ~416)
- Test: `web/lib/proposal/commands.test.ts`

**Interfaces:**
- Produces: `function successionWeightSchema()` (module-private), used by `successionFields().weight`

- [ ] **Step 1: Write the failing test**

Add inside `describe("the rule arms' text states what the solver enforces", ...)` in `web/lib/proposal/commands.test.ts`:

```ts
  it("a succession's weight: -infinity forbids, a must-follow is steered to a finite weight", () => {
    const weight = arm("add_succession_rule").weight.description ?? "";
    expect(weight).toContain('"-infinity" = must never happen');
    expect(weight).toContain("impossible");
    expect(weight).toMatch(/"10"/);
    expect(arm("add_count_rule").weight.description).not.toContain("impossible");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm vitest run lib/proposal/commands.test.ts`
Expected: FAIL, the description does not contain "impossible".

- [ ] **Step 3: Add the succession-specific description**

In `web/lib/proposal/commands.ts`, after `countWeightSchema()`:

```ts
function successionWeightSchema() {
  return z
    .string()
    .describe(
      'How strongly, written as you would type it in the Weight box: "-infinity" = must ' +
        'never happen (hard rule, the usual choice for a forbidden order such as a day ' +
        'straight after a night), a negative number such as "-50" discourages, a positive ' +
        'number such as "10" encourages (for example a day off after nights). Avoid ' +
        '"infinity" (must always follow): with other hard rules it can make a roster ' +
        "impossible that would otherwise work; use a positive number instead. The schedule " +
        "shows hard weights as .inf / -.inf: send them as infinity / -infinity. Ask the user " +
        "whether a new rule is a must or a preference when they did not say.",
    );
}
```

In `successionFields()`, change `weight: ruleWeightSchema(),` to `weight: successionWeightSchema(),`.

- [ ] **Step 4: Run tests, including the tool-schema set test**

Run: `cd web && pnpm vitest run lib/proposal lib/ai/runtime/model-visible-tools.test.ts components/ai`
Expected: PASS. The set test proves the schema still converts through the locked CopilotKit boundary.

- [ ] **Step 5: Commit**

```bash
git add web/lib/proposal/commands.ts web/lib/proposal/commands.test.ts
git commit -m "feat(assistant): steer successions away from hard must-follow weights"
```

---

### Task 5: Setup hints for shifts and rules

**Files:**
- Modify: `web/lib/ai/assistant/playbook.ts` (`PLAYBOOK_VERSION`, `SETUP_STEPS` entries `shiftTypes` and `rules`)
- Test: `web/lib/ai/assistant/playbook.test.ts`

**Interfaces:**
- Produces: `PLAYBOOK_VERSION = "2026-09-24.4"`

- [ ] **Step 1: Write the failing test**

Append to `web/lib/ai/assistant/playbook.test.ts`:

```ts
describe("setup hints carry ward defaults, never law", () => {
  const ask = (id: string) => SETUP_STEPS.find((s) => s.id === id)?.ask.join(" ") ?? "";

  it("suggests common shift patterns to confirm", () => {
    expect(ask("shiftTypes")).toMatch(/three 8-hour shifts/);
    expect(ask("shiftTypes")).toMatch(/12-hour/);
  });
  it("suggests the usual rest and fairness rules, with off-after-nights as a preference", () => {
    const text = ask("rules");
    expect(text).toMatch(/no day shift straight after a night as a must/);
    expect(text).toMatch(/day off after nights as a preference/);
    expect(text).toMatch(/balance/);
  });
  it("frames ward habits as habits, not law", () => {
    const text = ask("rules");
    expect(text).toMatch(/many wards/i);
    expect(text).not.toMatch(/\b(law|MOH|MOM|required by)\b/);
  });
  it("was versioned", () => {
    expect(PLAYBOOK_VERSION).toBe("2026-09-24.4");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && pnpm vitest run lib/ai/assistant/playbook.test.ts`
Expected: FAIL on the four new tests.

- [ ] **Step 3: Edit the playbook**

In `web/lib/ai/assistant/playbook.ts` set `export const PLAYBOOK_VERSION = "2026-09-24.4";`.

Replace the `shiftTypes` step's `ask` with:

```ts
    ask: [
      "Each shift's code, start time and end time. Suggest the unpaid break; do not ask for it.",
      "If the user is unsure, suggest a common pattern to confirm: three 8-hour shifts (morning, afternoon, night) or 12-hour day and night shifts.",
    ],
```

Replace the `rules` step's `ask` with:

```ts
    ask: [
      "How many nurses each shift needs, and how many of them must be from a group such as RNs.",
      "The rest rules the ward uses. Many wards use no day shift straight after a night as a must, and a day off after nights as a preference.",
      "Limits such as the most nights one nurse may work in the period, and whether to balance nights and weekends across the team.",
      "Many wards also keep at least one rest day a week; suggest it as a ward habit to confirm.",
    ],
```

- [ ] **Step 4: Run tests**

Run: `cd web && pnpm vitest run lib/ai/assistant`
Expected: PASS (existing playbook and repair tests included).

- [ ] **Step 5: Commit**

```bash
git add web/lib/ai/assistant/playbook.ts web/lib/ai/assistant/playbook.test.ts
git commit -m "feat(assistant): setup suggests common shift patterns, rest and balance rules"
```

---

### Task 6: Verify live with the eval cases

Depends on the eval pipeline plan (`docs/superpowers/plans/2026-09-24-assistant-eval-pipeline.md`) through its Task 10. If the pipeline has not landed yet, stop after Task 5 and leave this task open.

**Files:**
- Modify: none, unless a case shows the wording needs a change (then the relevant file from Tasks 1-5, with its test updated first)

- [ ] **Step 1: Run the full quality gate**

Run: `cd web && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 2: Run the knowledge cases, 3 trials**

Run: `cd web && OPENROUTER_API_KEY=... EVAL_TRIALS=3 pnpm vitest run -c vitest.eval.config.ts evals/flows.eval.ts evals/singapore.eval.ts`
Expected: report at `web/evals/runs/latest/report.md`. Target: pass^3 = 1 for cases 10-20 (`flow-b-shared-shift`, `limit-consecutive-days`, `exact-vs-preferred`, `off-after-nights`, `sg-moh-rest-rule`, `sg-ratio`, `sg-fair-nights`, `sg-ph-in-lieu`, `sg-mc-cover`, `sg-nic-per-shift`, `sg-same-day-off`), and no regression against `evals/baseline.json` in any other case.

- [ ] **Step 3: Iterate on wording, not on cases**

For each failing case, read its transcript. If the model lacked the fact, tighten the wording in the owning file (Tasks 1-5), update that task's test first, and re-run only that case (`-t <case id>`). If a judge claim is unfair to a correct answer, fix the claim in the case file and say so in the commit message. Stop after two wording rounds per case.

- [ ] **Step 4: Run the whole suite and promote the baseline**

Run: `cd web && OPENROUTER_API_KEY=... pnpm eval:baseline`
Expected: no case flagged REGRESSION. The safety failures column is 0.

- [ ] **Step 5: File what is left**

For each case still below pass^3 = 1:

```bash
bd create "Assistant knowledge: <case id> below pass^3" -t task -p 2 --description "<gate or judge item that fails, one transcript excerpt>"
```

- [ ] **Step 6: Commit**

```bash
git add web/evals/baseline.json
git commit -m "chore(evals): baseline after the knowledge upgrade"
```

---

## Self-review notes

- Backlog coverage: rank 2 (T2 line 1), rank 3 (T1, T2 line 3), rank 4 (T2 line 2, T3 staffing), rank 5 (T4, T3 successions), rank 6 (T2 line 4, T3 generate-roster), rank 7 (T3 counts, T5 rules hint), rank 8 (T1 memory sentence, T3 roster-period), rank 9 (T5), rank 10 (T2 line 5).
- K1-K12: K1 T2/T3, K2-K5 T1, K6 T3, K7 T4, K8 T3, K9 T1/T2, K10 T3/T5, K11 T3, K12 unchanged (already true, verified by `sg-nic-per-shift`).
- Review Focus tests: 1 → T1 `it.each`; 2 → T1 "served in both modes"; 3 → T3 step 4 runs `commands.test.ts`; 4 → T4 asserts `-infinity` wording; 5 → T2 word-count test.
