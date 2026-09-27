# Lane 06: v1 frontend features compared with the v2 web app

Date: 2026-09-25. Author: lane 06 worker (read-only investigation).

The v1 repository is `/home/kenan/work/nurse-scheduling`. The v2 repository is this worktree.

Baselines:

- `d63519b` is the pin that v2 last synced from.
- `feature/genie` (HEAD `1bf4b85`) is the primary upstream target, as the coordinator corrected.
- `dev` (HEAD `d41a6c5`) is the j3soon upstream branch.

## 1. Summary

`d63519b` is not an ancestor of `dev`. It is on `feature/genie`, and `merge-base(d63519b, dev) = 89190ab`. A plain `git diff d63519b dev -- web-frontend` shows 169 files. That count is wrong for this purpose, because it shows the genie features (contracted hours, working time, coverings, Singapore holidays, LEAVE, no Sentry) as v1 deletions. The real upstream delta is `d63519b..feature/genie`: 147 commits and 105 files. Of these commits, 143 come from `dev` (`89190ab..dev`, merged into genie at `1b6f7e5`). Three are genie-only: `0320d3e`, `ecb5eee` and `6b2f274`.

Most of the change is two areas:

- A new `/experimental-ai` chat page (about 60 % of the commits). It talks to a new server-side AI service in v1 core (`core/nurse_scheduling/ai/app.py:887-1334`).
- A rebuilt Optimize and Export page. It adds a backend server list, bearer-token authentication, solver options discovery, claimed performance, worker activity, and feedback and star nudges.

Genie reverts the server list to one build-time URL (`8bb7c32`, which kept its effect through `1b6f7e5`). Genie also removes Sentry and the Sentry-based feedback rating again.

The headline risks follow:

1. A sync that uses `diff d63519b dev` will delete genie features. Use `d63519b..feature/genie`.
2. The v1 AI page depends on a v1 backend AI service that v2 does not have. v2 has a different, client-direct, BYO-key assistant (bring your own key) (`docs/ai-assistant.md`). Port only selected user-experience ideas, not the page.
3. Three small v1 data fixes also apply to v2 code, which has the same defects: history blanking on shift-type deletion, nested shift-type groups in count coefficients, and the Singapore holiday year range.
4. v2 shows no copyright or AGPL-3.0 notice. v1 shows one on every page.

## 2. Change table

The Origin column uses two tags. DEV means that the change is in `89190ab..dev`. GENIE means that the change is only in `dev..feature/genie`. "Genie vs dev" notes where the two branches differ on the same file.

### 2a. Non-AI changes

