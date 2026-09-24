# Roster-aware assistant: read the roster, suggest swaps, apply them on the user's click — spec

Bead: `nursing-sheduler-73z`. Date: 2026-09-24. Status: draft for review.
Plan: `docs/superpowers/plans/2026-09-24-roster-aware-assistant.md`.

## Problem

This was seen live. An optimiser run succeeded, and then the user asked:

> "SN-Priya needs to change her night shifts on 8 and 9 Oct, who can swap with her? do it for me now"

The assistant said it did not see the roster, and it asked the user who works which shift. That is the right answer for the tool set it has today. No model-visible tool reads a roster. `web/lib/ai/phase-2-absence.test.ts` locks that on purpose ("the model-visible surface CANNOT express a roster mutation"). It is the wrong answer for the product. The product decision of 2026-09-23 (`docs/ai-assistant.md`, "Product decision") lifts the Phase-1 limits one family at a time. It names "no roster edits" as one of those limits.

## What exists today (grounding)

- **The roster is a document, not scenario state.** `web/lib/roster/types.ts` holds `RosterDocument`. That is an immutable `submission` (the exact canonical YAML that was solved), `solvedDays[person][date]`, and a normalised `edits` overlay. `currentDays` is derived (`overlay.ts:deriveCurrentDays`). The working copy lives in IndexedDB behind `rosterStorage` (`web/lib/store/roster-storage.ts`: `readWorking`, `readCurrentCandidate`). The scenario repository does not hold it.
- **Hand edits already exist (F5).** `web/lib/roster/editing.ts` has `applyCellEditToSession` and an atomic two-cell `applyCellSwapToSession`, with single-level undo. `web/components/roster-viewer/use-roster-editing.ts` owns the one edit session and a CAS autosave queue (`lib/roster/autosave.ts`). `WorkingRosterPanel` mounts it on `/roster`. XLSX export patches the frozen workbook with the overlay (`lib/roster/edited-xlsx.ts`). So an edit made through that session is exported with no extra work. There is no locked or pinned cell concept.
- **Validation of hand edits is partial.** `web/lib/roster-viewer/requirements.ts` ports the backend's staffing equations: group totals, `qualifiedPeople` exclusion, coefficients, exact/lower/upper bounds. It re-evaluates them on the edited grid. Nothing in the web app evaluates successions, hard requests, hard counts, affinities or coverings on a roster.
- **The first run fills the working slot by itself.** A later run leaves a *candidate* that the user must **Load** (`roster-section.tsx:88-115`, `isWorkingRosterFromCandidate`).
- **The assistant's apply path is scenario-only.** `prepare_scenario_change` → `PreparedProposalV1` is bound to scenario revision, commit id, lease and idempotency key (`lib/proposal/proposal.ts`). `applyAssistantCommands` takes a `ScenarioUiState`. A roster cell is not a scenario command. `roster-viewer.supportedCommands` is deliberately `[]` for exactly that reason (`lib/capability/help-content.ts:261-289`).
- **A precedent exists.** The model asks, a host card shows, the user clicks, and the screen runs its own path. That is `request_optimize_run` → `OptimizeRunRequestCard` → `lib/optimize/run-request.ts` → the Optimize screen's own `onSubmit`.

### Ward practice (from `/home/kenan/work/nurse-scheduling-notes`)

The notes say nothing about shift *swaps* as a practice. There is no swap vocabulary in them. So the rules below come from how wards encode rest, skill mix and fairness:

- Rest between shifts is written as **forbidden successions**, not as clock arithmetic. The engine "has no notion of start/end times", so "11 hours off" is encoded as `N → M`, `N → A` forbids (`CAPABILITIES-AND-LIMITATIONS.md` L1, A7). The standard ward rule is "Hard-forbid a Morning immediately after a Night" (`user-tutorial-v2-flow-rules.md:15`). Statutory rest is written as `-inf` "no six X in a row" successions plus weekly counts (`user-tutorial-v2-yamls/flow-K-mom-statutory-rest-v2.yaml`, L4, L5). **So the swap check evaluates the scenario's own successions and counts. It does not add a hidden clock-time rest rule of its own.**
- Successions look at `history` across the window start (A14). The check does the same.
- Skill mix is `qualifiedPeople`. It *forbids* everyone else on that shift (L2). A requirement without `preferredNumPeople` is **exact** (L3). So a "cover" can break a requirement by adding a person as easily as by removing one. The check uses the ported requirement equations for both bounds.
- Approved leave is a hard LEAVE pin (A6, which uses SN-Priya as its example). A swap never moves a leave day.
- Fairness is authored as `|x - T|^2` counts (A8, A15). There is no fairness memory across months (L17). So "fair" in swap ranking means **the ward's own soft count and request rules**, then a plain workload tie-break. It does not mean a model of our own.

## Goal

After a run, the assistant does three things:

