# 2vtv: assistant adds a nurse to staff, then re-Optimizes (Implementation Plan)

Confidence: 8.3/10

I read every seam this plan touches: `repair-options.ts` (builders, `violatesSafetyFloor`, `isSafeOption`), `playbook.ts`, `use-optimize-tools.ts`, `use-assistant-follow-ups.ts` and the test that proves an add_person Apply opens Staff. The lifecycle the bead asks for (propose, Apply, offer a run, report) already exists end to end. This plan adds one repair option and two lines of model guidance, and its tests are all pure. What lowers the score: model behaviour (whether it really offers the run after the Apply follow-up) is only steered by wording, and no test drives a real model. The static check in `findStaffingShortfalls` also has to agree that a groupless new nurse closes a head-count gap. I have not run it on `SCENARIOS.tooFewNurses`. Task 1's test proves it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can offer "add a nurse to the staff list" for a schedule that is short on many days. After the user Applies it, the assistant offers an Optimize run (the user presses Run) and says plainly whether the schedule can now be built.

**Architecture:** This needs no new tool and no new UI. It adds a new playbook repair `add_staff_member`, built by `repair-options.ts`. That repair emits `add_person` operations with a placeholder name. The existing Preview → Apply path already applies them on the Staff screen (bead iwo, `apply-navigation-staff.integration.test.tsx`). After the Apply, `use-assistant-follow-ups.ts` already sends "I applied it: …". A new `FEASIBILITY_INSTRUCTIONS` line tells the model to answer with `request_optimize_run`. That card already refuses to start anything without the user's Run click. The existing run-finished follow-up and `get_optimize_result` then report the outcome, and their guidance gains one plain sentence: "The schedule can be built now".

**Tech Stack:** TypeScript, Vitest, Oxlint, ast-grep, oxfmt.

**Spec:** bead `nursing-sheduler-2vtv` (user decision 2026-09-26, agent-native order ending "start Optimize run, user-confirmed"). Memories: `agent-native-goal`, `assistant-apply-navigates`, `temporary-nurse-concept`, `minor-decisions-delegated`.

## Scope boundary (read first)

- **Borrowed nurses are already done.** Temporary cover (d582, merged `dacbc04`) is a staffing credit, not a person. The `borrow_temporary_nurse` repair books it, and `prepare_borrowed_cover` asks for a run after it (`use-roster-tools.ts` ~805). This plan does not touch that path.
- **2vtv is a regular staff member.** She is a real solver person on the staff list for the whole period: a new starter, a transfer, or a relief nurse put on the roster. The operation is `add_person` (people ops, plan `2026-09-24-assistant-people-ops.md`). Its Apply already opens Staff and highlights the new row.
- **The run lifecycle is not rebuilt.** `request_optimize_run` (card, user presses Run), `get_optimize_result`, and the run-finished follow-up (`describeFinishedRun`) all exist and are tested. This plan only steers the model to use them after an `add_staff_member` Apply, and makes the success wording plain.

## Global Constraints

- **Branch.** From `/home/kenan/work/nursing-sheduler`, run `wt switch --create feat/2vtv-add-staff-reoptimize --base develop --no-cd`. The worktree is `/home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize` (`$WT`). Do not push. Merging to `develop` needs the user's approval.
- **Web gate, before every commit** (from `$WT/web`): `pnpm vitest run <focused files>`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
- **Library-first testing (repo CLAUDE.md).** Only pure Vitest tests are used here. No new parser and no filesystem reads.
- **Never start a run.** No code path added here calls the Optimize screen's submit. Only `request_optimize_run` (a card) is named. `web/lib/ai/phase-2-absence.test.ts` must pass unchanged.
- **Never invent a name.** Options use the placeholder `New nurse N`, and the model asks the user for the real name before preparing (`needsFromUser`).
- **Commits:** short conventional messages ending `(2vtv)`. Track work with `bd`: `bd update nursing-sheduler-2vtv --claim` first, `bd close` at the end.

## Decisions taken (minor, delegated)