| ID | Origin | v1 commits | Files | What it does | v2 status | Conflict notes vs v2 | Proposed action | Effort | Risk |
|---|---|---|---|---|---|---|---|---|---|
| F01 | DEV, genie reverts part | `0249f67` `1a498f0` `02edf64` `a9a2823` `3621c6b` `0ca179c` `77fa325` `a2cbc12` `57f3617` `7fc31a6` `a64a623` `2b5d78a` `5af0419` `89a19e5`; genie `8bb7c32` (single URL, kept through merge `1b6f7e5`) | `optimize-and-export/page.tsx`, `serverSelection.ts`, `DataTable.tsx` | dev: a user-editable backend server list (primary, secondary, opt-in localhost), auto-selection, explicit "Optimize Anyway" for an incompatible backend, a bare host completed to a URL, versioned settings in localStorage with a legacy migration, Status and Activity columns (running, queued and cancelling jobs, workers online), claimed performance score, and an unofficial-server policy note. genie: one `NEXT_PUBLIC_BACKEND_API_URL` and no list (`serverSelection.ts` genie vs dev). Genie keeps "Optimize Anyway", claimed performance and activity. | intentionally excluded (architecture) | v2 uses one server-side backend through the BFF (backend-for-frontend) layer, configured by `BACKEND_API_URL` (`web/lib/bff/upstream.test.ts:14`). See the `DESIGN.md` §1 deviation matrix, row 1. v2 already has a version-compatibility classifier (`web/lib/version/version-compat.ts:24-30`). | skip the server list. Worker activity and claimed performance: NEEDS DECISION (D3) | S (if adopted: show activity from `/api/info`) | low |
| F02 | DEV (genie keeps) | `8142e57` `073951e` `7b07478` `c018fe7` `e5e3686` | `BackendTokenField.tsx`, `utils/backendAuth.ts`, `serverSelection.ts`, `optimize-and-export/page.tsx`, `e2e/optimize-and-export-auth.spec.ts` | Optional bearer-token authentication for the backend. `/info` advertises `auth: {required, scheme}`. The user enters a token per endpoint, with a show/hide toggle and validation. Requests send `Authorization: Bearer`. The event stream uses a scoped token from `links.events`. | absent | v2 has no token UI, and v2 core has no auth module. The v1 frontend change depends on v1 core `core/nurse_scheduling/server/auth.py` and `server/app.py:326-335` (`auth` in `/info`). In v2 the browser never talks to the backend directly, so a token belongs in the BFF as a server-side secret, not in the UI. | adopt with adaptation, only if lane core adopts `server/auth.py` (D2) | M | medium (secret handling) |
| F03 | DEV (genie keeps) | `417d632` `eacd021` `338b588` `3bc5c62` | `optimize-and-export/page.tsx`, `serverSelection.ts`, `e2e/optimize-and-export-options.spec.ts`, `scripts/generate-e2e-coverage.mjs` | Reads `GET /optimize/options` (solver choices, timeout default, min and max, prettify default, cancel and finish-now capability). It shows a solver select and a bounded timeout. It falls back to legacy defaults for older backends. | partial | v2 has the prettify, timeout and anonymize controls (`web/components/optimize/run-options-form.tsx`). The timeout bound is enforced by core (`core/nurse_scheduling/server/api/optimize.py:120-153`). v2 has no options discovery and no solver select. U31 fixes CP-SAT as the only solver (`docs/T19-upstream-backend-source-manifest.md:313`). The change depends on v1 core `server/api/optimize.py:205`, `server/solver_options.py` and `server/solver_capabilities.py`. | adopt with adaptation: read the timeout bounds and default through the BFF if core adopts `/optimize/options`. Skip the solver select. | S | low |
| F04 | DEV (genie drops) | `9a8f696` `96550e0` `da2f97f`, and the Sentry configuration in `1473c56` | `OptimizationFeedbackNudge.tsx`, `instrumentation-client.ts`, `sentry.*.config.ts`, `next.config.ts` | A thumbs-up or thumbs-down rating of an optimisation result, sent as Sentry user feedback with solver and outcome tags. It also adds a Feedback widget and per-deployment Sentry DSN, environment and project. | intentionally excluded (fork decision) | Genie removed Sentry in `64c84a3` and drops these files again in `1b6f7e5`. v2 has no Sentry (no match in `web/`). | skip (D4) | — | — |
| F05 | DEV (genie keeps) | `fbb6bdc` | `StarRepoNudge.tsx`, `optimize-and-export/page.tsx`, `save-and-load/page.tsx` | After a download, shows "Star the project on GitHub". | absent | The prompt promotes the upstream repository. The v2 deployment is a separate product. | NEEDS DECISION (D5). Recommendation: skip. | S | low |
| F06 | DEV (genie keeps) | `e367c70` `4462030` | `PageDocumentationLink.tsx`, `constants/urls.ts` (`DOCUMENTATION_URLS`), every page header, `ItemGroupEditorPage.tsx` | Replaces the inline "Instructions" toggle on each page with a help icon that opens the user guide (`/docs/user-guide/<page>/`) in a new tab. | absent | v2 has no page help or docs links. No match for help icons or `/docs/` in `web/components` or `web/app`. The v1 user guide is in v1 `docs/` (another lane). | adopt with adaptation, after docs exist (D6) | S (links) + L (docs) | low |
| F07 | DEV; genie adapts the YAML and the load check | `3d24faa` `dcb64d7`; genie `1b6f7e5` (FREEDAY → NON-WORKDAY in the YAML, `loadFromYaml` result check in `page.tsx`) | `app/page.tsx`, `page.test.tsx`, `public/examples/large-ward-with-87-people-2025-11.yaml` | A split New Schedule button with a menu: "Empty schedule" or "87-person example" (a realistic November 2025 ward). It shows a confirmation, a loading state and an error. | absent | v2 New Schedule makes an empty scenario (`web/lib/scenario/canonical.ts:357`). `web/public/` has no examples. Take the genie YAML, because it uses v2's NON-WORKDAY naming. UNVERIFIED: whether the v2 importer accepts the file without edits. | adopt with adaptation | M | low |
| F08 | DEV | `4e4b118` `b8354b3` | `hooks/schedulingState.ts`, `useSchedulingData.test.ts` | New schedules start empty (no default 10 people and 9 shift types), with the required `AT_MOST_ONE_SHIFT_PER_DAY` preference. | equivalent already | `createEmptyScenarioUiState` (`canonical.ts:357`). `mapPreferences` always emits max-one-shift-per-day (`canonical.ts:137-142`). | skip | — | — |
| F09 | DEV | `bfd5647` | `app/page.tsx`, `utils/version.ts` | The home page shows "This is a development build" only when the version is not a stable release tag. | absent | v2 has no such notice. v2 shows the version in `components/app-version.tsx` and the compatibility banner. | adopt with adaptation (optional) | S | low |
| F10 | DEV | `d95dbdd` `70e8a44` | `components/Footer.tsx`, `app/layout.tsx`, `constants/urls.ts` | Moves the existing footer into a component, hides it on the AI page, and changes "Contributors" to link to `CONTRIBUTORS.md`. The footer shows copyright, the privacy policy, the version and the AGPL-3.0 licence. | absent (pre-existing v1 footer never ported) | v2 has no footer. No match for AGPL, copyright or privacy in `web/`. | NEEDS DECISION (D1) | S | medium (licence attribution) |
| F11 | DEV | `0a7331b` (config), `568b1cb` `9710927` `10be1ac` `11a1b84` `d103b80` (spec) | `next.config.ts` (`allowedDevOrigins`), `e2e/allowed-dev-origins.spec.ts` | In development only, allows non-loopback LAN IPv4 origins, so that `next dev` hydrates when you open it from another device. | absent | v2 `web/next.config.ts` has no `allowedDevOrigins`. v2 runs Next `16.2.10` (`web/package.json:46`). | adopt with adaptation | S | low |
| F12 | DEV | `0e40939` | `next.config.ts` | `APP_VERSION_OVERRIDE` sets the stamped version in dev. | equivalent already | v2 `web/next.config.ts` keeps a preset `NEXT_PUBLIC_APP_VERSION`. | skip | — | — |
| F13 | DEV (genie keeps) | `e614d4b` `3707c90` `538c954` | `utils/personHistory.ts`, `schedulingReferenceUpdates.ts`, `schedulingGeneratedData.ts`, `shift-requests/page.tsx`, `e2e/shift-type-rename-cascade.spec.ts` | When a shift type is deleted, v1 truncates each person's history to the suffix after the deleted entry, instead of blanking the entry to `""`. It also repairs stored state with blank slots at load, and shows `—` for an empty slot. | conflicts | v2 blanks the entry by contract FR-RI-09 (`web/lib/cascade/delete.ts:102-109`). The v2 producer then reports `Unknown shift type ID in history: ''` (`web/lib/scenario/schemas/producer.ts:394-404`). v2 core also rejects it (`core/nurse_scheduling/models.py:568-569`). So in v2, deleting a shift type that appears in history makes the scenario invalid until the user edits the history. | adopt with adaptation: change FR-RI-09 (D7) | S | medium (spec change) |
| F14 | DEV (genie keeps) | `83d5225` `eea51bf` `030009a` (revert) `4add8db` (final) | `utils/countShiftTypeCoefficients.ts` and its test | Count coefficient eligibility expands nested shift-type groups recursively, with a cycle guard, so that a group of groups is offered correctly. | absent (same defect) | v2 `web/components/card-editor/coefficient-model.ts:43-48` expands only one level, the same as pre-fix v1. | adopt with adaptation | S | low |
| F15 | DEV (genie keeps) | `2781d0e` | `hooks/schedulingStorage.ts` and its test | Escapes a stored string that equals the Infinity placeholder, so that it does not come back as a number from localStorage JSON. | not applicable | v2 persists through IndexedDB structured clone, which keeps ±Infinity natively (`web/lib/store/persistence.ts:722-737`). | skip | — | — |
| F16 | DEV | `0249f67` `ab71cfd` `663861b` `7594f40` `8142e57` | `DataTable.tsx`, `TableColumns.tsx` and tests | Per-column widths, an opt-in fixed layout, table test ids, and a restored action-column width. | not applicable | These are v1 component internals. v2 has its own tables. | skip | — | — |
| F17 | DEV, v2-excluded feature | `ea560c0` + `9fd5250` (disable, then restore: no net change), `b1a444d`, `a95f50d` | `export-layout/page.tsx`, `Navigation.tsx`, `useSchedulingData.ts`, `features.ts` (added and then removed), `e2e/export-layout-nav-indicator.spec.ts` | An amber dot on the Export Layout tab when a custom layout is saved, with copy that says that saving pins the layout. Also memoises the generated default layout. | intentionally excluded | Export Layout is deferred and user-gated (`DESIGN.md` §1, Export Layout row, `qq0.15`). | skip now. Record in `qq0.15` for the time when the route is built. | — | — |
| F18 | GENIE | `ecb5eee` | `utils/singaporeHolidays.ts` and its test | The supported import range runs from 1 January of the first listed year to 31 December of the last listed year, not only to the last holiday. | absent (same defect) | v2 `web/lib/dates/holidays-sg.ts:116-122` returns the first and last holiday dates. So a roster that ends 31 Dec 2027 is "unsupported" (the last entry is 2027-12-25). | adopt with adaptation | S | low |
| F19 | GENIE | `0320d3e` | `shift-type-coverings/page.tsx` and its test | The covering rule keeps the selected dates on save. It omits `date` only when no date is selected. | equivalent already | `web/components/coverings/coverings-model.ts:281`. | skip | — | — |
| F20 | DEV + GENIE | `5e1b11c` `d103b80` `a924757` `8cf1cd6` `6e9d7a8` `97c0896` `5aa5d4f` `7b534d3` `6db06f8` `c201859` `3621c6b` (version 0.2.0); genie `6b2f274` (adapts specs, parks AI specs behind `RUN_AI_E2E=1`) | e2e specs and helpers, `playwright.config.ts`, `scripts/*.mjs`, `vitest.config.ts`, `package.json`, `bun.lock`, `AGENTS.md` | Test and tooling only: explicit E2E seeding, an OS-chosen E2E port, compact reporters, dependency bumps, and agent guidance. | not applicable | v2 has its own pnpm, Vitest and Playwright setup. | skip | — | — |