1. It reads the saved roster: who works what on each date.
2. It suggests swap partners. Each partner keeps every hard rule the roster was solved under and every staffing requirement. The ward's own soft rules rank them first, then workload.
3. It prepares the swap as a host card that shows the exact cells. The user presses **Apply to roster**. The change goes through the Roster screen's own edit session (one undo step, one autosave, the same XLSX export). Then the grid updates.
4. When nobody can take the shift, it follows the ward's cover ladder and says which step it is on (see "Cover ladder"). Step 1 is a swap, a move, or a cover by a nurse with spare capacity. Step 2 asks a nurse who is off or on leave to come in, for overtime pay or off-in-lieu. Step 3 asks for a temporary nurse: the relief pool through the nursing supervisor first, then another ward or an agency. Step 4 is the last resort: run the shift one short, with the nurse manager's sign-off.
5. It handles sick and emergency leave. "Priya is on MC on 8 Oct" marks Priya on leave in the roster for that date, then runs the ladder for the gap.

## User stories

1. **Priya (the live case).** A nurse manager types "SN-Priya needs to change her night shifts on 8 and 9 Oct, who can swap with her? do it for me now". The assistant calls `find_swap_partners` (person `SN-Priya`, dates `2026-10-08`, `2026-10-09`). The host rules out three people. SN-Ana gets N on 9 Oct, then AM on 10 Oct, and “No morning after night” forbids that. SN-Ben gets 4 nights, and “Max 3 nights” allows 3. SSN-Dev is not in the Nights group, and only that group works N. The host ranks SN-Cara (off both days, so a *cover*) and SN-Eve (an *exchange*: Priya takes Eve's PM shifts). The user said "do it for me now", so the assistant calls `prepare_roster_swap` with the top candidate. The card shows four cells. The user presses Apply. `/roster` opens with Priya on PM/PM and Eve on N/N (or Cara on N/N). One Undo reverts it.
2. **Ask first.** "Who can cover Priya's nights on the 8th and 9th?" The assistant lists the top three candidates with `offer_choices`. The user picks one, and the assistant prepares it.
3. **Nobody fits at any step.** The assistant says so in plain words and gives one or two host reasons. It never proposes a rule-breaking change.
4. **Read-only question.** "Who is on nights next weekend?" The assistant calls `get_roster` for that range and answers. It never asks the user who works what.
5. **Stale card.** The user edits the roster by hand after the card appeared, then presses Apply. The Roster screen refuses (a "before" value changed). `get_roster.lastChange` says so. The model offers to prepare it again.
6. **Newer run not loaded.** A second run finished, but its roster was not Loaded. The swap tools refuse and tell the user to press Load on the Roster screen first. `get_roster` still reads the working roster, but it flags `newerRunWaiting`.
7. **Step 2, the Asha trade.** Nobody can swap or cover Priya's nights on 8–9 Oct. SN-Asha is on leave on 8–9 Oct. The assistant says: "Step 2: ask someone who is off or on leave if she can come in." It offers, as a request: "You could ask Asha if she can come in on 8–9 Oct. Her leave would move to 11–12 Oct (off-in-lieu), and Priya would work Asha's mornings then." The card shows the roster cells and the leave move together. Apply stays off until the user ticks "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead, and SN-Priya agreed to work 11–12 Oct." Apply changes the roster and the leave record together, or neither.
8. **Sick leave.** "Priya is on MC on 8 Oct." The assistant prepares Priya's leave on 8 Oct and runs the ladder for her night shift. At step 1 it finds a nurse with spare capacity who is off (a cover), or a nurse who can move from another shift that day (a move). The wording never blames Priya or pressures anyone. It says "Priya is on MC", not "Priya called in sick again". The card shows Priya's leave and the cover together. Priya's leave also goes into the leave record, so a later re-run knows about it.
9. **Step 3, a temporary nurse.** Steps 1 and 2 find nobody. The assistant says: "Step 3: ask the nursing supervisor for a nurse from the relief pool. If there is none, ask another ward or an agency. Please let your nurse manager know." The user names her ("Mei from the relief pool, an RN"). The card adds Mei as temporary staff (source: relief pool) in the Nights group, off on every other date. It asks for her on N on 8 Oct. Apply stays off until the user ticks the confirmation question. The staff change applies now. Her roster row comes after the next run (C1) or with it (C2, Task 12).
10. **Step 4, last resort.** Nobody is available from the relief pool, other wards or agencies either, and the user says so. The assistant says: "Step 4, last resort: run night on 8 Oct with 1 instead of 2. This needs your nurse manager's sign-off." The card offers it only if a senior nurse who can be nurse in charge (NIC) stays on that shift, and never below one nurse. Apply stays off until the user ticks "My nurse manager has agreed it is safe to run night on 8 Oct with 1 nurse instead of 2." If the only way is to drop the senior, the assistant refuses and says so.

## Options compared

| | A. Host-checked roster edit (recommended) | B. Pin requests + re-run optimiser | C. Read-only + suggestions, user edits by hand |
|---|---|---|---|
| What changes | 2–14 cells, exactly the swap | Potentially every cell. It is a fresh solve (`phase-2-absence.test.ts` header: the optimiser "cannot validate a specific swap or preserve unaffected assignments") | Nothing, until the user drags cells |
| Honours "do it for me now" | Yes: one Apply click | No: it adds scenario pins, takes a run of minutes, then a Load that replaces the roster and drops hand edits | No |
| Rule exactness | Ported checker: exact for successions, requests, counts and requirements. Hard affinities and coverings are listed as "not checked" | Exact (it is the solver) | Same checker as A for the suggestions |
| Side effects | Only the working roster overlay; undoable | Permanent one-off pins in the scenario, which pollute later runs | None |
| Cost | New checker + three tools + card + request seam | Reuses T07 ops (`set_shift_request`) and `request_optimize_run` | A minus the card and seam |

**Recommendation: A.** Build it so that C ships first as a milestone (Tasks 1–7 without the card are C). When no partner fits, the assistant suggests B ("re-plan those nights with a run"). B uses tools that exist today.

## Recommended design

### Flow

```
model ──get_roster / find_swap_partners──▶ host reads rosterStorage (working row + candidate pointer)
                                           host derives rule model from document.submission (the rules it was SOLVED under)
                                           host evaluates each partner: planSwap → checkRosterChange (only NEW issues count)
model ──prepare_roster_swap(person, partner, dates, summary)──▶ host re-plans; hard issue ⇒ refusal text, no card
                                                                  ok ⇒ assistantActions.showRosterChange({request, view}, token.turnEpoch)
user  ──Apply to roster──▶ navigate("roster-viewer") ▶ requestRosterChange(request)          (lib/roster/change-request.ts)
Roster screen (WorkingRosterPanel) ──useRosterChangeRequest──▶ verify baseline + every "before" cell
                                   ──editing.applyCells──▶ applyCellBatchToSession: one normalisation, one undo, one autosave
```

### Where things live (import direction)

- `web/lib/roster/editing.ts`: `applyCellBatchToSession` (pure).
- `web/lib/roster/change-request.ts`: a zustand seam, AI-free. It mirrors `lib/optimize/run-request.ts`, because scheduling code must not import `lib/ai` (`.oxlintrc.json` "AI IS OPTIONAL").
- `web/components/roster-viewer/use-roster-change-request.ts`: the consumer, mounted by `WorkingRosterPanel`.
- `web/lib/roster-viewer/rule-check.ts`: the rule model and evaluation (pure, AI-free, reusable later to flag manual edits).
- `web/lib/roster-viewer/swap.ts`: `planSwap`, `findSwapPartners`, `findPersonIdx`, `givingProblem`.
- `web/lib/ai/assistant/roster-context.ts`: `readRosterForAssistant`, `summarizeRoster`, `buildRosterChangeView`.
- `web/components/ai/use-roster-tools.ts`: the three tools. `web/components/ai/roster-change-card.tsx`: the card.

The assistant never writes a roster table. The write is the Roster screen's own autosave. So `ASSISTANT_WRITE_TABLES` and `SCENARIO_WRITE_TABLES` stay roster-free, and that assertion in `phase-2-absence.test.ts` stays as it is.

### Tool shapes (zod; no `.nullable()`, no `z.literal`, per `model-visible-tools.ts`)

```ts
// get_roster
z.object({
  fromDate: z.string().optional(),   // "YYYY-MM-DD"; omit = roster start
  toDate: z.string().optional(),     // omit = roster end
  people: z.array(z.string().min(1)).max(40).optional(), // names as the roster shows them
});
// → { status: "ready", newerRunWaiting, changedByHand, solvedAs, period:{start,end},
//     shiftTypes:[{code,name,time}], dates:[iso], rows:[{person, days:[code|"OFF"|"LEAVE"]}],
//     rulesBrokenNow:[message] (≤20), lastChange: string|null(as absent), guidance }
//   or a plain refusal string (no roster / storage unavailable / unknown person / date outside).

// find_swap_partners  (runs the ladder; returns ONLY the lowest step that has an option)
z.object({
  person: z.string().min(1),
  dates: z.array(z.string()).min(1).max(7),
  reason: z.enum(["swap", "sick_or_emergency"]), // sick: the person goes on leave, takes nothing back
  noTemporaryNurse: z.boolean().optional(),      // true only after the user says pool/wards/agencies have nobody
});
// → { step: 1|2|3|4, stepLabel, person, giving:[{date,shift}],
//     step 1: candidates:[{partner, kind:"exchange"|"move"|"cover", partnerHasNow, worthKnowing, notChecked}] (≤5)
//     step 2: requests:[{partner, kind:"overtime"|"trade", payBack:"overtime"|"off-in-lieu", laterDates?:[iso],
//              movesLeave, agreement, worthKnowing, notChecked}] (≤3)
//     step 3: temporary:{ needs:[{date, shift}], skillGroups:[group], sources:["relief_pool","other_ward","agency"] }
//     step 4: short:{ allowed: boolean, shifts:[{date, shift, from, to}], refusal? }
//     ruledOutCount, ruledOutExamples:[{partner, reason}] (≤5), guidance }

// prepare_roster_swap  (steps 1 and 2, and a plain "record the MC")
z.object({
  person: z.string().min(1),
  partner: z.string().optional(),            // omitted only for reason "sick_or_emergency": record the leave, gap stays
  dates: z.array(z.string()).min(1).max(7),
  laterDates: z.array(z.string()).max(7).optional(), // step 2 trade: paired with `dates` in order
  reason: z.enum(["swap", "sick_or_emergency"]),
  noTemporaryNurse: z.boolean().optional(),          // no partner + swap reason = step 4 (run one short)
  summary: z.string().min(1),
});

// prepare_borrowed_cover  (step 3)
z.object({
  person: z.string().min(1),                 // whose shifts are uncovered
  dates: z.array(z.string()).min(1).max(7),
  reason: z.enum(["swap", "sick_or_emergency"]),
  name: z.string().min(1),                   // the temporary nurse, as the user named her
  source: z.enum(["relief_pool", "other_ward", "agency"]),
  groups: z.array(z.string()).max(5),        // staff groups; the host adds the skill group the requirement needs
  summary: z.string().min(1),
});
// → text: card shown / refusal with host reasons.
```

The host checks the dates against `context.calendar`, not a zod regex. The locked runtime's JSON-Schema converter is the known hazard here, and a date outside the roster needs a friendly refusal anyway. Person names match `String(person.id)` exactly. If that fails, they match a unique case-insensitive substring (so "Priya" finds "SN-Priya"). Anything else is refused, and the refusal lists the names.

### Host checks (`rule-check.ts`, mirrors `core/nurse_scheduling/preference_types.py`)

The authority is the **roster's own submission**, meaning the rules it was solved under. It is not the live scenario.

| Family | Hard when | Evaluated as |
|---|---|---|
| Staffing requirement | always (lower/exact bound; `preferredNumPeople` is also a hard upper bound, `preference_types.py:185-192`) | the existing `evaluateRequirementCell` on each changed date: short, over, and unqualified per offender |
| Succession | weight `-inf` (full match forbidden) or `+inf` (window must match) | a sliding window over each start day. The `date` filter covers the whole window. At day 0, the history-prefix variants: history suffix matches pattern prefix ⇒ the rest of the pattern is judged from day 0 (`preference_types.py:329-352`). OFF/LEAVE sentinels match those day-states. `ALL` matches worked shifts only |
| Shift request | weight `±inf`; **any** `LEAVE` request (`preference_types.py:259-270`) | per person/date/shift. A selector equal to every worked shift means "works any shift" |
| Shift count | weight `±inf` (`-inf` on `|x - T|^2` means x = T) | x = Σ coefficient × day-state over `countDates`, per person, per expression/target pair |
| Affinity, covering | weight `±inf` | **not evaluated**. Listed in `notChecked` and shown on the card |

Only **new** issues block. The check runs on the grid before the change and on the grid after it. Both runs use the same scope: the two people and the changed dates. A count rule is in scope when its dates touch the change. A new key blocks. A key whose severity grew also blocks. Soft issues (finite weights) come back as `worthKnowing`. An unresolvable selector on a hard rule goes to `notChecked`, never to "fine".

Swap semantics: for each date, the two people exchange day-states. The host refuses the swap in three cases: the person does not work on a date, the partner is on leave, or both hold the same day-state. When every partner cell was OFF, `kind` is `"cover"`. Then Priya loses those shifts, and a hard minimum-shifts count still catches that. In all other cases it is `"exchange"`.

Ranking is a `ponytail:` rule. Ask ward managers before you weight it further. First comes the fewest soft issues introduced, which captures the ward's fairness counts and requests. Next comes the fewest of the handed-over shift codes in the partner's row afterwards. Then comes the fewest worked days afterwards, and last the roster order.

### Cover ladder (Singapore ward practice, user requirements 2026-09-24)

**Sources.** `research/05-sg-cover-escalation.md` (scratchpad). It cites MOH, MOM, the SGH newsroom, Indeed SG and Mothership. Its own caveat: "No source lays out a shift-by-shift escalation ladder." So the ORDER below is the user's ward requirement, cross-checked against that research. Each rung is marked **[sourced]** or **[UNCERTAIN]** with its evidence.

**Who decides.** The nurse clinician (NC) rebuilds the roster when someone reports sick. The shift's nurse in charge (NIC) runs it. The nursing supervisor sees across wards. [UNCERTAIN: Indeed SG career page, not hospital policy.] The assistant talks to whoever uses the app. It calls the decision-maker "your nurse manager" in sign-off lines. Open question 17 covers whether to say "nurse clinician" instead.

The user asked for six rungs. **Recommendation for v1: four steps.** Merge rung 3 into step 1 by ranking, and rungs 4 and 5 into one borrow mechanism with a source label:

| Step | Label the assistant says | Options | Tick on the card | Evidence |
|---|---|---|---|---|
| 1 | "Step 1 · Swap or cover within the ward" | `exchange` (swap reason), `move` (sick reason: a rostered nurse moves from another shift that day, staffing still holds), `cover` by a nurse who is OFF **and has spare capacity** under her own count rules (user rung 3, merged: part-timers and anyone under a cap or target) | none | [sourced] voluntary swaps on flexible shifts: SGH newsroom (78 SGH shift combinations, more than 50 at NUHS). Part-timers and job-sharing as a flexibility layer: the same article. The "spare capacity" test is our proxy: [UNCERTAIN] |
| 2 | "Step 2 · Ask someone off or on leave to come in" | framed as a request, naming the pay-back. `overtime` cover (an off nurse with no spare capacity comes in, paid overtime or rest-day rate) or `trade` (off-in-lieu: her off or leave moves to later dates) | yes | [sourced] overtime pay at 1.5x and no MOH call-back cap: MOH newsroom, MOM hours-of-work. [UNCERTAIN] off-in-lieu as the payback norm, and the exact caps (secondary sources) |
| 3 | "Step 3 · Ask for a temporary nurse" | one mechanism, `source`: `relief_pool` (ask the nursing supervisor; tried first), then `other_ward` or `agency`. The user names the nurse. The card says "Please let your nurse manager know." | yes, the confirmation question | [sourced] temporary staff and redeployment, framed by MOH as a surge response. [UNCERTAIN] a hospital float or relief pool (no SG pool named) and the nursing-supervisor channel (non-SG source) |
| 4 | "Step 4 · Last resort: run one short" | only after steps 1–3 are exhausted and the user says no temporary nurse is available. Run the shift one short. Never below one nurse. Never when it drops a qualified (NIC-capable) nurse | yes, the nurse manager's sign-off | [UNCERTAIN] no SG source for skill-mix downgrade. MOH's "cutting non-urgent treatments" is the nearest. The NIC guardrail is standard clinical governance, not a cited SG rule |

**Why these merges.** Rung 3 (part-timers, spare capacity) differs from step 1's cover only in who the off nurse is. Ranking puts spare-capacity nurses in step 1 and everyone else in step 2's `overtime`. That also keeps overtime (a cost, and a request) after no-cost options. Rungs 4 and 5 differ only in who confirms the nurse. One `prepare_borrowed_cover` with `source` keeps one code path, one card and one confirmation. The guidance orders the sources: relief pool first.

**Skill-mix downgrade is not in v1.** In this data model a downgrade means an unqualified nurse on a `qualifiedPeople` shift. The backend forbids that outright (L2), and the check cannot tell "a junior instead of one of two seniors" from "no NIC at all". So step 4 offers only run one short, and only when no qualified equation loses anyone. Open question 18.

**Step 1: spare capacity.** A nurse who is OFF counts as spare capacity when some count rule that applies to her has her below its target (`x <= T`, `x < T`, `x = T`, `|x - T|^2`, `x >= T` or `x > T` with x < T) before the change, and the cover introduces no count issue (hard or soft). A nurse with no count rules has no known capacity, so her cover goes to step 2 as `overtime`. [UNCERTAIN] proxy for "part-timer or nurse with spare hours": the canonical person has no part-time flag.

**Step 2: request wording.** "You could ask Cy if he can come in on 8 Oct. He would be paid overtime (or rest-day rate)." And: "You could ask Asha if she can come in on 8–9 Oct. Her leave would move to 11–12 Oct (off-in-lieu)." Never "Cy will work" or "assign Asha". The research reports friction when shortages are pushed onto colleagues (Mothership, 2026). Ticks: "SN-Cy agreed to come in on 8 Oct for overtime pay." "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead, and SN-Priya agreed to work 11–12 Oct." Order within step 2: OFF nurses first (overtime, then off-in-lieu trades), then nurses on leave (a leave move disturbs an agreement).

**Step 4: safety, reusing the shipped rules.** `lib/ai/assistant/repair-options.ts` `run_one_short` and `violatesSafetyFloor` already hold the scenario-side lines: "one short may not drop the shift below the skill mix it must hold", never to zero, and the manager's safety call. The roster-side check mirrors them on `checkRosterChange` output. Step 4 is allowed only when every NEW hard issue is a staffing shortfall of exactly one, on an equation with no `qualifiedPeople`, whose `required` is 2 or more. Any shortfall or offender on a qualified equation (the senior or NIC slot), any other rule family, or a shortfall of two or more is refused. The refusal says: "Running it short would leave no senior nurse who can be in charge, so the app will not offer it. Please talk to your nurse manager or the nursing supervisor." The tick reuses `run_one_short`'s question with the SG wording above. The roster cells change (the gap stays). v1 has no linked scenario change, because lowering a requirement for one date is the per-date override plan's job (`2026-09-24-per-date-staffing-override.md`).

**Ladder order is enforced by the host.** `find_swap_partners` returns only the lowest step with an option. Step 4 needs `noTemporaryNurse: true`, which the model sets only after the user says the relief pool, other wards and agencies have nobody. `prepare_borrowed_cover` refuses below step 3. A no-partner `prepare_roster_swap` for reason `swap` refuses below step 4.

**Trigger: sick or emergency leave.** With `reason: "sick_or_emergency"`, the person's cells on the dates become LEAVE, and she takes nothing back. So there is no `exchange` and no `person-covers`. The card always records the leave in the leave record too (`add_leave`), so a later run knows. Recording the MC alone is always allowed, at any step. `prepare_roster_swap` without a partner writes the leave and states the gap ("Night on 8 Oct is still uncovered. Keep looking for cover."). A shortfall from a recorded absence never blocks, because the absence is a fact. That is different from step 4, where leaving the gap is a decision that needs sign-off.

**Step 2 detail (the off-in-lieu trade).**
- Candidates are nurses whose cells on every given date are OFF or LEAVE. Trades are returned only when step 1 has no valid option. They rank below step 1 by construction. Within step 2, OFF trades rank above leave trades (no leave record changes), then fewer soft issues, then the earliest later dates.
- The later dates L are the same count as the given dates G, after the last G date, and paired with G in order. v1 searches runs of consecutive days where the partner works a shift on each (`ponytail:` consecutive runs only; widen when wards ask). It returns up to two checked runs per partner.
- Cells: on G, the partner takes the person's shift. The person gets OFF (swap) or LEAVE (sick). On L, the partner gets her original G state (LEAVE or OFF). With `person-covers`, the person takes the partner's L shift and must be OFF there.
- Every affected date passes the same hand-change check: G and L, for both people. Rest patterns include the day after each moved shift, because a succession window that touches a changed date is in scope. The check also covers staffing and skill mix, counts, and requests.
- The roster's own LEAVE request for the partner on G would read as broken after the trade. So the check takes `leaveMoves: [{personIdx, from, to}]`. After the change, the pin at `from` is suppressed and a pin at `to` is required. Without that, every leave trade reads as a hard violation.
- **The leave record.** Moving leave also changes the schedule's leave requests. **Decision: the card applies both.** The roster cells go through the Roster edit session. The leave move goes through the shipped `move_leave` op, as a linked proposal (`assistantProposalCommands.prepare`) that is not shown as a separate Preview. Both are shown on one card and applied together or not at all (see "Applying two stores together"). The date ids for `move_leave` come from `generateDateItems` over the live scenario range, because ids are span-formatted (`"08"`), not ISO. A date outside the live range refuses the trade.
- OFF moves change only roster cells. An OFF that a hard OFF request pins is already refused by the check. v1 does not move OFF requests.

**Step 3 detail (temporary nurse: relief pool, other ward, agency).**
- The host lists the needs (date and shift) and the skill group a requirement demands on that shift (`qualifiedLabel` of the matching equation). The user names the nurse and the source. The model never invents a person. The shipped `add_person` arm has no description field (`{name, groups, temporary}`, `lib/proposal/commands.ts:237`). So the source label goes into the proposal rationale and the card title ("Mei (relief pool)"), not the staff record. Open question 19 covers adding a field.
- The linked proposal uses shipped ops only: `add_person {temporary: true, groups: [...skill group]}`, then `set_off_request weight "must"` over every other roster date. This is the pattern `operations.test.ts` "borrows one RN" pins. It makes `deriveAssumptions` produce the existing `borrowed_staff_arranged` question, which becomes the card's tick.
- **Constraint found: a roster document cannot hold a person who is not in its submission.** `context.people` is re-derived from `submission` and must match exactly (`lib/roster/validate.ts`). `solvedDays` covers exactly those people. So "put her on the uncovered shift in the roster" needs a roster schema change: roster-file/2 with a `borrowed` array of extra rows (`{id, days}`), axis index `people.length + i`, a migration that adds `borrowed: []` to roster-file/1, and grid, coverage, tallies, edited-XLSX row append, and file import/export support. **Recommendation:** ship step 3 in two parts. C1 (this plan): the card prepares the staff change and tells the user plainly that the roster gains her row after the next run, or after C2. C2 (its own plan): roster-file/2 borrowed rows, after which the card applies the staff change and her roster row together, like the trade. See Open questions 11–12.

**Applying two stores together.** The leave record (scenario repository) and the roster (roster IndexedDB) are two stores. No single transaction spans both. So Apply is a short sequence that undoes itself on failure, and it is honest about the one case it cannot undo.
1. Re-read the roster and check that every before cell still matches (`requestStillMatches`). A mismatch stops with nothing changed.
2. Apply the linked proposal (`assistantProposalCommands.apply`). This transaction re-checks lease, revision and the agreement confirmation from persisted state. A failure stops with nothing changed.
3. Open `/roster`, hand over the cells, and wait for the outcome (`awaitRosterChangeOutcome`, 15 s).
4. Not applied: undo the proposal with `assistantProposalCommands.undoReceipt(receiptId)`, then say "Nothing was changed." If that undo is refused (someone committed on top), say "The leave move was saved but the roster was not changed. Undo the leave move from the change list, or ask me again."

The scenario goes first because it has the strictest gates and a durable receipt with Undo. The roster goes second because its session undo is single-level and happens after navigation.

**Agreement tick (step 2).** The card shows one checkbox with one plain sentence. For an `overtime` cover there is no proposal, so the tick is card state only. Ticking it records the linked proposal's `leave_moved` confirmations (`assistantProposalCommands.confirm`), so the durable Apply gate enforces it. Unticking withdraws them. An OFF trade has no proposal, so the tick is card state only, and Apply stays off until it is ticked. Sentences:
- leave, person covers: "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead, and SN-Priya agreed to work 11–12 Oct."
- leave, partner off: "SN-Asha agreed to come in on 8–9 Oct and take leave on 11–12 Oct instead."
- off: "SN-Cy agreed to come in on 8–9 Oct and have 10–11 Oct off instead (off-in-lieu)" (plus ", and SN-Priya agreed to work 10–11 Oct" when Priya covers).

### Preview wording (card)

- Heading: **Swap shifts?** Subheading: `SN-Priya and SN-Eve, 8 Oct and 9 Oct`.
- A table: `Nurse | Date | Now | After`, with one row per changed cell.
- Line: "Checked against the rules this roster was made with: staffing, rest between shifts, requests and shift counts."
- "Worth knowing:" lists the soft issues. The card leaves it out when there are none.
- "Not checked:" lists the hard affinity/covering labels, then "Look at these on the Roster screen before you publish." The card leaves it out when there are none.
- Footer: **Apply to roster** / **Not now**. A small note: "You can undo it on the Roster screen."
- Stopped (the turn moved on): "This offer has ended. Ask again if you still want the swap." There is no Apply button.
- The assistant's own line after preparing: one sentence naming who swaps what, plus "nothing changes until you press Apply".
- Every card shows its step as a small label: "Step 1 · Swap or cover within the ward", "Step 2 · Ask someone off or on leave to come in", "Step 3 · Ask for a temporary nurse", "Step 4 · Last resort: run one short".
- Headings by kind: swap **Swap shifts?**, sick **Cover Priya's MC?**, overtime **Ask Cy to come in?**, trade **Ask Asha to come in?**, temporary **Ask for a temporary nurse?**, short **Run night one short?**.
- Step 3 card adds: "Please let your nurse manager know." Step 4 card adds: "Only with your nurse manager's sign-off. A senior nurse who can be in charge stays on this shift."
- Trade card: the cell table, then one line per moved leave ("SN-Asha's leave: 8–9 Oct → 11–12 Oct"), then the agreement checkbox. Apply stays off until it is ticked. Under Apply: "This changes the roster and the leave record together."
- Sick card: "SN-Priya on leave 8 Oct" as the first row. With no cover: "Night on 8 Oct is still uncovered."
- Temporary nurse card (C1): "Adds Mei (relief pool) as temporary staff, off on every other date, and qualified as Nights." Then the lending-ward question as a checkbox. Then: "Mei's roster row appears after the next run." In C2 that last line becomes the cell table.
- A failed linked Apply shows one line: "Nothing was changed: <reason>."

### Locked-test changes (each marked `WIDENED DELIBERATELY (2026-09-24, plan roster-aware-assistant)`)

- `web/lib/ai/phase-2-absence.test.ts`: add `get_roster`, `find_swap_partners`, `prepare_roster_swap` and `prepare_borrowed_cover` to `MODEL_VISIBLE_TOOLS`. Drop `swap` from `PHASE_2_VERBS`. Keep `repair|reassign|minimal-change|disrupt|shortage|re-optimi`. A rename that dodges the regex defeats the purpose of the file. `PROPOSAL_OPERATIONS` is **unchanged**: no scenario command arm is added. The roster-table assertion is **unchanged**.
- `web/lib/capability/tools.test.ts`: add the three names to `NOT_REGISTRY_GOVERNED`.
- `web/lib/ai/runtime/model-visible-tools.test.ts`: the three schemas go through the real conversion automatically (via `MODEL_VISIBLE_TOOL_SCHEMAS`). Add one wire assertion for their string/array fields.
- `web/lib/ai/assistant/scenario-context.test.ts`: the authority statement names the roster tools.

### Risks

1. **The checker drifts from the backend.** Mitigation: a port that mirrors the backend line by line with citations, discriminating tests per family, and an honest `notChecked`. Follow-up: add rule-check verdicts to the existing Python differential test (`pnpm test:differential`).
2. **The roster's rules against the live scenario.** A swap is checked against the rules the roster was solved under. A rule or leave added afterwards is invisible to the check. The card says "the rules this roster was made with".
3. **A concurrent hand edit or another tab.** The Apply re-verifies every "before" cell, and the CAS autosave surfaces a conflict as the existing failed-save banner.
4. **A request the screen never takes** (no working roster, or navigation cancelled). It expires after 15 s (`ROSTER_CHANGE_TTL_MS`). It never applies on a later visit.
5. **The locked Phase-2 test narrows.** It is a reviewed, documented widening, the same as the solver-run family.
6. **Prompt size.** A 30 × 28 roster is about 3–4k tokens as code rows. `get_roster` accepts a date range and people filter.
7. **Two stores, one Apply.** The sequence can leave the leave move saved while the roster edit is not, when the compensating undo is refused. The card says so in one line and names the fix. The failure window is small: the roster check runs just before, and the undo runs just after.
8. **The live leave record against the roster.** `move_leave` acts on the live schedule. If Asha's leave was edited there after the run, `move_leave` refuses ("There is no leave on that date to move"), and the card is not shown.
9. **A linked proposal outside the Preview card.** It is a real proposal row with status and receipts. "Not now" on the card cancels it (`assistantProposalCommands.cancel`), so no orphan stays applicable.
10. **Step 3 in the roster needs roster-file/2.** Until C2 lands, a borrowed nurse is in the schedule but not on the roster on screen. The card says so plainly.

## Open questions (with recommendations)

1. **Hard affinity/covering rules cannot be checked. Block Apply, or allow with a note?** Recommend: allow, and list them under "Not checked". Hand edits already allow anything, and the manager decides.
2. **Check against the roster's rules, or the current scenario's?** Recommend: the roster's own submission, because that is what the roster claims to satisfy. A later change adds a note for a scenario edited after the run.
3. **Cross-date trades.** Now IN v1 for step 2 (a nurse off or on leave). Trades between two working nurses ("Eve takes Priya's nights, Priya takes Eve's Saturday") stay out of v1.
4. **Is a "cover" (partner off, so Priya loses the shifts) a swap?** Recommend: yes, labelled `cover` so the user sees Priya loses those shifts. Hard minimum counts still apply.
5. **Does a newer unloaded run block the swap tools?** Recommend: yes, with guidance to press Load. Otherwise the swap lands on a roster the user no longer means.
6. **Does the assistant carry on by itself after Apply, as with proposals** (`use-assistant-follow-ups.ts`)? Recommend: follow-up bead. v1 exposes the outcome through `get_roster.lastChange`.
7. **Solver-verified swaps** (pin the whole edited roster, submit under the diagnostic purpose)? Recommend: build it only after the differential test finds drift. It costs a queued job per check.
8. **The fairness ranking.** Recommend: v1 as above. Ask a ward manager whether "fewest nights this period" outranks the ward's soft rules.
9. **A leave nurse who gives up her leave without a later date (`clear_requests`, the `leave_cancelled` question)?** Recommend: not in v1. Moving leave keeps her entitlement, and a give-up is rarer and harsher. Add it as a lower step-2 variant later.
10. **Moving an OFF that a request pins (`set_off_request` + `clear_requests`)?** Recommend: not in v1. The check refuses a hard one, and a soft one shows as "worth knowing".
11. **Step 3 in the roster: a roster-file/2 schema change now, or C1 first?** Recommend: C1 first (staff change plus a plain note), then C2 as its own plan. C2 touches validation, import/export, the grid, coverage, tallies and XLSX row append.
12. **Step 3 without C2: offer a re-run instead?** Recommend: yes, as a second option on the borrow card ("Or run the optimiser again with Mei"). A re-run replaces hand edits, so the card says that.
13. **Should an MC always go into the leave record?** Recommend: yes. It is a fact, and a later re-run of the same period has to respect it. It needs no agreement tick.
14. **Sick leave with no cover: allow recording the MC alone?** Recommend: yes, with the uncovered shift stated on the card. Refusing to record a real absence helps no one.
15. **Step 2 later dates: consecutive runs only?** Recommend: yes for v1. Ask wards whether split dates or "same weekday next week" matter.
16. **Does a step 1 cover (an off nurse working an extra day) need a tick?** Recommend: no for a spare-capacity cover (step 1). An off nurse without spare capacity is now step 2 `overtime`, which does need a tick.
17. **"Nurse manager" or "nurse clinician" in sign-off lines?** Recommend: "nurse manager" in v1, since the user used it and wards differ. Make it one constant so a ward can switch to "nurse clinician (NC)".
18. **Skill-mix downgrade in step 4?** Recommend: not in v1. It cannot be told apart from dropping the NIC, and the backend forbids an unqualified nurse on a qualified shift. Revisit with the skill-mix rules (`skillMix`, spec 2026-09-24-skill-mix-rules), which can express "at least 1 senior" without exclusivity.
19. **Record the temporary nurse's source (relief pool, ward, agency) on her staff record?** Recommend: not in v1 (no field on `add_person`). Put it in the card title and rationale. A description field on `add_person` is a separate command-schema change.
20. **Tell the nurse manager earlier than step 3?** The research suggests "once ward-level swap fails", which is step 2. Recommend: show the note from step 3, as the user asked. Revisit if managers ask to be told earlier.
21. **Spare capacity as "under any count target".** It may be too generous: nearly everyone is under a monthly cap. Recommend: accept for v1 (ranking still prefers the least loaded), and ask a ward whether only contracted-hours targets should count.

## Assumptions

- The working roster in IndexedDB is the roster the user means, unless a newer candidate is waiting.
- Person ids in `context.people` are the names nurses use (for example `SN-Priya`), as in the live case and in the notes' examples.
- Roster periods are about 4–6 weeks, so reading the full grid in one tool call is acceptable.
