# 00: Synthesis and assistant improvement backlog

Date: 2026-09-24. Inputs: `01-notes-digest.md` (01), `02-singapore-practice.md` (02),
`03-codebase-scenarios.md` (03), `04-eval-pipeline-design.md` (04), plus a read of the shipped
instructions: `web/lib/ai/assistant/scenario-context.ts` (authority statement),
`web/lib/ai/assistant/playbook.ts`, `web/lib/ai/assistant/repair-options.ts`,
`web/lib/capability/help-content.ts`, `web/lib/proposal/commands.ts` (tool arg descriptions),
`web/components/ai/model-visible-tools.ts`.

Follow-ups: eval pipeline spec `docs/superpowers/specs/2026-09-24-assistant-eval-pipeline.md`,
its plan `docs/superpowers/plans/2026-09-24-assistant-eval-pipeline.md`, and the knowledge
plan `docs/superpowers/plans/2026-09-24-assistant-knowledge-upgrade.md`.

---

## 1. Key findings

### 1.1 The assistant's behaviour rules are good. What it knows about the solver is thin.

The authority statement (`scenario-context.ts` `ASSISTANT_AUTHORITY_STATEMENT`) and the playbook
cover the propose, Preview, Apply contract, option cards, tone, the repair ladder and the
safety floor well. Most live bugs so far were in **behaviour**: an empty reply after a tool call,
a pick-one question written as text, asking for a break instead of suggesting one, the wrong
year, no navigation after Apply. Each one got a prompt line or a code fix, but there is **no
regression net**. Nothing re-runs a real model against them (03 §8: "None of the e2e specs make
a live model call").

What the assistant is **not told** anywhere is the solver's model of the world (01 §2, L1-L17).
The help entries describe screens, not limits. So the model fills gaps from general knowledge.
Two examples: it treats "needs 2" as "at least 2" (L3), and it promises "max 5 days in a row"
through one succession pattern (L4). Both produce wrong rosters that still look OPTIMAL.

### 1.2 Singapore practice is mostly custom, not law. The assistant must not invent law.

02 found **no mandated nurse-patient ratio** (02 §2), **no MOH minimum rest hours between
shifts** (02 §3: "the Ministry does not impose a minimum number of rest hours"), no numeric rule
on consecutive nights or nights before days off (02 §3), and no SG fairness quota (02 §7). Real
numbers exist only at the Employment Act level (44 h/week, 12 h/day cap, at least 1 rest day a
week, 11 PH, off-in-lieu or pay for PH worked; 02 §3-4), and even these come from secondary
summaries. So the assistant must never assert a legal or MOH rule. It encodes the ward's own
rule and says the ward decides. The help module already has this grounding rule for its own
text (`help-content.ts` header: "no legal or clinical claim"), and `suggest_scheduling_rule`
restates it in its payload. The **authority statement does not**.

### 1.3 Realistic ward behaviours the assistant must handle (02 scenarios 1-18, 01 flows A-O)

| Ward behaviour | What the app can do today | What the assistant must say or do |
|---|---|---|
| NIC / senior on every shift | No skill-mix rule yet (bead 2ti in progress). Help text says so (`staffing-requirements`) | Say plainly it is not available yet. Do not teach twin shifts (commits `3c6de87`, `b6f3786`). Suggest the manager checks senior cover on the roster |
| Skill mix (RN per night, EN never alone on nights) | Existing skill-mix requirements are respected and never lowered (`SAFETY_FLOOR`). A per-person "never works N" lock works (01 A10) | Keep every skill-mix rule. EN-never-nights can be a per-person count lock `x = 0` at `infinity` |
| Off after nights | Soft succession N→OFF. Hard N→Day forbid (`-infinity`) | Propose N→Day as `-infinity` and N→OFF as a **finite** weight such as 10, never `infinity` (L6, 01 Flow A) |
| PH off-in-lieu | PH import via `set_roster_range importPublicHolidays`. No banked-credit memory (L8, L17) | Record the lieu day as a day-off request in the roster it falls in. Say the app does not track owed days across rosters |
| Fair night / weekend rotation | `|x - T|^2` count rule with negative weight (01 Flow B, F) | Without a fairness rule the solver can put the same nurses on every night and still call it OPTIMAL (01 Flow B). Offer the balance rule. Warn that the run can end FEASIBLE instead of OPTIMAL |
| Float / agency / other-ward borrowing | `borrow_temporary_nurse` repair (`add_person temporary`, off outside the loan) | Exists. Never put her in a skill group without the manager confirming (safety floor). Also tell the model about two wards on one shift type (L2) |
| MC, last-minute cover | Roster screen hand edits. The assistant cannot read the generated roster yet (bead 73z) | Say that re-running Optimize can reshuffle **everyone's** shifts (L16). For one MC on a published roster, edit the Roster screen by hand, or borrow a nurse and re-run knowingly |
| Swaps with NM approval | Not supported (roster-swap plan 73z in progress) | Out of scope here. Until 73z ships: say it is not supported, open the Roster screen |
| Two nurses want the same day off | Soft day-off requests, weights | Offer the manager the choice (option card). Never silently deny one |
| Pregnant nurse off nights, unpaid leave approval, work-pass gaps | Per-person lock. The app has no approval workflow (`leave-and-requests` help) | Encode only what the manager decides. Route approval questions to the manager or HR |

### 1.4 The eval pipeline is feasible with what the repo already has

04's design holds up against the code. The real seams exist: `createOpenRouterAgent(request,
{ fetch })` returns an in-process `AbstractAgent`, `CopilotKitProvider agents__unsafe_dev_only`
mounts it (the `session-real-core.test.tsx` pattern), `SCENARIOS` + `repair-eval.test.ts`
`EXPECTED` give 7 repair cases for free, and `violatesSafetyFloor(state, ops, { leaveAsked })`
already exists in `repair-options.ts`. So 04's "add an ops-level sibling" assumption is already
met. One correction to 04 §10: 04 relies on `evals/**` joining the test/support lint scope.
But the support-tree override (`**/support/**`, `web/.oxlintrc.json` override index 2) keeps the
**assistant** import boundary closed, and the eval harness must import `@/lib/ai/**`. So the
eval code needs its own pinned override row (assistant and raw-CopilotKit exempt, every
acquisition family banned), and its helpers must not live in a `support/` directory. The spec
§9 has the exact rows.

---

## 2. Knowledge gaps the assistant must explain correctly

Each gap is a sentence the assistant must be able to say in ward words. The "Home" column
says where the knowledge goes (see the knowledge plan).

| # | Fact (source) | Wrong behaviour today (risk) | Home |
|---|---|---|---|
| K1 | A staffing requirement is an **exact** count. "At least 2, ideally 3" needs a preferred count, which the assistant's add form cannot set (01 L3. `commands.ts` L208 "no preferred count") | Adds `requiredNumPeople: 3` for "at least 2" and loses the floor | help `staffing-requirements` + authority line |
| K2 | No clock-time reasoning. The solver does not know shifts overlap or how long a gap is. Rest between shifts is written as forbidden sequences (01 L1, L11) | Promises "11 hours rest" or "3 nurses at 3 pm" | new help `scheduler-limits` |
| K3 | No "max N days in a row, any shift". A sequence rule matches that exact pattern only. Use a weekly cap on working days as well (01 L4, Flow K) | One `M,M,M,M,M,M` pattern said to cap all runs | help `shift-successions` + `scheduler-limits` |
| K4 | No rolling window. Counts are over fixed dates (01 L5) | "Any 7 days" promised | `scheduler-limits` |
| K5 | One roster period at a time. No memory of last month's nights, weekends or owed PH days (01 L8, L17) | "It will balance with last month" | `scheduler-limits` |
| K6 | Score is abstract points, comparable only within the same setup. FEASIBLE = valid but not proven best. Re-runs can give a different equally good roster (01 L9, L16) | "449 is a good score". Treats FEASIBLE as a failure. Re-runs a published roster for one change | help `generate-roster` |
| K7 | `infinity` on a "must follow" sequence can make a solvable roster impossible. Use a finite weight. `infinity` on requests and counts is fine (01 L6, Flow M) | Proposes N→OFF at `infinity`. Or over-warns on counts | `commands.ts` succession weight description |
| K8 | Two groups restricted to the same shift exclude each other. Two wards need separate shift codes (01 L2, Flow B/E) | Adds a borrowed ward's staff to a shared shift | help `staffing-requirements` |
| K9 | No law is checked. SG has no mandated nurse ratio and MOH sets no minimum rest hours between shifts. The ward's own rules are the only rules (02 §2, §3) | States "MOH requires 11 hours" or "the ratio is 1:4" as fact | authority line + `scheduler-limits` |
| K10 | Without a fairness rule the solver can give all nights to a few nurses (01 Flow B gotcha) | Reports OPTIMAL and moves on | playbook-style line in `generate-roster` help, eval |
| K11 | WORKDAY / PH groups are empty unless public holidays were imported (01 Flow D) | Adds a PH rule that does nothing | help `roster-period` |
| K12 | Skill-mix rules cannot be created yet. Existing ones are kept (bead 2ti, `SAFETY_FLOOR`) | Teaches twin shifts, or promises "1 NIC per shift" | already in help. Eval only |

---

## 3. Ranked backlog

Effort: S under half a day, M 1-2 days, L more. Risk = risk of the change itself.
"Eval" names the case ids from the spec §8 that verify it.

| Rank | Item | Problem | Evidence | Proposed change | Effort | Risk | Eval |
|---|---|---|---|---|---|---|---|
| 1 | **Eval pipeline** | No live-model regression net. Every past live bug was found by hand | 03 §6, §8. 04 §0 | Build per spec (Vitest eval config, harness, graders, judge, pass^k, budget, report) | L | Low: never in CI, touches no product code except lint config | all |
| 2 | **No-legal-authority line (K9)** | The authority statement never says the assistant is not a legal source. Nurses ask "what does MOH require" | 02 §2, §3. `help-content.ts` header | One authority line: never state a law, MOH or MOM rule, ratio or rest-hour minimum as fact. Say the ward decides, and offer to encode the ward's rule | S | Low | `sg-moh-rest-rule`, `sg-ratio` |
| 3 | **Scheduler-limits help entry (K2-K5, K9)** | The model does not know L1/L4/L5/L8/L17, so it promises rules the solver cannot enforce | 01 §2 L1-L17, Part C table | New concept entry `scheduler-limits` in `help-content.ts`, reachable by `explain_app_capability` **and** `suggest_scheduling_rule`, so "max 5 days in a row" matches it. Authority line: when unsure whether the app can do something, check it | S | Low: manifest regen | `limit-consecutive-days`, `sg-moh-rest-rule` |
| 4 | **Exact vs preferred counts (K1, K8)** | "At least 2" becomes exact 3, or exact 2 with no headroom | 01 L3, Flow A. `commands.ts` L208 | Help `staffing-requirements` sentence + authority line: a staffing number is exact. For "at least N, ideally M" prepare N and say the preferred count is set on the Staffing requirements screen | S | Low | `exact-vs-preferred`, `flow-b-shared-shift` |
| 5 | **Hard "must follow" sequences (K7)** | The `add_succession_rule` weight description lets the model pick `infinity` for "encourage off after nights" | 01 L6, Flow A, M. `commands.ts` `ruleWeightSchema` | Succession-specific weight description: `-infinity` to forbid, a positive number such as 10 to encourage, avoid `infinity`. Setup-step `ask` hint: suggest the usual rest rules (no day after night, off after nights as a preference) | S | Low | `off-after-nights` |
| 6 | **Re-run reshuffle warning (K6, MC cover)** | For one MC the model offers a re-run, which reshuffles a published roster | 01 L16. 02 scenario 4 | `generate-roster` help: score meaning, FEASIBLE, re-runs can change everyone's shifts. Authority line: for a change to an already published roster, say a re-run can move other nurses and point to the Roster screen for hand edits | S | Low | `sg-mc-cover` |
| 7 | **Fairness nudge (K10)** | After an OPTIMAL run with no balance rule the model does not flag lopsided nights or weekends | 01 Flow B, F. 02 §7, scenario 15 | Help + setup `ask` line in the `rules` step: suggest a balance rule for nights and weekends. On "make nights fair", prepare `|x - T|^2` with target = average and weight -5, and warn that it can end FEASIBLE | S | Medium: runs can take longer | `sg-fair-nights` |
| 8 | **PH and off-in-lieu (K5, K11)** | The model can promise the app tracks owed PH days, or add PH rules without the import | 02 §4, scenario 16. 01 Flow D | `roster-period` help: PH groups need the import. `scheduler-limits`: no memory of owed days. Record a lieu day as a day-off request | S | Low | `sg-ph-in-lieu` |
| 9 | Ward-practice defaults in setup | Setup asks open questions a nurse cannot answer without examples | 02 §1, scenario 7. 01 gap 6 | Add usual-default hints to `SETUP_STEPS.ask` (3 shifts M/A/N or 12 h shifts; rest rules above; night cap per period; at least 1 rest day a week as a common ward rule, not law) | S | Medium: defaults do not fit every ward, so always "confirm" | `setup-flow-a` |
| 10 | Two-requests-same-day tie-break | The model can deny one request itself | 02 scenarios 2, 9 | Authority line: when two people want the same day and only one can go, offer the manager the choice with an option card. Never decide yourself | S | Low | `sg-same-day-off` |
| 11 | Succession `infinity` host refusal | Rank 5 is a description only. The host still accepts `infinity` on "must follow" | 01 L6 | Production validation in the proposal host: refuse `add_succession_rule` with weight `infinity` and name the finite alternative (ladder rung 1) | M | Medium: changes host behaviour | `off-after-nights` |
| 12 | Leave-credit advisory with contracted hours | Pinned leave not counted toward a contracted-hours rule silently overworks the nurse | 01 Flow O | Verify first whether the v2 Contracted Hours editor exists in this repo. If it does, add a static check finding | M | Medium | later |
| 13 | Skill-mix rules | NIC / RN per shift cannot be created | 02 scenario 14. 01 L12 | Bead 2ti (in progress). Not in this backlog | L | n/a | `sg-nic-per-shift` (today's honest answer) |
| 14 | Per-date override | "14 Oct only needs 1" is advice-only | playbook ruling (2se) | Bead 2se (in progress) | M | n/a | later |
| 15 | Roster read + swaps | Swaps with NM approval, MC cover by swap | 02 scenario 11 | Bead 73z, own plan | L | n/a | later |

Ranks 2-10 are the knowledge plan's scope. Every one of them is a prompt, help-text,
tool-description or playbook change with an eval case.

---

## 4. Notes for reviewers

- Every Singapore fact in the assistant's text stays **non-legal**. 02 marks most ward
  practice **[UNCERTAIN]**. The assistant can say "many wards", never "the rule is".
- Nothing here re-teaches twin-shift skill mix. That was removed on purpose (commits `3c6de87`,
  `b6f3786`).
- Adding help entries changes the capability manifest hash. `pnpm capability:generate` must
  run, and the diff gets reviewed (`registry.generated.test.ts`).