### 2b. AI chat (`/experimental-ai`)

Every row here depends on the v1 AI service in core: `core/nurse_scheduling/ai/app.py:887-1334` (`/capabilities`, `/sessions`, `/sessions/{id}/messages`, `/sessions/{id}/events`). That service has about 144 commits in `89190ab..dev`. Genie keeps the page, adds Singapore holidays to the session payload (`aiClient.ts` genie vs dev), and parks its E2E specs (`6b2f274`). v2 does not have this service. v2's assistant is CopilotKit with OpenRouter, BYO-key and client-direct, and it is off by default (`docs/ai-assistant.md`). So the "v2 status" column compares user-facing capability only.

| ID | Origin | v1 commits | What it does | v2 status (evidence) | Proposed action | Effort | Risk |
|---|---|---|---|---|---|---|---|
| A01 | DEV | `99a3913` `0a7331b` `10be1ac` `e5e3686` `dc72450` `d84c768` `89a19e5` `c018fe7` `bfc6d37` `cdeaa11` | The page scaffold and nav tab ("12. Experimental AI"), a hosted or custom AI server with a bearer token, an official-endpoint check, and a beta privacy notice | equivalent-different: Settings → AI assistant card, BYO OpenRouter key, "Save and test" (`web/components/settings/ai-assistant-card.tsx`). There is no nav item while disabled (`DESIGN.md` §1, AI row). | skip (architecture) | — | — |
| A02 | DEV | `0a7331b` `9710927` `9802cb0` `fa87c02` | Attachments: images, text documents, PDF and XLSX (server-side ingestion), and drag-and-drop | missing (no attachment handling in `web/components/ai`) | NEEDS DECISION (D8). Recommendation: images and plain text first. | M | medium (privacy) |
| A03 | DEV | `c74edbd` `c36058f` `b562f2d` | Markdown rendering of replies (`react-markdown` + `remark-gfm`) and chat navigation | present (CopilotKit markdown path, `web/components/ai/assistant-panel.test.tsx:390`; styling `web/app/globals.css:806-874`) | skip | — | — |
| A04 | DEV | `319dd3d` `f05c34a` `42655c9` | Reasoning and tool-activity timeline, with tool calls streamed before execution | partial (activity status `web/components/ai/assistant-conversation.tsx:101`; persisted `reasoning` role `web/lib/ai/assistant/messages.ts:21`) | skip | — | — |
| A05 | DEV | `3ec9e10` `c7cc1a2` `2ade8f2` `8a0bd47` `f51e9ec` | Review and approve proposed schedule changes, first by tools and later by a Bash sandbox with validated edit previews | present-different: `prepare_scenario_change` → Preview → Apply (`web/components/ai/proposal-preview-card.tsx`). The sandbox is excluded. | skip | — | — |
| A06 | DEV | `db805d4` `6966f31` | A one-click Retry on a failed turn, which replaces the failed turn | partial: the text says "Send again to retry" (`web/lib/ai/assistant/lifecycle.ts:200-206`), but there is no Retry control | adopt with adaptation | S | low |
| A07 | DEV | `76aae25` `a1442b7` `6cd5535` | Reliable Stop, held until the turn really ends | present (`web/components/ai/assistant-stop-control.test.tsx`, `web/lib/ai/assistant/runtime-stop.ts`) | skip | — | — |
| A08 | DEV | `53a1b2c` `a23e862` `7a5e10f` | You can type while a reply runs. The messages queue as in-turn steering, grouped before one response, with a "queued" status. | UNVERIFIED / likely missing. No queued-message UI was found. `web/lib/ai/assistant/send-gate.ts` gates sends. | NEEDS DECISION (D9) | M | medium |
| A09 | DEV | `481d8c3` `d3cd3f3` `17d3171` `ff901c8` `b385851` `fb1f2d5` | Voice dictation (Web Speech API) with language selection, Firefox guidance, and composer icon controls | missing (no `SpeechRecognition` in `web/`) | NEEDS DECISION (D8) | M | medium (Chrome sends audio to Google) |
| A10 | DEV | `bf8e40f` `cb4bb82` `cd9bf37` | Export the chat transcript as a file, with the app version and styled optimizer messages | missing | adopt with adaptation | S-M | low |
| A11 | DEV | `e13406a` | Show the response time for each reply | missing | adopt with adaptation (optional) | S | low |
| A12 | DEV | `d949f46` `28f69df` `a3c4d3f` `63d550d` `1d46068` | Chats kept across navigation and reload, flushed on page exit, a "stored in this browser" warning, and stale turns discarded | present (IndexedDB `web/lib/ai/assistant/history-repo.ts`; `web/components/ai/session-persistence.test.tsx`). The storage warning is only in the docs and the welcome text (partial). | skip | — | — |
| A13 | DEV (core + web) | `f957bc9` `d21c3d2` `1bbcb94` | A warning when the prompt drops older messages to fit the context | missing. UNVERIFIED: whether v2 trims history before it sends. | investigate, then adopt with adaptation | S | low |
| A14 | DEV | `fd86e5e` `c981030` `1889841` `767a10d` `2079ca9` `43e2554` `84db6fb` `b3c3c14` | A background optimizer tool: the AI starts runs, streams progress into the chat, and offers result downloads | present-different: `request_optimize_run` card. The user presses Run, and the run goes through the Optimise screen (`web/components/ai/optimize-run-request-card.tsx`; `docs/ai-assistant.md`, 2026-09-24). | skip (the v2 product decision is that the user starts runs) | — | — |
| A15 | DEV | `3d75cef` `1e296cb` `746a0bf` `2dc9baf` | Reopens the event stream after a drop and resumes a background turn after a reload | present (per `web/lib/ai/assistant/runtime-stop.ts` and `history-repo.ts` recovery; not re-tested) | skip | — | — |
| A16 | DEV | `1491cbe` | Includes the default export layout in the AI context | intentionally excluded (Export Layout is deferred) | skip | — | — |
| A17 | DEV | `11a1b84` | The sandbox can inspect arbitrary files | intentionally excluded (no sandbox in v2) | skip | — | — |
| A18 | DEV | `d95dbdd` `9f56b85` `d72fb70` | Conversation-flow polish, "AI generated" file markers, and correlated provider errors (tests only in web) | not applicable | skip | — | — |