- **Option title:** `Add a nurse to the staff list for the whole period (a new starter, a transfer or a relief nurse)`. With 2 nurses the title reads `Add 2 nurses …`.
- **When it is offered:** only in the `chronic` situation (more than `CHRONIC_DATE_COUNT` = 3 short days), after `borrow_temporary_nurse` and before `run_one_short`. A few bad days are cover problems. A shortage spread over most of the period is a staffing problem.
- **Head-count gaps only.** The builder returns null for a skill-mix gap. A new nurse's qualification is the manager's call, and the borrow option already handles skill-group gaps with the manager's word. On the user's request, the model can still put the nurse in a group through `prepare_scenario_change` (`add_person.groups`).
- **At most 2 new nurses** (`MAX_NEW_STAFF = 2`). A bigger gap is a recruitment conversation, not a one-click fix.
- **Confirmation** is `manager`, enforced by `apply`: the Apply press is the manager's decision, and no host question is needed.
- **Success wording** in `get_optimize_result` guidance: `The schedule can be built now: a roster was produced.`

## Review Focus

- A chronic head-count shortage (`SCENARIOS.tooFewNurses`) offers `add_staff_member`, and applying its operations clears `findStaffingShortfalls`.
- A skill-mix shortage (`SCENARIOS.onlyRnOnLeave`, `rnMixOnLeave`) never offers it: a groupless nurse cannot fill an RN gap.
- `isSafeOption` still refuses a borrowed-person `add_person` without `lending_ward`. The allowlist widens for `add_staff_member` with `groups: []` only.
- `test_feasibility_candidates` accepts `New nurse 1` as a placeholder (the safety floor's `PLACEHOLDER`), but still refuses a model-written real name, as the floor does today.
- The acute and capped orders are unchanged, so a one-day gap is never answered with "hire someone".

---

### Task 1: The `add_staff_member` repair

**Files:**
- Modify: `web/lib/ai/assistant/playbook.ts` (`RepairId`, `REPAIRS`, `REPAIR_ORDER.chronic`, new `MAX_NEW_STAFF`, `PLAYBOOK_VERSION`)
- Modify: `web/lib/ai/assistant/repair-options.ts` (`PLACEHOLDER` ~line 113, new builder `addStaffMember` after `borrowTemporaryNurse` ~line 648, `BUILDERS` ~line 875, `isSafeOption` `add_person` case ~line 1221)
- Modify: `web/components/ai/use-feasibility-tools.ts` (tool description)
- Test: `web/lib/ai/assistant/repair-options.test.ts`, `web/lib/ai/assistant/playbook.test.ts`

**Interfaces:**
- Produces: `RepairId` gains `"add_staff_member"`. `MAX_NEW_STAFF = 2` is exported from `playbook.ts`. Options carry `operations: { type: "add_person"; name: "New nurse <n>"; groups: [] }[]`.

- [ ] **Step 1: Write the failing tests** (append to `repair-options.test.ts`, which already imports `SCENARIOS`, `rank`, `isSafeOption`, `applyAssistantCommands`, `findStaffingShortfalls`, `violatesSafetyFloor`):

```ts
describe("add a nurse to the staff list (bead 2vtv)", () => {
  it("offers a new staff member for a chronic head-count shortage, and it closes the gap", () => {
    const state = SCENARIOS.tooFewNurses();
    const add = rank(state).find((o) => o.repairId === "add_staff_member");
    expect(add).toMatchObject({
      confirmation: "manager",
      enforcedBy: "apply",
      capabilityId: "staff-list",
      evidence: "static_check",
      operations: [{ type: "add_person", name: "New nurse 1", groups: [] }],
    });
    expect(add!.title).toMatch(/^Add a nurse to the staff list for the whole period/);
    expect(add!.needsFromUser.join(" ")).toMatch(/name/);
    expect(isSafeOption(state, add!)).toBe(true);
    const after = applyAssistantCommands(state, add!.operations);
    if (!after.ok) throw new Error(after.rejection.message);
    expect(findStaffingShortfalls(after.next)).toEqual([]);
  });

  it("is never offered for a skill-mix gap or a short bad day", () => {
    for (const make of [SCENARIOS.onlyRnOnLeave, SCENARIOS.rnMixOnLeave, SCENARIOS.shortOnLeaveDay]) {
      expect(rank(make()).map((o) => o.repairId)).not.toContain("add_staff_member");
    }
  });

  it("refuses a new staff member in a group, and a borrowed person without a lending ward", () => {
    const state = SCENARIOS.tooFewNurses();
    const add = rank(state).find((o) => o.repairId === "add_staff_member")!;
    const grouped = {
      ...add,
      operations: [{ type: "add_person" as const, name: "New nurse 1", groups: ["RN"] }],
    };
    expect(isSafeOption(state, grouped)).toBe(false);
    expect(isSafeOption(state, { ...add, repairId: "relax_count_rule" })).toBe(false);
  });

  it("lets a candidate test the placeholder but not an invented name", () => {
    const state = SCENARIOS.tooFewNurses();
    const op = (name: string) => [{ type: "add_person" as const, name, groups: [] }];
    expect(violatesSafetyFloor(state, op("New nurse 1"), { leaveAsked: true })).toBeNull();
    expect(violatesSafetyFloor(state, op("Siti Rahman"), { leaveAsked: true })).not.toBeNull();
  });
});
```

Also add to `playbook.test.ts`, inside `describe("repair catalogue")`:

```ts
it("adds a regular staff member only for a chronic shortage, as the manager's Apply", () => {
  const add = REPAIRS.find((repair) => repair.id === "add_staff_member")!;
  expect(add).toMatchObject({ confirmation: "manager", enforcedBy: "apply", opTypes: ["add_person"] });
  expect(REPAIR_ORDER.chronic).toEqual([
    "align_overlapping_requirements",
    "borrow_temporary_nurse",
    "add_staff_member",
    "run_one_short",
    "split_long_shift",
  ]);
  for (const situation of ["capped", "acute", "unexplained"] as const) {
    expect(REPAIR_ORDER[situation]).not.toContain("add_staff_member");
  }
});
```

Change the existing `it("was versioned")` expectation to `"2026-09-27.2"`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize/web && pnpm vitest run lib/ai/assistant/repair-options.test.ts lib/ai/assistant/playbook.test.ts`
Expected: FAIL. `add_staff_member` is not a repair, and the version is still `2026-09-27.1`.

- [ ] **Step 3: Implement the playbook entry** (`playbook.ts`)

```ts
export const PLAYBOOK_VERSION = "2026-09-27.2";
```

Add `| "add_staff_member"` to `RepairId`. Add `export const MAX_NEW_STAFF = 2;` next to `MAX_BORROWED`. Insert this into `REPAIRS` right after the `borrow_temporary_nurse` entry:

```ts
  {
    // bead 2vtv: a real staff member for the whole period, not a cover. The manager's
    // Apply is the decision; the Staff screen shows the new row (iwo).
    id: "add_staff_member",
    title: "Add a nurse to the staff list for the whole period",
    whenToUse:
      "The ward is short on many days of the period, not just a bad day: a new starter, a transfer or a relief nurse on the roster.",
    disruption: "medium",
    confirmation: "manager",
    enforcedBy: "apply",
    opTypes: ["add_person"],
    guardrail:
      "Head count only: put her in a staff group only when the manager names it. Ask for her name; never invent one.",
  },
```

Change `REPAIR_ORDER.chronic` to:

```ts
  chronic: [
    "align_overlapping_requirements",
    "borrow_temporary_nurse",
    "add_staff_member",
    "run_one_short",
    "split_long_shift",
  ],
```

- [ ] **Step 4: Implement the builder and the allowlist** (`repair-options.ts`)

Add `MAX_NEW_STAFF` to the `./playbook` import. Widen the placeholder:

```ts
const PLACEHOLDER = /^(Borrowed|New) nurse \d+$/;
```

Add after `borrowTemporaryNurse`:

```ts
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
  return makeOption("add_staff_member", {
    title: `Add ${who} to the staff list for the whole period (a new starter, a transfer or a relief nurse)`,
    why: `${short.length} days are short by up to ${count} ${count === 1 ? "nurse" : "nurses"} even with everyone free working. A nurse on the staff list can be rostered on any of them.`,
    operations: Array.from(
      { length: count },
      (_, index): AssistantCommandV1 => ({
        type: "add_person",
        name: `New nurse ${index + 1}`,
        groups: [],
      }),
    ),
    confirmationQuestion: `Is ${who} joining the ward's staff for this roster period?`,
    needsFromUser: [
      "Her name as the roster should show it (or keep the placeholder until you know it).",
      "Which staff groups she is in, if a rule counts that group. Leave her in none if unsure.",
    ],
    capabilityId: "staff-list",
    evidence: "static_check",
  });
};
```

Register it in `BUILDERS` with `add_staff_member: addStaffMember,`. In `isSafeOption`, replace the `case "add_person":` body with:

```ts
      case "add_person":
        // bead 2vtv: a new staff member joins no group; the manager names one in chat.
        if (option.repairId === "add_staff_member") return op.groups.length === 0;
        // A placeholder (the floor), in real groups, and a skill group only with a host question.
        return (
          loan &&
          op.groups.every((g) => ctx.groupIds.has(g)) &&
          (op.groups.length === 0 || option.enforcedBy === "host_question")
        );