## 3. Dependencies and order

1. Lock the baseline first. Every sync step must use `d63519b..feature/genie`, not `d63519b..dev`.
2. F02 (token) depends on lane core adopting v1 `server/auth.py` and the `auth` descriptor in `/info`. Land the core change first, then add the BFF token secret.
3. F03 (timeout bounds) depends on lane core adopting `GET /optimize/options`. Then add a BFF route, then the UI.
4. F01 activity or claimed performance (if chosen) depends on the `/info` fields `jobs`, `workers` and `claimed_performance` (v1 `server/app.py:326-390`, `server/config.py:133-203`), and on v2 `app/api/info/validate.ts` passing them through.
5. F06 docs links depend on a v2 user guide that exists and is served. The v1 guide is in v1 `docs/`, in another lane.
6. F07 (example) is independent. Use the genie YAML (NON-WORKDAY). It does not depend on F06.
7. F13, F14 and F18 are independent small fixes. You can do them first. F13 needs D7 first.
8. A02, A06, A08-A11 and A13 are independent of core. They depend only on the v2 assistant panel.

## 4. Open decisions for the user

| # | Decision | Recommendation |
|---|---|---|
| D1 | Show a copyright, licence (AGPL-3.0) and privacy footer or About section? v1 shows one on every page. v2 shows none, and v2 vendors AGPL core. | Yes. Add a small attribution and licence line (footer or Settings → About). This is a legal question, so confirm with the owner. |
| D2 | Adopt v1 backend bearer authentication? | Only if the backend is reachable by anyone other than the BFF. If you adopt it, keep the token server-side in the BFF and put no token UI in the browser. |
| D3 | Show backend activity (queue and workers) or claimed performance on the Optimise screen? | Skip claimed performance, because v2 has one backend. Optional: show queue length before Run. |
| D4 | Restore Sentry and the optimisation feedback rating? | No. Genie removed them (`64c84a3`, and again in `1b6f7e5`). Keep them excluded unless you want error telemetry. |
| D5 | Add the "Star on GitHub" nudge? | No. It promotes the upstream repository in a separate product. |
| D6 | Add per-page "open user guide" links? | Yes, after a v2 user guide exists. Until then, skip. |
| D7 | Change FR-RI-09 so that a shift-type deletion truncates the history suffix, as in v1, instead of blanking to `""`? | Yes. The blank makes the scenario invalid in v2 and in core. |
| D8 | Allow AI attachments and dictation? Both send more data to third parties. | Allow images and text attachments behind the existing AI opt-in. Defer PDF/XLSX parsing and dictation. |
| D9 | Allow queued "steering" messages while a reply runs? | Defer. It conflicts with v2 send-authority gating. Revisit after the Phase 2 operation families. |

## 5. Bead drafts (not filed)

These drafts are ready to file. Do not run `bd`. File them after the matching decision is made.

### B-F07: Home: add an "87-person example" new-schedule option

Description: v1 `3d24faa` added a split New Schedule button: Empty schedule or a realistic 87-person November 2025 ward example. Port the genie version of `public/examples/large-ward-with-87-people-2025-11.yaml` (it uses NON-WORKDAY). Load the file through the normal import path, with confirmation and error states.

Acceptance criteria:

- The Home New Schedule control offers Empty and Example. The Empty option keeps today's behaviour.
- Example loads through `import-scenario`, and the load produces no validation issues.
- A failed fetch or import shows an error and keeps the current schedule.
- A Playwright spec covers both choices.

### B-F13: Cascade: truncate a person's history at a deleted shift type (replaces FR-RI-09 blanking)

Description: v2 `lib/cascade/delete.ts:102-109` blanks deleted shift-type ids in history to `""`. The producer (`producer.ts:394-404`) and core (`models.py:568`) then reject the scenario. v1 `e614d4b` keeps only the suffix after the last unusable entry, because history is right-anchored. v1 also repairs stored state at load.

Acceptance criteria:

- Deleting a shift type used in history leaves the valid suffix.
- No `""` entry remains after the deletion.
- A persisted scenario with `""` history is repaired on load.
- The spec FR-RI-09 and `cascade.test.ts` are updated.