```

In `use-feasibility-tools.ts`, change the example list in the description to: `"…for example borrowing a nurse from another ward, adding a nurse to the staff list, asking a named nurse on leave, or allowing one more night this period…"`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize/web && pnpm vitest run lib/ai/assistant/repair-options.test.ts lib/ai/assistant/playbook.test.ts lib/ai/assistant/repair-eval.test.ts components/ai/use-feasibility-tools.test.tsx lib/ai/phase-2-absence.test.ts`
Expected: PASS. `repair-eval.test.ts` loops every option through `isSafeOption` and applies it, so it covers the new option too. If its "top option clears the static check" case now picks `add_staff_member` for a scenario, that is correct: check that the scenario is chronic. A test that pins the exact option list of a chronic scenario (for example `tooFewNurses`) gains `add_staff_member` after `borrow_temporary_nurse`. Update that expectation, and do not change the order.

- [ ] **Step 6: Gate and commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize/web && pnpm typecheck && pnpm lint && pnpm format:check
cd .. && git add web/lib/ai/assistant/playbook.ts web/lib/ai/assistant/repair-options.ts web/components/ai/use-feasibility-tools.ts web/lib/ai/assistant/*.test.ts
git commit -m "feat(assistant): offer a new staff member for a chronic shortage (2vtv)"
```

### Task 2: Re-Optimize after the Apply, and say whether it now works

**Files:**
- Modify: `web/lib/ai/assistant/playbook.ts` (`FEASIBILITY_INSTRUCTIONS`)
- Modify: `web/components/ai/use-optimize-tools.ts` (`guidanceFor`, `optimal`/`feasible` case, ~line 78)
- Modify: `docs/ai-assistant.md` (new dated paragraph after "(2026-09-24) Roster swaps lifted.")
- Test: `web/lib/ai/assistant/playbook.test.ts`, `web/components/ai/use-optimize-tools.test.tsx`

**Interfaces:**
- Consumes: `OPTIMIZE_RUN_TOOL` and `OPTIMIZE_RESULT_TOOL` (`playbook.ts`), and `summarizeOptimizeRun(view, rosterSaved, lastRequest)` (`use-optimize-tools.ts`).
- Produces: no new names.

- [ ] **Step 1: Write the failing tests**

In `playbook.test.ts`:

```ts
describe("after a fix is applied (bead 2vtv)", () => {
  it("offers a run through the card and reports whether the schedule can now be built", () => {
    const line = FEASIBILITY_INSTRUCTIONS.find((l) => l.includes("request_optimize_run"));
    expect(line).toMatch(/After the user applies a fix/);
    expect(line).toMatch(/never say a run has started/);
    expect(line).toMatch(/get_optimize_result/);
    expect(line).toMatch(/whether the schedule can now be built/);
  });
});
```

In `use-optimize-tools.test.tsx`, next to the existing `summarizeOptimizeRun` cases (this file already has a `view(...)` helper):

```ts
it("says plainly that the schedule can be built when a run succeeds", () => {
  const summary = summarizeOptimizeRun(
    view({ lifecycle: "completed", outcome: "feasible", jobId: "opt_9" }),
    true,
    "started",
  );
  expect(summary.guidance).toMatch(/^The schedule can be built now: a roster was produced\./);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize/web && pnpm vitest run lib/ai/assistant/playbook.test.ts components/ai/use-optimize-tools.test.tsx`
Expected: FAIL. There is no such line yet, and the guidance still starts "A roster was produced.".

- [ ] **Step 3: Implement**

In `playbook.ts`, add a line to `FEASIBILITY_INSTRUCTIONS` right after "Prepare only the option the user picks…":

```ts
  `After the user applies a fix, offer a run with ${OPTIMIZE_RUN_TOOL} and never say a run has started; once it finishes, read ${OPTIMIZE_RESULT_TOOL} and say in one sentence whether the schedule can now be built.`,
```

`OPTIMIZE_RUN_TOOL` and `OPTIMIZE_RESULT_TOOL` are declared above `FEASIBILITY_INSTRUCTIONS` in the same file, so no import is needed.

In `use-optimize-tools.ts`, in `guidanceFor`'s `optimal`/`feasible` case, change the opening string from `"A roster was produced. Its XLSX file downloads…"` to:

```ts
          "The schedule can be built now: a roster was produced. Its XLSX file downloads in the browser, as for any run; if " +
```

(the rest of the expression is unchanged).

In `docs/ai-assistant.md`, add after the "Roster swaps lifted." paragraph:

```markdown
**(2026-09-27) Adding a nurse to staff.** When a schedule is short on many days of the
period (more than three), the assistant can suggest adding a nurse to the staff list: a new
starter, a transfer or a relief nurse on the roster for the whole period. It asks for her
name first. Applying it opens the Staff screen and adds her there. The assistant then offers
an Optimize run on a card. The run starts only when you press Run, and afterwards the
assistant tells you whether the schedule can now be built. A nurse borrowed for a single
shift is still a temporary cover, not a staff member.
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize/web && pnpm vitest run lib/ai/assistant/playbook.test.ts components/ai/use-optimize-tools.test.tsx components/ai/use-assistant-follow-ups.test.tsx lib/ai/phase-2-absence.test.ts lib/ai/assistant/scenario-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate, commit, close**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2vtv-add-staff-reoptimize/web && pnpm typecheck && pnpm lint && pnpm format:check
cd .. && git add web/lib/ai/assistant/playbook.ts web/components/ai/use-optimize-tools.ts docs/ai-assistant.md web/lib/ai/assistant/playbook.test.ts web/components/ai/use-optimize-tools.test.tsx
git commit -m "feat(assistant): offer a re-run after a fix and say if it now works (2vtv)"
bd close nursing-sheduler-2vtv
```

Manual check with a real key (optional). This costs the user's OpenRouter credit, so ask first. Load the example ward. Delete staff until most days are short. Ask "why is there no roster?", pick "Add a nurse…", give a name, and Apply. Expect the Staff screen to show the new row, then a Run card. Press Run. When the run finishes, expect the reply "can be built now".

## Unresolved questions

1. **Should the option also appear after an infeasible run with no static gap** (the `unexplained` situation)? My recommendation is no. A blind hire is not a testable guess, which is the same reason `unexplained` excludes borrowing.
2. **A skill-group shortage:** should the option offer "add an RN" after the manager states the qualification? My recommendation is not yet. The borrow option covers it, and the model can still add a nurse to a group on request.

## Assumptions

- `findStaffingShortfalls` counts every staff member for `ALL` requirements, so one added groupless nurse closes `tooFewNurses` (Task 1's test proves or refutes this).
- The follow-up text "I applied it: New nurse 1." (from `describeAppliedChange`) plus `FEASIBILITY_INSTRUCTIONS` in the earlier tool result is enough context for the model to offer the run. No new follow-up wording is added.
- A new staff member needs no requests or rule changes. Existing `ALL`-scoped rules cover her automatically.