### B-F14: Counts: expand nested shift-type groups for coefficient eligibility

Description: `web/components/card-editor/coefficient-model.ts:43-48` expands a group one level only. A group of groups is therefore never eligible. Port v1's final recursive expansion with a cycle guard (`4add8db`).

Acceptance criteria:

- Selecting a nested group makes its leaf items and its fully-covered groups eligible.
- A cyclic group does not hang.
- Unit tests cover the nested, reordered and cyclic cases.

### B-F18: Dates: Singapore holiday import covers whole calendar years

Description: `web/lib/dates/holidays-sg.ts:116-122` ends the supported range at the last listed holiday (2027-12-25). A roster that ends on 31 December is therefore refused. Genie `ecb5eee` extends the range from 1 January of the first listed year to 31 December of the last listed year.

Acceptance criteria:

- `getSupportedRange()` returns `YYYY-01-01` to `YYYY-12-31`.
- A range that ends 2027-12-31 is supported.
- The support label and the tests are updated.

### B-F11: Dev: allow LAN origins in `next dev`

Description: v1 `0a7331b` sets `allowedDevOrigins` in development only, from non-internal IPv4 interfaces. Without it, opening the dev server from another device does not hydrate.

Acceptance criteria:

- `web/next.config.ts` adds `allowedDevOrigins` only when `NODE_ENV=development`.
- The production build is unchanged.
- A manual check from a LAN IP hydrates the app.

### B-F10: Shell: copyright and licence attribution (after D1)

Description: v1 shows copyright, contributors, the privacy policy, the version and AGPL-3.0 on every page (`components/Footer.tsx`). v2 shows none of these.

Acceptance criteria:

- An attribution and licence line with the version is visible from every route, or from Settings → About.
- The links open in a new tab.
- The line obeys `DESIGN.md` (the L1 notice role, no free-floating L0 children).

### B-F03: Optimise: take the timeout default and bounds from the backend (after core adopts `/optimize/options`)

Description: v1 `417d632` reads the solver options, including the timeout default, minimum and maximum. v2 hard-codes the default and lets core reject an out-of-range value.

Acceptance criteria:

- A BFF route proxies the options.
- The timeout input shows the backend default and clamps to its bounds.
- The UI falls back to today's defaults when the route is absent.
- No solver selector is added (U31 keeps CP-SAT only).

### B-F02: BFF: send a backend bearer token (after D2 and core auth)

Description: v1 `8142e57` adds optional bearer authentication. In v2 only the BFF talks to core, so the token is a server secret.

Acceptance criteria:

- An env var (for example `BACKEND_API_TOKEN`) is attached as `Authorization: Bearer` on every BFF → core request, including the event stream.
- The token never reaches the browser, the logs or the errors.
- A 401 maps to a clear "backend credentials rejected" state.

### B-F09: Home: development-build notice only on non-release builds

Description: v1 `bfd5647` shows "This is a development build" when the version is not a stable tag.

Acceptance criteria:

- The notice shows for `-N-gHASH`, `-dirty` or hash-only versions, and hides for `vX.Y.Z`.
- The notice reuses `lib/version/version-compat.ts` parsing.

### B-A06: Assistant: one-click Retry for a failed turn

Description: v2 tells the user "Send again to retry" (`lifecycle.ts:200-206`). v1 `db805d4` and `6966f31` add a Retry control that replaces the failed turn.

Acceptance criteria:

- A failed or interrupted turn shows Retry.
- Retry resends the same user message and replaces the failed assistant turn.
- Retry obeys send-gate authority.

### B-A10: Assistant: export the conversation transcript

Description: v1 `bf8e40f` exports the chat as a file with the app version.

Acceptance criteria:

- The panel offers Download transcript (Markdown).
- The file includes the version, the timestamps, the user and assistant turns, and the tool and receipt summaries.
- The file never includes the API key.

### B-A11: Assistant: show response time per reply

Description: v1 `e13406a`.

Acceptance criteria:

- Each settled assistant turn shows its elapsed time.
- A stopped or failed turn shows no misleading value.

### B-A13: Assistant: warn when older messages are left out of the prompt

Description: v1 `f957bc9` warns when history is trimmed. First find out whether v2 trims or bounds history before it sends.

Acceptance criteria:

- If v2 trims, the panel shows a one-line notice in that conversation.
- The notice clears with the conversation.

### B-A02: Assistant: image and text attachments (after D8)

Description: v1 `0a7331b`, `9710927` and `fa87c02`. Add drag-and-drop and a picker for images (only for vision-capable models) and plain text.

Acceptance criteria:

- Attachments are sent only when AI is Ready.
- The UI enforces size and type limits.
- A non-vision model disables image attach with a reason.
- Attachments are stored with the conversation and cleared by Clear history.

## 6. Coverage note

The scope is `git diff --name-status d63519b feature/genie -- web-frontend`: 105 files. All paths are under `web-frontend/`.

| File | Row |
|---|---|
| `bun.lock`, `package.json`, `playwright.config.ts`, `vitest.config.ts`, `scripts/choose-e2e-port.mjs`, `scripts/generate-e2e-coverage.mjs` | F20 (`generate-e2e-coverage.mjs` also F03) |
| `e2e/allowed-dev-origins.spec.ts` | F11 |
| `e2e/experimental-ai-basic.spec.ts`, `e2e/experimental-ai-proposal.spec.ts` | A01-A17 (parked by genie `6b2f274`) |
| `e2e/export-formatting-reorder-edit-undo-redo.spec.ts` | F20 |
| `e2e/export-layout-nav-indicator.spec.ts` | F17 |
| `e2e/helpers.ts` | F01, F02, F03, F20 |
| `e2e/home-new-schedule.spec.ts` | F08, F20 |
| `e2e/navigation-arrow-buttons.spec.ts`, `e2e/navigation-shortcuts.spec.ts`, `e2e/people-add-form-cancel-reset.spec.ts`, `e2e/save-load-roundtrip.spec.ts`, `e2e/save-load-edit-cancel-upload-boundary.spec.ts`, `e2e/save-load-new-schedule-restore.spec.ts`, `e2e/save-load-refresh-after-upload.spec.ts`, `e2e/save-load-reset-restore-downstream.spec.ts`, `e2e/save-load-upload-completion.spec.ts`, `e2e/save-load-upload-undo-redo-route.spec.ts`, `e2e/shift-types-duplicate-recovery-roundtrip.spec.ts`, `e2e/undo-redo-depth.spec.ts`, `e2e/undo-redo-shortcuts.spec.ts`, `e2e/rename-save-load-roundtrip.spec.ts` | F20 |
| `e2e/optimize-and-export-auth.spec.ts` | F02 |
| `e2e/optimize-and-export-options.spec.ts` | F03 |
| `e2e/optimize-and-export-error.spec.ts`, `e2e/optimize-and-export-http-server.spec.ts`, `e2e/optimize-and-export.spec.ts` | F01, F02, F03, F20 |
| `e2e/optimize-and-export-edited-yaml-body.spec.ts`, `e2e/optimize-and-export-live-state-body.spec.ts`, `e2e/optimize-and-export-noop-edit-body.spec.ts`, `e2e/optimize-and-export-repeat-after-edit.spec.ts`, `e2e/optimize-and-export-undo-redo-body.spec.ts` | F20 |
| `e2e/shift-type-rename-cascade.spec.ts` | F13 |
| `next.config.ts` | F11, F12 (the dev Sentry changes are dropped by genie: F04) |
| `public/examples/large-ward-with-87-people-2025-11.yaml` | F07 |
| `src/app/dates/page.tsx` | F06 |
| `src/app/experimental-ai/*` (10 files: `AssistantActivity`, `AssistantMarkdown`, `aiClient`, `chatExport`, `page`, each with its test) | A01-A18 |
| `src/app/export-layout/page.tsx`, `src/app/export-layout/page.test.tsx` | F17, F06 |
| `src/app/layout.tsx` | F10 |
| `src/app/optimize-and-export/page.tsx`, `page.test.tsx`, `serverSelection.ts` | F01, F02, F03, F05 |
| `src/app/page.tsx`, `src/app/page.test.tsx` | F07, F09, F06 |
| `src/app/people/page.tsx`, `shift-affinities/page.tsx`, `shift-counts/page.tsx`, `shift-type-requirements/page.tsx`, `shift-type-successions/page.tsx`, `shift-types/page.tsx` | F06 |
| `src/app/shift-requests/page.tsx` | F06, F13 |
| `src/app/save-and-load/page.tsx`, `page.test.tsx` | F05, F06 |
| `src/app/shift-type-coverings/page.tsx`, `page.test.tsx` | F19 |
| `src/components/BackendTokenField.tsx`, `.test.tsx` | F02 |
| `src/components/DataTable.tsx`, `.test.tsx`, `TableColumns.tsx`, `.test.tsx` | F16 |
| `src/components/Footer.tsx`, `.test.tsx` | F10 |
| `src/components/ItemGroupEditorPage.tsx`, `.test.tsx`, `.programmatic.test.tsx` | F06 |
| `src/components/Navigation.tsx`, `.test.tsx` | F17, A01 |
| `src/components/PageDocumentationLink.tsx`, `.test.tsx`, `src/constants/urls.ts`, `urls.test.ts` | F06 (`urls.ts` also F10, A01, A09) |
| `src/components/StarRepoNudge.tsx` | F05 |
| `src/hooks/schedulingGeneratedData.ts`, `schedulingReferenceUpdates.ts`, `.test.ts` | F13 |
| `src/hooks/schedulingState.ts`, `useSchedulingData.test.ts` | F08 |
| `src/hooks/schedulingStorage.ts`, `.test.ts` | F15 |
| `src/hooks/useSchedulingData.ts` | F17 |
| `src/utils/backendAuth.ts` | F02 |
| `src/utils/countShiftTypeCoefficients.ts`, `.test.ts` | F14 |
| `src/utils/personHistory.ts`, `.test.ts` | F13 |
| `src/utils/singaporeHolidays.ts`, `.test.ts` | F18 |
| `src/utils/version.ts`, `.test.ts` | F09 |

These files are in `89190ab..dev` but are not in the genie scope, because genie removes them. Each one maps to F04, except `AGENTS.md`:

- `AGENTS.md` (F20)
- `sentry.edge.config.ts`
- `sentry.server.config.ts`
- `src/instrumentation-client.ts` and its test
- `src/components/OptimizationFeedbackNudge.tsx` and its test

`e2e/floating-widgets.spec.ts` (a check that the build selector does not overlap the Feedback button) did not change in `89190ab..dev`. It appears in `d63519b..dev` only because genie deleted it together with Sentry (F04).

The older e2e specs are a feature index: none of their changes introduces a new feature beyond the rows above.
