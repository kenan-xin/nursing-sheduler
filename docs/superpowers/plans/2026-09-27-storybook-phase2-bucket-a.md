# Storybook Phase 2 (Bucket A, pure presentational) Implementation Plan

Confidence: 7.1/10

Phase 1 (w0e.2, branch `feat/w0e2-storybook-phase1`, commit `0286795` + develop merge `2492a75`) is built and green: `pnpm test:stories` runs 27 stories at `a11y.test: "error"`. I also ran a path-filtered story run (`pnpm test:stories components/ui/button.stories.tsx` → 10 passed, 2.6 s), so each agent can test only its own files. I read the props, variants and test ids of every component this plan assigns. Three things raise the score: the conventions are already concrete, every Bucket A member takes plain props, and none of the work touches a shared file. Four things lower it. (1) **The bead's count of 43 is stale.** It dates from 2026-07-26, when `web/components` had 100 `.tsx` files. It has 142 now. The same bucket rules applied to today's code give **54** components, and no written July list exists to reconcile against (see "Deriving Bucket A"). (2) Nobody knows how many real components will fail axe or the long-text rule. Each failure costs a bead, so the bead count can be large. (3) Whether axe scans portalled dialog content has not been checked. Task 2 settles it with a mutation check. (4) Five agents running Chromium story tests at once in five worktrees has not been tried.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 2–6 are independent and are meant to run as **five parallel agents**. Task 1 must finish before they start. Task 7 runs after all five.

**Goal:** Give every Bucket A component (props-only, pure presentational) a colocated `*.stories.tsx`. Each file covers every variant and named state, plus a dark-theme story and a long-text story where user text is shown. Every handler prop gets a `fn()` interaction test. All of it passes axe at `test: "error"`.

**Architecture:** This phase adds story files and nothing else. Task 1 adds one shared, read-only helper module (`.storybook/story-helpers.tsx`: long-text fixtures, a narrow frame and an overflow assertion) together with its self-check stories. The five groups then write stories next to their components, in disjoint directories. No production file changes. A real defect found by a story (axe or overflow) becomes a bead, and only that one assertion is relaxed.

**Tech Stack:** Storybook 10.6 (`@storybook/nextjs-vite`, addon-vitest, addon-a11y, addon-docs), Vitest 4.1.10 browser mode (Playwright Chromium), `storybook/test` (`expect`, `fn`, `userEvent`, `screen`, `waitFor`), Base UI (`@base-ui/react`) primitives, Oxlint + ast-grep, oxfmt.

**Spec:** bead `nursing-sheduler-w0e.3` (quoted in full: *"Props-only components. Full variant coverage + fn() interaction tests where a handler exists. Colocated \*.stories.tsx. Disjoint directories per agent."*). Parent epic `nursing-sheduler-w0e`: acceptance says *"pnpm test:stories green incl a11y at test:error; pnpm test (unit) and pnpm exec playwright test (e2e) unchanged; typecheck/lint/format green over all story files."* The sibling buckets define A by what it excludes. B is *"Components needing theme/QueryClient/router mock only."* C is *"Zero-prop components driven by … withScenarioStore."* D is *"SSE, Dexie, file upload, FullCalendar, 15KB+ screens."* Phase 1 plan: `docs/superpowers/plans/2026-09-27-storybook-phase1.md` (on branch `docs/w0e2-storybook-plan`). Phase 1 report: `/tmp/wave/w0e2.report.md`. `DESIGN.md` §2–§5. `docs/design_prototype/`. bd memory `long-user-text-no-overflow`.

## Global Constraints

- **Stories only.** Each group adds `*.stories.tsx` files under its own directories and nothing else. It edits no production component, no `.storybook/` file (the one exception is Task 1), no config and no lockfile. If a component cannot be storied without a change, stop and report it. Do not work around it.
- Colocate the story as `<component>.stories.tsx` beside `<component>.tsx`. The story glob (`../components/**/*.stories.tsx`) already picks it up.
- Title is `<Area>/<Component>`. Area is the PascalCase `components/` subfolder: `UI`, `CardEditor`, `Affinities`, `Coverings`, `Successions`, `Counts`, `Requirements`, `EntityEditor`, `Dates`, `Requests`, `Home`, `Optimize`, `SaveLoad`, `Shell`, `RosterViewer`. `components/app-version.tsx` has no folder and uses `App/AppVersion`. Component is the exported PascalCase name.
- Every story inherits `parameters.a11y.test = "error"` from `preview.tsx`. Never set `a11y.test` to anything else except under the a11y-failure rule below. Never disable an axe rule.
- Stories are **test/support code** under the acquisition boundary. That means no `node:fs`, no `require`, no `createRequire`, no parser libraries, and no literal `.ts`/`.tsx` reads. `pnpm lint` rejects these.
- DESIGN.md: render the real component on real tokens. No hex/rgb literals, no Tailwind default-palette utilities (`bg-red-500`), no untokened shadows, and no restyling `className` on `Surface` consumers. `authored-color-literal`, `tailwind-default-palette-utility`, `untokened-shadow-utility`, `surface-consumer-classname` and `capability-anchor-literal-attribute` all scan `components/**`, and that includes stories. Size wrappers can use plain layout utilities on a `<div>` (`w-80`, `max-w-md`, `h-96`).
- Do not re-story `ui/button`, `ui/select` or `ui/dropdown-menu`. They are already storied.
- Copy UK English and use arbitrary shift codes. Fixture shift ids and names must not be hard-coded `AM`/`PM` assumptions. Use ids like `early1`, `late+`, `N12`.
- Formatting follows `.oxfmtrc.json`: 2 spaces, double quotes, semicolons, trailing commas, width 100.
- **a11y failure on a real component:** do not change the component. File `bd create "a11y: <Component> <axe-rule-id>" -t bug --parent nursing-sheduler-w0e`. Then set **that story only** to `parameters: { a11y: { test: "todo" } }` with the comment `// a11y violation tracked in <bead-id>; restore "error" when fixed`. List it in the hand-off.
- **Long-text failure on a real component:** do not change the component. File `bd create "overflow: <Component> long <slot>" -t bug --parent nursing-sheduler-w0e`. Keep the `LongText` story, which still renders and still runs axe. Delete only the failing assertion line and put this comment in its place: `// KNOWN OVERFLOW <bead-id>: restore <the assertion> when fixed`. List it in the hand-off.
- Conservative git profile. Commit per group. Do **not** push, merge into `develop` or open a PR. Integration merges happen only between local branches (Task 7).

## Review Focus

1. **Long user-entered text** (shift codes, person and group names, card descriptions, server messages) in a narrow container. Expectation: no horizontal overflow. Single-line slots truncate with an ellipsis and expose the full text through `title`. Prose wraps. Pinned by the `LongText` story that each group table marks, using the Task 1 helpers.
2. **Dark theme contrast.** A component that passes axe in light mode can fail `color-contrast` in dark mode. Pinned by one `Dark` story per file (`globals: { theme: "dark" }`) on the file's richest state.
3. **Portalled content** (dialogs, alert dialogs, combobox popups). `canvas` does not contain it, and it is not yet known whether axe scans it. Pinned in Task 2 Step 4: a mutation check proves axe sees portal content, and every portal story queries through `screen`.
4. **A disabled control still firing its handler.** Pinned by every `Disabled` story. It clicks the control and asserts the `fn()` was **not** called.
5. **Empty collections** (tables, lists and chip sets with zero rows). Expectation: the component's own empty-state copy, not a blank box. Pinned by the `Empty` stories in the group tables.

---

## Deriving Bucket A

There is no recorded per-component list. The only sources are the bead descriptions, whose 43/12/20/29 counts sum to 104 over the July tree, and a July session that holds only the bead JSON. So membership here is derived from code, on `feat/w0e2-storybook-phase1` (`2492a75`), using these rules.

A file under `web/components/**/*.tsx` (excluding `*.test.tsx` and `*.stories.tsx`) is **Bucket A** when all of the following hold:

1. **Props determine the render under the global preview alone.** The preview supplies theme, a fresh QueryClient and a reset of the transient stores. The file must not use, directly or through an imported component: `@/lib/store` (scenario, hot or authority stores), the assistant store or `@/lib/ai`, the mode store (`useAppMode`), `useTheme`, `next/navigation` or `GuardedLink`/`useGuardedNavigation`, React Query, `fetch`, or `sonner` `toast()`. Reading **only** the globally reset transient stores is allowed, because their initial state needs no setup. Those are `useChangeTarget`/`useChangeHighlightKeys` (change-highlight) and `useLosableDraft` (nav-guard). Their non-default states (a highlighted card, a registered draft) belong to Bucket C.
2. **Not Bucket D.** No FullCalendar, no file upload (`type="file"`, `FileReader`), and file size under 15 KiB. There is one exception: `ui/surface.tsx` (16.8 KB) is a recipe table for a primitive, not a screen.
3. **A component.** `icons.tsx` is a re-export barrel. `theme-script.tsx` and `side-collapse-script.tsx` inject inline scripts. None of these three is storied.

Result: **54 components.** 11 more than the bead's 43. Unresolved question 1 asks whether to keep all 54 (the default) or cap the phase.

Every other component is outside Bucket A. The suggested owner below is advisory. Phases 3–5 make the final call.

| Reason | Files | Suggested owner |
|---|---|---|
| Already storied (Phases 0/1) | `ui/button`, `ui/select`, `ui/dropdown-menu`, `optimize/readiness-banner`, `save-load/backup-status-badge`, `optimize/progress-chart/progress-chart` | done |
| Navigation / theme / mode only | `shell/guarded-link`, `optimize/run-status-panel`, `shell/app-side-nav`, `shell/mobile-nav`, `shell/sidebar-nav`, `shell/mode-toggle`, `home/home-advanced`, `theme/theme-toggle`, `theme/theme-provider` | B |
| Scenario / authority / hot store | `save-load/anonymise-card`, `save-load/scenario-file-card`, `save-load/scenario-yaml-preview`, `shell/persistence-status`, `shell/undo-redo-controls`, `shell/ownership-banner`, `home/home-guided`, `home/home-screen`, `requirements/requirement-card-list`, `optimize/cover-preflight`, `dates/dates-screen` | C |
| FullCalendar | `dates/month-calendar`, `dates/month-grids`, `dates/calendar-view`, `dates/date-scope-picker`, `dates/date-groups-card` | D |
| File upload | `save-load/upload-modal`, `requests/requests-csv-modal`, `people/upload-dialog`, `roster-viewer/roster-actions` | D |
| ≥ 15 KiB composite | `counts/count-card-list`, `counts/contracted-form`, `entity-editor/transfer-list`, `entity-editor/groups-section`, `guided-rules/rule-row`, `requirements/requirement-form`, `requests/requests-matrix`, `card-editor/card-editor-shell`, `roster-viewer/roster-day`, `roster-viewer/roster-coverage`, `roster-viewer/roster-grid` | D |
| Editors / screens / shell / AI (hooks, toast, stores) | the `*-editor.tsx`, `*-screen.tsx`, `people/*`, `shift-types/*`, `save-load/save-load-workspace`, `settings/*`, `shell/{app-shell,hydration-gate,top-bar,test-bridge,new-schedule-button}`, `roster-viewer/{roster-section,roster-viewer,roster-screen,working-roster-panel,roster-content-width}`, `optimize/optimize-and-export-screen`, `ai/*` | C/D |
| Not a component | `icons`, `theme/theme-script`, `shell/side-collapse-script` | none |

`card-editor-shell` and `transfer-list` fall in D as files, but the Bucket A forms render them, so their parts still show up in the workbench through those forms.

---

## Story conventions (every agent)

Copy the structure of the Phase 1 reference `web/components/ui/button.stories.tsx`:

```tsx
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn } from "storybook/test";
import { Thing } from "./thing";

const meta = {
  title: "Area/Thing",
  component: Thing,
  // Every handler prop is a spy at meta level, so any story can assert it.
  args: { label: "…", onChange: fn() },
} satisfies Meta<typeof Thing>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "…" }));
    await expect(args.onChange).toHaveBeenCalledWith(/* exact args */);
  },
};
```

Rules:

- **`satisfies Meta<typeof X>`**, not `: Meta`. Use `StoryObj<typeof meta>`. Put every required prop in meta `args` so that each story only overrides what differs.
- **Handlers:** every function prop gets `fn()` in meta `args`. Each handler gets at least one `play` that triggers it through the UI and asserts `toHaveBeenCalledWith(<exact args>)`. Use `toHaveBeenCalledOnce()` where the component promises exactly one call. A handler that fires only on a path the component cannot reach from props alone is noted in a comment, not faked.
- **Queries:** prefer role and accessible name (`getByRole("button", { name })`). Use `getByTestId` only where the component exposes a `data-testid` and has no accessible name. Query **portalled** content (Base UI `Dialog`, `AlertDialog`, `Combobox` popups) with `screen` from `storybook/test`, not `canvas`. Wrap anything that appears asynchronously in `await canvas.findBy…` or `waitFor`.
- **Layout:** the default is `centered`. Wide components (tables, forms, toolbars, panels) set `parameters: { layout: "padded" }` at meta level. `centered` collapses a full-width component to its intrinsic width.
- **Dark:** every file exports exactly one `Dark` story. It sets `globals: { theme: "dark" }` and reuses the args of the file's richest state (for example `args: { ...Populated.args }`). It has no play; axe is the test. Declare it **last** in the file, so that the following light story proves the theme reset (the Phase 1 `Harness/Providers` pattern).
- **Long text:** use the Task 1 helpers, never an ad-hoc long string:

  ```tsx
  import { LONG_PROSE, LONG_TOKEN, expectNoHorizontalOverflow, withNarrowFrame } from "../../.storybook/story-helpers";

  export const LongText: Story = {
    decorators: [withNarrowFrame],
    args: { name: LONG_TOKEN, description: LONG_PROSE },
    play: async ({ canvas, canvasElement }) => {
      await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
      // Single-line slot: the full value must stay discoverable.
      await expect(canvas.getByTitle(LONG_TOKEN)).toBeVisible();
    },
  };
  ```

  The two slot kinds are asserted differently. A **single-line slot** (chip, pill, table cell, list row, heading in a row, option label) must truncate with an ellipsis and expose the full value through `title`, per bd memory `long-user-text-no-overflow`. A **prose slot** (description, dialog body, message) must wrap. For those, assert only `expectNoHorizontalOverflow`. For portalled content, pass the portal container instead (for example `screen.getByRole("dialog")`). `ui/*` primitives get no `LongText` story, with three exceptions: Input, InfoTip and Combobox, which render the value themselves. Every other primitive leaves truncation to its consumer.
- **Fixtures:** build domain props with the repo's own builders, not hand-typed aggregates. These are `makeValidUiState()` (`@/lib/scenario/test-fixtures`), the folder's `*-model.ts` (`emptyAffinityForm()`, `affinityToForm(card)`, and the scenario→cards function its `use-*.ts` hook calls), `priyaContext()` (`@/lib/roster-viewer/swap-fixtures`) and `SHIFT_FAMILY_RAMP` (`@/lib/roster-viewer/shift-ramp`). When a colocated `*.test.tsx` exists, read it first: it already mounts the component with valid props. Keep fixtures inside the story file. Do not add shared fixture modules, because disjoint groups must not share files.
- **Story names:** PascalCase state names. Use the ones in the group tables exactly, since the integrator counts them.
- **Imports:** use `@/…` for app code. For the helpers, use the relative path `../../.storybook/story-helpers` (from `components/<area>/`) or `../.storybook/story-helpers` (from `components/`), matching the Phase 1 `backup-status-badge.stories.tsx` import of `harness`.

## Coverage rule (what "full variant coverage" means)

Each story file has:

1. one story per **visual variant** the component exposes (cva `variant`/`size`/`tone`/`casing` option, union-typed mode prop such as `mode: "add" | "edit"` or `"normal" | "quick"`, or `status` discriminant);
2. one story per **named state** in the group table. These are the states that DESIGN.md §5 and the listed prototype screen name: Empty, Error/Invalid, Disabled, Selected, Loading/Submitting, Open/Closed;
3. a `play` for every **handler**, a `Disabled` play asserting the handler is *not* called, and an `Empty` play asserting the empty-state copy;
4. `LongText` where the table marks a user-text slot;
5. `Dark`, last.

For each group, the prototype file is the visual reference for state names only. Precedence is product contract → DESIGN.md → prototype. The prototype never adds a state the component does not implement.

---

## File structure

Phase 2 creates only the files below. Groups have disjoint directories: no two groups write to the same folder.

| Owner | Creates |
|---|---|
| Task 1 (serial) | `web/.storybook/story-helpers.tsx`, `web/.storybook/story-helpers.stories.tsx` |
| Task 2 · A1 · 16 | `web/components/app-version.stories.tsx`, `web/components/ui/{label,separator,input,badge,switch,info-tip,card,skeleton,input-group,toggle-group,combobox,alert-dialog,dialog,inset-hairline-box,surface}.stories.tsx` |
| Task 3 · A2 · 9 | `web/components/card-editor/{field-shell,weight-field,expression-field,coefficient-fields,date-scope-field}.stories.tsx`, `web/components/affinities/{affinity-card-list,affinity-form}.stories.tsx`, `web/components/coverings/{covering-card-list,covering-form}.stories.tsx` |
| Task 4 · A3 · 8 | `web/components/successions/{pattern-builder,succession-card-list,succession-form}.stories.tsx`, `web/components/counts/count-form.stories.tsx`, `web/components/requirements/{date-overrides-field,shift-type-single-select}.stories.tsx`, `web/components/entity-editor/working-time-fields.stories.tsx`, `web/components/dates/roster-period-card.stories.tsx` |
| Task 5 · A4 · 9 | `web/components/requests/{clear-data-panel,clear-confirm-dialog,current-history-table,history-editor,quick-paint-panel,requests-toolbar,current-requests-table,cell-preference-editor}.stories.tsx`, `web/components/home/home-stat-strip.stories.tsx` |
| Task 6 · A5 · 12 | `web/components/optimize/{callout,capture-notice,run-event-log,run-options-form,server-identity}.stories.tsx`, `web/components/save-load/{version-confirm-modal,scenario-issues-list,import-warnings-banner}.stories.tsx`, `web/components/shell/{confirm-dialog,screen-error}.stories.tsx`, `web/components/roster-viewer/{shift-chip,roster-edit-bar}.stories.tsx` |

16 + 9 + 8 + 9 + 12 = **54**. The groups are balanced by source size (roughly 50–75 KB of component source each) as well as by count. A1 has many small primitives. A5 has many small panels.

---

### Task 1: Integration branch, baseline and shared long-text helpers (serial, blocks Tasks 2–6)

**Files:**
- Create: `web/.storybook/story-helpers.tsx`
- Create: `web/.storybook/story-helpers.stories.tsx`

**Interfaces:**
- Consumes: Phase 1 `.storybook/` (preview, harness).
- Produces (read-only for Tasks 2–6):
  - `export const LONG_TOKEN: string`: exactly 120 characters with no spaces, so it cannot word-wrap.
  - `export const LONG_PROSE: string`: a long spaced sentence.
  - `export const withNarrowFrame: Decorator`: wraps the story in `<div data-testid="narrow-frame" className="w-80">`.
  - `export async function expectNoHorizontalOverflow(el: HTMLElement): Promise<void>`.

- [ ] **Step 1: Create the integration worktree**

```bash
cd /home/kenan/work/nursing-sheduler
git fetch origin
# Build on develop if Phase 1 is already on it, else on the Phase 1 branch.
if git merge-base --is-ancestor feat/w0e2-storybook-phase1 origin/develop; then BASE=origin/develop; else BASE=feat/w0e2-storybook-phase1; fi
echo "base: $BASE"
wt switch --create feat/w0e3-storybook-bucket-a --base "$BASE" --no-cd
cd /home/kenan/work/nursing-sheduler.feat-w0e3-storybook-bucket-a/web
git rev-parse HEAD > /tmp/w0e3-base.sha   # Task 7's scope check diffs against this
pnpm install --frozen-lockfile
```

- [ ] **Step 2: Record baselines**

Run:

```bash
pnpm test:stories 2>&1 | tail -4 | tee /tmp/w0e3-stories-baseline.txt
PLAYWRIGHT_BROWSERS_PATH=/nonexistent pnpm test 2>&1 | tail -6 | tee /tmp/w0e3-unit-baseline.txt
```

Expected: stories `27 passed`. Unit about 8110 passed, with only the known `dev-launcher.test.ts` environment failure. Keep the exact numbers; Task 7 compares against them.

- [ ] **Step 3: Write the failing self-check** `web/.storybook/story-helpers.stories.tsx`

```tsx
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";
import {
  LONG_PROSE,
  LONG_TOKEN,
  expectNoHorizontalOverflow,
  withNarrowFrame,
} from "./story-helpers";

// Helper self-checks (bead w0e.3). Hidden from the sidebar, run by `pnpm test:stories`.
const meta = {
  title: "Harness/StoryHelpers",
  tags: ["!dev"],
  decorators: [withNarrowFrame],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fixtures: Story = {
  render: () => <p>{LONG_PROSE}</p>,
  play: async () => {
    await expect(LONG_TOKEN).toHaveLength(120);
    await expect(LONG_TOKEN).not.toMatch(/\s/);
    await expect(LONG_PROSE.length).toBeGreaterThan(120);
  },
};

export const TruncatedIsContained: Story = {
  render: () => (
    <p className="truncate" title={LONG_TOKEN}>
      {LONG_TOKEN}
    </p>
  ),
  play: async ({ canvas }) => {
    await expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"));
    const text = canvas.getByTitle(LONG_TOKEN);
    // Proves the ellipsis is really in play, not that the token happened to fit.
    await expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
  },
};

export const OverflowIsCaught: Story = {
  render: () => <p className="whitespace-nowrap">{LONG_TOKEN}</p>,
  play: async ({ canvas }) => {
    await expect(expectNoHorizontalOverflow(canvas.getByTestId("narrow-frame"))).rejects.toThrow();
  },
};
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm test:stories .storybook/story-helpers.stories.tsx`
Expected: FAIL. The import of `./story-helpers` does not resolve.

- [ ] **Step 5: Implement** `web/.storybook/story-helpers.tsx`

```tsx
import type { Decorator } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

// Long-text story helpers (bead w0e.3; bd memory `long-user-text-no-overflow`). Read-only for
// story authors: one definition, so every LongText story tests the same inputs.

/** 120 characters, no whitespace: word wrapping cannot contain it, only truncation or overflow-wrap can. */
export const LONG_TOKEN = "ward8-east-extended-weekend-night-cover-rotation-".repeat(3).slice(0, 120);

/** A long, spaced, user-entered description. */
export const LONG_PROSE =
  "Senior nurses on the east wing must not work more than three consecutive long days during the winter pressures period, except by prior agreement with the ward manager";

/**
 * A fixed 320px frame. Under the default `centered` layout a component otherwise sizes to its
 * own content, so an overflow would never be measurable.
 */
export const withNarrowFrame: Decorator = (Story) => (
  <div data-testid="narrow-frame" className="w-80">
    <Story />
  </div>
);

/** Fails when any descendant paints past `el`'s right edge (scrollWidth counts visible overflow). */
export async function expectNoHorizontalOverflow(el: HTMLElement): Promise<void> {
  await expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}
```

- [ ] **Step 6: Run to verify it passes, then mutation-check**

Run: `pnpm test:stories .storybook/story-helpers.stories.tsx`
Expected: PASS, 3 tests.

Mutation: temporarily change `toBeLessThanOrEqual` to `toBeGreaterThanOrEqual` in `expectNoHorizontalOverflow`.
Expected: `TruncatedIsContained` FAILS. (`OverflowIsCaught` also fails, because the helper no longer throws.) Restore the line and re-run: PASS.

- [ ] **Step 7: Gates and commit**

Run: `pnpm typecheck && pnpm lint && pnpm exec oxfmt --check .storybook && pnpm test:stories 2>&1 | tail -4`
Expected: all green, with stories at `30 passed` (27 + 3).

```bash
git add .storybook/story-helpers.tsx .storybook/story-helpers.stories.tsx
git commit -m "test(web): storybook long-text helpers for bucket A stories (w0e.3)"
```

- [ ] **Step 8: Create the five agent worktrees**

```bash
cd /home/kenan/work/nursing-sheduler
for g in a1-ui a2-card-editor a3-successions-fields a4-requests a5-optimize-shell; do
  wt switch --create "feat/w0e3-$g" --base feat/w0e3-storybook-bucket-a --no-cd
done
```

Each agent works only in its own `/home/kenan/work/nursing-sheduler.feat-w0e3-<group>/web` and runs `pnpm install --frozen-lockfile` first. The pnpm store is shared, so this is fast.

---

### Per-group procedure (Tasks 2–6 all follow it)

For each component in the group table, in table order:

- [ ] **a. Write the story file** with the stories and plays the table lists, following "Story conventions".
- [ ] **b. Run only that file:** `pnpm test:stories components/<area>/<file>.stories.tsx`. Expected: every story passes. Handle a failure in this order. (1) Your play is wrong about the component: read the component and fix the **story**. (2) axe fails on the real component: apply the a11y-failure rule. (3) The long-text assertion fails on the real component: apply the long-text-failure rule. Never edit the component.
- [ ] **c. Commit the file** once it is green: `git add <file> && git commit -m "test(web): <Area>/<Component> stories (w0e.3)"`.

After the whole table:

- [ ] **d. Group gates**

```bash
FILES=$(git diff --name-only feat/w0e3-storybook-bucket-a...HEAD)
echo "$FILES" | grep -v '\.stories\.tsx$' && echo "SCOPE VIOLATION" || echo "scope ok"
pnpm test:stories $(echo "$FILES" | sed 's#^web/##')
pnpm typecheck && pnpm lint && pnpm exec oxfmt --check $(echo "$FILES" | sed 's#^web/##')
grep -hc '^export const [A-Z]' $(echo "$FILES" | sed 's#^web/##') | awk '{s+=$1} END {print s}'   # story count
```

Expected: `scope ok`. The story tests pass, and their count equals the story count printed by the last line. Typecheck, lint and format exit 0. If the story run fails with a port-in-use error because another group is running Chromium at the same moment, re-run it; do not change config.

- [ ] **e. Mutation proof (one per group).** Pick the story the table marks with ★. Temporarily change the expected handler argument in its play (for example `toHaveBeenCalledWith("x")` → `("y")`) and run the file: it must FAIL. Restore it, re-run: PASS. This proves the plays really execute and assert.
- [ ] **f. Hand-off note** in the final message: branch, commit list, story count, and every `a11y: todo` or `KNOWN OVERFLOW` with its bead id.

---

### Task 2: Group A1 — UI primitives + AppVersion (16 files, parallel)

**Worktree:** `/home/kenan/work/nursing-sheduler.feat-w0e3-a1-ui` · **Prototype:** `docs/design_prototype/source/Nurse Scheduling v2.dc.html` (shell primitives) · **DESIGN:** §4 (surface ladder), §5 Buttons/Cards/Inputs/Badges.

**Interfaces:** Consumes the Task 1 helpers (`LONG_TOKEN`, `LONG_PROSE`, `withNarrowFrame`, `expectNoHorizontalOverflow`). Produces story files only.

| # | File → Title | Stories (then `Dark`) | Play assertions |
|---|---|---|---|
| 1 | `ui/label` → `UI/Label` | `Default` (Label `htmlFor` + `Input id`) | `getByLabelText("Ward name")` is the input |
| 2 | `ui/separator` → `UI/Separator` | `Horizontal`, `Vertical` | the `separator` role, with `aria-orientation` matching |
| 3 | `ui/input` → `UI/Input` | `Default`★, `Placeholder`, `Disabled`, `Invalid` (`aria-invalid`), `LongText` | type → `toHaveValue` · ★ `onChange` called · Disabled `toBeDisabled` and typing leaves the value empty · LongText (`defaultValue: LONG_TOKEN`, narrow frame) → no overflow |
| 4 | `ui/badge` → `UI/Badge` | `Neutral`, `Brand`, `Success`, `Warn`, `Error`, `Outline`, `NormalCase` | each asserts `data-variant` · text is `TO DO`/`CURRENT`/`DONE` (DESIGN §5: text carries state) |
| 5 | `ui/switch` → `UI/Switch` | `Off`, `On` (`defaultChecked`), `Disabled` | Off: click → `onCheckedChange` first arg `true`, `aria-checked="true"` · Disabled: click → not called |
| 6 | `ui/info-tip` → `UI/InfoTip` | `Default`, `LongText` | focus the button named `` `${label}: ${text}` `` → `role="tooltip"` visible with the text · blur → gone. LongText (`text: LONG_PROSE`) → no overflow of the tooltip element |
| 7 | `ui/card` → `UI/Card` | `Default` (Header/Title/Description/Content/Footer), `Selected` (`SelectedCard`) | text visible |
| 8 | `ui/skeleton` → `UI/Skeleton` | `Bare`, `Line`, `Text`, `Card` | `[data-slot="skeleton"]` present |
| 9 | `ui/input-group` → `UI/InputGroup` | `WithAddon`, `WithButton`, one story per `align` option of the addon cva | WithButton: click → `onClick` called |
| 10 | `ui/toggle-group` → `UI/ToggleGroup` | `Segmented`★, `Outline`, `Small`, `Large`, `Swatch`, `Disabled` | ★ click `Week` → `onValueChange` called with `["week"]`, `aria-pressed="true"` · Disabled → not called |
| 11 | `ui/combobox` → `UI/Combobox` | `Default`, `NoMatch`, `LongText` | Default: type `ni` → `screen` option `Night` → click → `onValueChange` called with that item · NoMatch: type `zzz` → the `ComboboxEmpty` copy · LongText: option label `LONG_TOKEN` → popup (`screen.getByRole("listbox")`) has no overflow |
| 12 | `ui/alert-dialog` → `UI/AlertDialog` | `Open` (`defaultOpen`), `FromTrigger`, `WithMedia` (`tone` brand and error) | `screen.getByRole("alertdialog", { name })` · Cancel → `onOpenChange` called with `false` · FromTrigger: click trigger → dialog appears |
| 13 | `ui/dialog` → `UI/Dialog` | `Open`, `FromTrigger`, `CloseButton` | `screen.getByRole("dialog", { name })` · `DialogClose` → `onOpenChange` `false` |
| 14 | `ui/inset-hairline-box` → `UI/InsetHairlineBox` | `Tile`, `Readout` | children visible |
| 15 | `ui/surface` → `UI/Surface` | one story per legal `SurfaceVisualProps` pair: `PageSquare`, `SurfaceCard`, `SurfaceSquare`, `RaisedCard`, `WellControl`, `WellChip`, `WellSquare`, plus one `Well<Emphasis>` per `SurfaceEmphasis` member · `Ladder` (page ⊃ surface ⊃ well, DESIGN §4) | each asserts `data-level` / `data-geometry` (and `data-emphasis`) |
| 16 | `app-version` → `App/AppVersion` | `Default` | `getByTestId("app-version")` text matches `/^v/` |

Add one step before 12: **Step 4 of this task, portal a11y proof.** In `ui/dialog.stories.tsx`, temporarily delete the `DialogTitle` from `Open` and run the file.
Expected: FAIL on an axe dialog-name rule (`aria-dialog-name` or similar), which proves axe scans portalled content. Restore it. If the story still **passes** with the title removed, axe is not scanning portals. **Stop and report:** every portal story would then need `parameters.a11y.context` pointed at `body`, and that is a `.storybook` decision for Task 7, not for A1.

---

### Task 3: Group A2 — CardEditor fields + Affinities + Coverings (9 files, parallel)

**Worktree:** `…/nursing-sheduler.feat-w0e3-a2-card-editor` · **Prototype:** `source/ScreenCards.dc.html` · **Fixtures:** `makeValidUiState()`; `affinities/affinities-model.ts` (`emptyAffinityForm`, `affinityToForm`); `coverings/coverings-model.ts` (`emptyCoveringForm`, `coveringToForm`); the scenario→cards function each folder's `use-*.ts` calls. Read `card-editor-shell.test.tsx`, `date-scope-field.test.tsx` and `coverings-editor.test.tsx` for valid mounts.

**Interfaces:** Consumes the Task 1 helpers. Produces story files only.

| # | File → Title | Stories (then `Dark`) | Play assertions / LongText slot |
|---|---|---|---|
| 1 | `card-editor/field-shell` → `CardEditor/FieldShell` | `Default`, `Required`, `WithHint`, `WithError` | label, required marker, hint and error text visible · the error is announced (role/aria per the component) |
| 2 | `card-editor/weight-field` → `CardEditor/WeightField` (+ `WeightPill` in the same file) | `Default`★, `WithHelp`, `WithError`, `WithNote`, `Pill`, `PillInfinite` | ★ type a weight → `onChange` called with the new `WeightFieldValue` · the error text is visible |
| 3 | `card-editor/expression-field` → `CardEditor/ExpressionField` | `Default`, `WithError` | edit → `onChange` called with the next value |
| 4 | `card-editor/coefficient-fields` → `CardEditor/CoefficientFields` | `Default`, `WithCoverage` (`showCoverage`), `DerivedHints`, `WithErrors` (`errorsById` + `aggregateError`), `Empty` (`selection: []`), `LongText` | edit one coefficient → `onChange(next, changedId)` · LongText: a selection id `LONG_TOKEN` → no overflow + `getByTitle` |
| 5 | `card-editor/date-scope-field` → `CardEditor/DateScopeField` | `AllDates`, `AutoScope`, `DateGroup`, `Custom`, `LongText` | choose a scope → `onChange` called with its refs · LongText: a date-group name `LONG_TOKEN` → no overflow + title |
| 6 | `affinities/affinity-card-list` → `Affinities/AffinityCardList` | `Populated` (≥ 3 cards, one disabled), `Empty`, `LongText` | Edit/Duplicate/Delete → `onEdit`/`onDuplicate`/`onDelete` with that `uid` · the disable toggle → `onSetDisabled(uid, true)` · a move action → `onReorder(from, to, position)` · LongText: description `LONG_PROSE` wraps, and a person name `LONG_TOKEN` truncates with its title |
| 7 | `affinities/affinity-form` → `Affinities/AffinityForm` | `Add`★ (`mode: "add"`, `emptyAffinityForm()`), `Edit` (`affinityToForm(card)`), `Invalid`, `LongText` | ★ fill required fields → submit → `onSave` called with a form containing the typed description · Cancel → `onCancel` · Invalid: submit empty → the error is visible and `onSave` is **not** called · LongText: a staff name `LONG_TOKEN` in the transfer list → no overflow |
| 8 | `coverings/covering-card-list` → `Coverings/CoveringCardList` | `Populated`, `Empty`, `LongText` | same handler set as row 6 |
| 9 | `coverings/covering-form` → `Coverings/CoveringForm` | `Add`, `Edit`, `Invalid`, `HardRuleNote`, `LongText` | as row 7, plus the hard-rule note text is visible |

---

### Task 4: Group A3 — Successions + count form + requirement fields + working time + roster period (8 files, parallel)

**Worktree:** `…/nursing-sheduler.feat-w0e3-a3-successions-fields` · **Prototype:** `source/ScreenCards.dc.html`, `ScreenShifts.dc.html` (working time), `ScreenDates.dc.html` (roster period) · **Fixtures:** `makeValidUiState()`; `successions/successions-model.ts` (`emptySuccessionForm`, `successionToForm`); `counts/counts-model.ts` (`emptyCountForm`, `countToForm(card, domain)`). Read `working-time-fields.test.tsx`, `roster-period-card.test.tsx` and `date-overrides-field.test.tsx`.

**Interfaces:** Consumes the Task 1 helpers. Produces story files only.

| # | File → Title | Stories (then `Dark`) | Play assertions / LongText slot |
|---|---|---|---|
| 1 | `successions/pattern-builder` → `Successions/PatternBuilder` | `Empty`, `Populated`, `WithGroups`, `WithError`, `LongText` | Empty: `pattern-builder-empty` copy · add an item → `onChange` called with the appended ref · the move-earlier/later and remove buttons → `onChange` with the reordered or shortened list · LongText: shift id `LONG_TOKEN` → no overflow + title |
| 2 | `successions/succession-card-list` → `Successions/SuccessionCardList` | `Populated`, `Empty`, `LongText` | Edit/Duplicate/Delete/disable/move → the matching handler with `uid` (as A2 row 6) |
| 3 | `successions/succession-form` → `Successions/SuccessionForm` | `Add`★, `Edit`, `Invalid`, `LongText` | ★ submit → `onSave` with the form · Cancel → `onCancel` · Invalid: `onSave` not called |
| 4 | `counts/count-form` → `Counts/CountForm` | `Add`, `Edit`, `Invalid`, `LongText` | as row 3 |
| 5 | `requirements/date-overrides-field` → `Requirements/DateOverridesField` | `Empty`, `WithRows`, `LongText` | `date-overrides-add` → `onChange` with one more row · removing a row → `onChange` without it |
| 6 | `requirements/shift-type-single-select` → `Requirements/ShiftTypeSingleSelect` | `Default`, `Selected`, `WithGroups`, `LongText` | click an option → `onSelect(value)` · LongText: option label `LONG_TOKEN` → no overflow + title |
| 7 | `entity-editor/working-time-fields` → `EntityEditor/WorkingTimeFields` | `Default`, one story per `WorkingTimeValue` mode the component switches between, `Invalid` | edit start/end → `onChange` with the new value |
| 8 | `dates/roster-period-card` → `Dates/RosterPeriodCard` | `Default`, `InvalidRange`, `HolidaysImported` (`importedHolidaysPresent: true`), `ImportToggleOn` | commit a valid range → `onCommit(range, importHolidays)` · InvalidRange: `range-invalid` visible and `onCommit` not called |

---

### Task 5: Group A4 — Requests + Home stat strip (9 files, parallel)

**Worktree:** `…/nursing-sheduler.feat-w0e3-a4-requests` · **Prototype:** `source/ScreenRequests.dc.html`, `ScreenHome.dc.html` · **Fixtures:** read `clear-data-panel.test.tsx`, `clear-confirm-dialog.test.tsx`, `current-history-table.test.tsx`, `current-requests-table.test.tsx`, `history-editor.test.tsx`, `quick-paint-panel.test.tsx`, `requests-toolbar.test.tsx` and `cell-preference-editor.test.tsx`; each already builds valid props.

**Interfaces:** Consumes the Task 1 helpers. Produces story files only.

| # | File → Title | Stories (then `Dark`) | Play assertions / LongText slot |
|---|---|---|---|
| 1 | `requests/clear-data-panel` → `Requests/ClearDataPanel` | `Default` (3 buttons) | each button → its own `onClick` spy |
| 2 | `requests/clear-confirm-dialog` → `Requests/ClearConfirmDialog` | `Open`, `Closed`, `LongText` | `clear-confirm-confirm` → `onConfirm` · `clear-confirm-cancel` → `onCancel` · Closed: `screen.queryByTestId("clear-confirm-dialog")` is null · LongText: `text: LONG_PROSE` → no overflow of the dialog |
| 3 | `requests/current-history-table` → `Requests/CurrentHistoryTable` | `Populated`, `Empty`, `LongText` | Empty: `history-empty` copy · `history-count` matches the rows · LongText: person name and history code `LONG_TOKEN` → no overflow + title |
| 4 | `requests/history-editor` → `Requests/HistoryEditor` | `Open`, `WithCurrentValue`, `LongText` | choose an option → `onSet(value)` · clear → `onClear` · close → `onClose` · LongText: `who` and option code `LONG_TOKEN` → no overflow |
| 5 | `requests/quick-paint-panel` → `Requests/QuickPaintPanel` | `NoneSelected`, `Selected`, `LongText` | chip → `onToggle(id)` · weight input → `onWeightChange` · `quick-paint-pos-inf`/`-neg-inf` → `onSetPosInf`/`onSetNegInf` · LongText: target label `LONG_TOKEN` → no overflow + title |
| 6 | `requests/requests-toolbar` → `Requests/RequestsToolbar` | `Normal`★, `Quick`, `ClearOpen`, `CsvDisabled` (with reason) | ★ `requests-tab-quick` → `onSetMode("quick")` · open/download buttons → their spies · CsvDisabled: the button is disabled, its reason is exposed, and clicking does not call the spy |
| 7 | `requests/current-requests-table` → `Requests/CurrentRequestsTable` | `Populated`, `Empty`, `NoMatch` (search filters to zero), `LongText` | type in `requests-search` → rows filter · NoMatch: `requests-no-match` copy · LongText: person/shift `LONG_TOKEN` → no overflow + title |
| 8 | `requests/cell-preference-editor` → `Requests/CellPreferenceEditor` | `Available`, `Off`, `Leave`, `WithError`, `LongText` | each tab (`cell-editor-tab-*`) switches the panel · save → `onSave` with the result · clear → `onClear` · cancel → `onClose` · LongText: `personLabel` `LONG_TOKEN` → no overflow |
| 9 | `home/home-stat-strip` → `Home/HomeStatStrip` | `Default` (the 4 stats Home passes), `Zero` (all `"0"`) | each label/value pair is visible |

---

### Task 6: Group A5 — Optimize panels + save-load notices + shell dialogs + roster chips (12 files, parallel)

**Worktree:** `…/nursing-sheduler.feat-w0e3-a5-optimize-shell` · **Prototype:** `source/ScreenGenerate.dc.html`, `ScreenExport.dc.html`, `ScreenSaveLoad.dc.html`, `ScreenSchedule.dc.html` · **DESIGN:** §5 Roster grid (chips), §2 shift colour palette · **Fixtures:** read `capture-notice.test.tsx`, `run-event-log.test.tsx`, `run-options-form.test.tsx`, `server-identity.test.tsx`, `scenario-issues-list.test.tsx`, `import-warnings-banner.test.tsx` and `confirm-dialog.test.tsx`. Use `priyaContext()` and `SHIFT_FAMILY_RAMP` for the roster components (`roster-viewer.test.tsx` mounts the edit bar).

**Interfaces:** Consumes the Task 1 helpers. Produces story files only.

**Worked example (write this file first; it is the group's template for portals, variants, handlers and long text):** `web/components/shell/confirm-dialog.stories.tsx`

```tsx
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, screen } from "storybook/test";
import { LONG_PROSE, LONG_TOKEN, expectNoHorizontalOverflow } from "../../.storybook/story-helpers";
import { ConfirmDialog } from "./confirm-dialog";

// Portalled (Base UI AlertDialog): query with `screen`, never `canvas`.
const meta = {
  title: "Shell/ConfirmDialog",
  component: ConfirmDialog,
  args: {
    open: true,
    title: "Discard unsaved changes?",
    description: "Your edits to this card will be lost.",
    onOpenChange: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, userEvent }) => {
    const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await expect(dialog).toBeVisible();
    await userEvent.click(screen.getByTestId("confirm-dialog-confirm"));
    await expect(args.onConfirm).toHaveBeenCalledOnce();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};

export const Cancel: Story = {
  play: async ({ args, userEvent }) => {
    await userEvent.click(await screen.findByTestId("confirm-dialog-cancel"));
    await expect(args.onConfirm).not.toHaveBeenCalled();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  },
};

export const Destructive: Story = {
  args: { variant: "destructive", confirmLabel: "Delete card" },
  play: async () => {
    await expect(await screen.findByRole("button", { name: "Delete card" })).toBeVisible();
  },
};

export const WithDetailAndConsequences: Story = {
  args: {
    detail: "late+ → N12\nearly1 → off",
    consequences: ["2 requests will be removed", "1 count card will be disabled"],
  },
  play: async () => {
    await expect(await screen.findByTestId("confirm-dialog-detail")).toBeVisible();
    await expect(screen.getByTestId("confirm-dialog-consequences").children).toHaveLength(2);
  },
};

export const LongText: Story = {
  args: { title: LONG_PROSE, description: LONG_PROSE, detail: LONG_TOKEN },
  play: async () => {
    await expectNoHorizontalOverflow(await screen.findByTestId("confirm-dialog"));
  },
};

export const Dark: Story = {
  args: { ...WithDetailAndConsequences.args },
  globals: { theme: "dark" },
};
```

In `Cancel`, `onOpenChange` is asserted with `(false, expect.anything())` because Base UI's Close passes an event-details second argument. If the run shows exactly `(false)`, use that; the play must match the component's real call. `LongText.detail` is an unbroken mono token inside `whitespace-pre-line`, and it may overflow. If it does, that is the long-text-failure rule (bead + `KNOWN OVERFLOW`), not a story bug.

| # | File → Title | Stories (then `Dark`) | Play assertions / LongText slot |
|---|---|---|---|
| 1 | `shell/confirm-dialog` → `Shell/ConfirmDialog` | as the worked example (`Default`★ …) | as above |
| 2 | `save-load/version-confirm-modal` → `SaveLoad/VersionConfirmModal` | `Default`, `WithDetail`, `LongText` | continue → `onContinue` · cancel → `onOpenChange(false…)` |
| 3 | `shell/screen-error` → `Shell/ScreenError` | `Default` (the `SCREEN_ERROR_TITLE`/`MESSAGE` defaults), `CustomCopy` | `app-error-retry` → `onRetry` once |
| 4 | `optimize/callout` → `Optimize/Callout` | `Info`, `Warn`, `Error`, `Success` (tones) × placement `Inset`/`Page` → name the stories `InfoInset`, `InfoPage`, … (8) · `WithActions` · `Alert` (`alert: true`) | Alert: `role="alert"` · the others show title and body |
| 5 | `optimize/capture-notice` → `Optimize/CaptureNotice` | one story per `RosterCaptureState.status` the component renders (`Committed`, `FetchFailed`, `CommitFailed`, `DismissFailed`, …, taken from `capture-notice.test.tsx`), `DismissPending` | `optimize-capture-retry` → `onRetry` · `optimize-capture-dismiss` → `onDismiss` · DismissPending: dismiss is disabled and clicking does not call the spy |
| 6 | `optimize/run-event-log` → `Optimize/RunEventLog` | `Empty`, `Populated`, `Active`, `LongText` | `optimize-event-count` matches the entries · LongText: an event detail of `LONG_TOKEN` + `LONG_PROSE` → no overflow of `optimize-event-log` |
| 7 | `optimize/run-options-form` → `Optimize/RunOptionsForm` | `Ready`★, `Submitting`, `OptionsDisabled`, `SubmitDisabled` (with `disabledReason`), `TimeoutError` | ★ `optimize-submit` → `onSubmit` · toggles → `onPrettifyChange(true)`/`onAnonymizeChange(true)` · timeout input → `onTimeoutChange` · SubmitDisabled: `optimize-disabled-reason` text and `onSubmit` not called |
| 8 | `optimize/server-identity` → `Optimize/ServerIdentity` | one per `OptimizeServerStatus` + `CompatibilityTier` the component distinguishes (`Online`, `Offline` → `optimize-server-offline`, `VersionMismatch` → `optimize-version-mismatch`, `VersionNote` → `optimize-version-note`) | each test id is visible · recheck (`optimize-recheck`) fires the callback the `info` carries, if it has one |
| 9 | `save-load/scenario-issues-list` → `SaveLoad/ScenarioIssuesList` | `OneIssue`, `ManyIssues`, `CustomAction` (`action` prop), `LongText` | the heading counts the issues · LongText: an issue message with `LONG_TOKEN` → no overflow |
| 10 | `save-load/import-warnings-banner` → `SaveLoad/ImportWarningsBanner` | `OneWarning`, `ManyWarnings`, `LongText` | `import-warnings-dismiss` → `onDismiss` |
| 11 | `roster-viewer/shift-chip` → `RosterViewer/ShiftChip` | `Morning`, `Evening`, `LongDay`, `Night`, `Other` (from `SHIFT_FAMILY_RAMP`), `Leave`, `Off`, `LongId` | the chip's accessible label is the bare shift id · `LongId` (id `LONG_TOKEN`): per DESIGN §5 the chip **grows to its content**, so assert that the chip itself does not clip (`scrollWidth <= clientWidth`), not that it truncates (see unresolved question 2) |
| 12 | `roster-viewer/roster-edit-bar` → `RosterViewer/RosterEditBar` | `ShiftSelected`, `LeaveSelected`, `NoMatch`, `LongText` | pick a shift through `roster-shift-picker` (portal: `screen`) → `onSetCell(selected, { kind: "shift", shiftId })` · `roster-edit-bar-cancel` → `onCancel` · NoMatch: typing `zzz` → "No shift matches that search." · LongText: a person name `LONG_TOKEN` in the context → no overflow |

---

### Task 7: Integrate, full gates, hand-off (serial, after Tasks 2–6)

**Files:** none new.

- [ ] **Step 1: Merge the five group branches into the integration branch**

```bash
cd /home/kenan/work/nursing-sheduler.feat-w0e3-storybook-bucket-a
for g in a1-ui a2-card-editor a3-successions-fields a4-requests a5-optimize-shell; do
  git merge --no-ff "feat/w0e3-$g" -m "merge feat/w0e3-$g (w0e.3)" || { echo "CONFLICT in $g — groups were meant to be disjoint; stop and report"; break; }
done
```

Expected: five clean merges. A conflict means a group wrote outside its directories; report it and do not resolve it silently.

- [ ] **Step 2: Scope check**

```bash
git diff --name-only "$(cat /tmp/w0e3-base.sha)" HEAD | grep -vE '\.stories\.tsx$|^web/\.storybook/story-helpers\.tsx$'
```

Expected: no output. The only changed files are the 54 story files and the two Task 1 files, so no production file changed.

- [ ] **Step 3: Full gates**

```bash
cd web
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm exec oxfmt --check .
pnpm test:stories 2>&1 | tail -4          # 30 + the sum of the five group story counts, all passed
PLAYWRIGHT_BROWSERS_PATH=/nonexistent pnpm test 2>&1 | tail -6   # == /tmp/w0e3-unit-baseline.txt
pnpm test:ast-grep
pnpm build-storybook 2>&1 | tail -3
```

Expected: all green. Unit counts equal the baseline (stories are not in the unit config). e2e is **not** re-run: Step 2 proves that no production, e2e or config file changed, so the epic's "e2e unchanged" holds by construction.

- [ ] **Step 4: Sidebar spot-check**

Run `pnpm storybook --no-open` in the background (use `-p 6016` if 6006 is taken by the foreign spike Storybook the Phase 1 report mentions). Then:

```bash
curl -s http://localhost:6016/index.json | grep -o '"title":"[^"]*"' | sort -u | wc -l
```

Expected: the Phase 1 titles plus 54 new titles, and no `Harness/StoryHelpers` in the sidebar (it is `!dev`). Stop the server.

- [ ] **Step 5: Bead notes (no close, no push)**

```bash
bd update nursing-sheduler-w0e.3 --notes "Phase 2 done on feat/w0e3-storybook-bucket-a (not pushed). \
Bucket A re-derived from code = 54 components (bead said 43, July count). \
test:stories <N> green at a11y error; a11y todo: <list or none>; KNOWN OVERFLOW: <list or none>. \
Groups: A1 ui 16, A2 card-editor 9, A3 successions/fields 8, A4 requests 9, A5 optimize/shell 12."
```

Report to the user: the branch, merge commits, story count, every `a11y: todo` / `KNOWN OVERFLOW` bead, and the Bucket A exclusion table (it seeds Phases 3–5). Propose the next commands (push the branch, open a PR into `develop` after Phase 1's PR lands) and wait for approval.

---

## Self-review against the spec

- *Props-only components*: covered by the derivation rules, and each group table lists props-driven stories only.
- *Full variant coverage*: covered by the coverage rule plus an explicit story list per cva option, union mode or status.
- *fn() interaction tests where a handler exists*: every handler prop in the dumped prop contracts has a play in its table row.
- *Colocated \*.stories.tsx*: covered by the file-structure table.
- *Disjoint directories per agent*: covered by the file-structure table; Task 7 Step 1 treats a conflict as a defect.
- Epic *a11y at test:error*: covered by global constraints plus the Task 2 portal mutation proof.
- Epic *unit/e2e unchanged*: covered by Task 7 Steps 2–3.
- Epic *typecheck/lint/format over story files*: covered by per-group gate d and Task 7 Step 3.
- bd memory *long-user-text-no-overflow*: covered by the Task 1 helpers plus a `LongText` story in every table row that has a user-text slot.

## Unresolved questions (recommended default in bold)

1. **Scope: 54 or 43?** The bead's 43 counts the July tree. Today's code yields 54 under the bucket rules. **Default: all 54**, because the epic wants every component storied, and no later phase owns the other 11 props-only components. Alternative: cap at 43 by deferring A3 rows 5–8 and A5 rows 8–12 to a new Phase 2b bead.
2. **Roster shift chip with a long id.** DESIGN §5 says a long id *grows to its own content rather than clipping*. The bd memory says to truncate with an ellipsis. **Default: DESIGN wins for the roster chip** (the grid is the scroller and the chip has an `aria-label`). The memory rule applies everywhere else. This needs the user's confirmation, because a later chip change flips `LongId`.
3. **A real overflow found by a `LongText` story.** **Default: bead + `KNOWN OVERFLOW` comment; no component change in this phase.** Alternative: fix trivially fixable ones (a missing `truncate` + `title`) inline. That breaks "stories only" and mixes product changes into a test PR.
4. **A `Dark` story per file** (+54 tests). **Default: yes.** It is the only thing that runs axe `color-contrast` against the dark ramp.
5. **Base branch while Phase 1 is unmerged.** **Default: branch from `feat/w0e2-storybook-phase1`** (Task 1 Step 1 picks develop automatically once Phase 1 is on develop), and rebase onto `develop` before any PR.
6. **Portal a11y.** If Task 2 Step 4 shows that axe does not scan portals, **default: stop the fan-out, and add `parameters.a11y.context: "body"` to the portal stories' meta in Task 7** (story files only). Do not change `preview.tsx` globally without asking.

## Assumptions

- The bucket rules above match what the July author meant by "props-only" / "light context" / "store-coupled" / "heavy integration". The only written evidence is the four bead descriptions quoted in the Spec line.
- `useChangeTarget` and `useLosableDraft` render correctly from the initial state that `withResetTransientStores` restores before each story. The Phase 1 `TransientStoresReset` self-check covers change-highlight; nav-guard is reset by the same function.
- `pnpm test:stories <paths>` filters to those story files. I ran it for `button.stories.tsx` (10 passed). Five concurrent runs in five worktrees can share one machine; the browser server port falls back or a re-run succeeds. This is untested.
- `scrollWidth` on a `overflow: visible` frame includes descendants that paint past its edge (CSSOM scrollable overflow). Task 1 Step 6 proves it with `OverflowIsCaught`.
- `NEXT_PUBLIC_APP_VERSION` is unset in Storybook, so `AppVersion` renders `vunknown`. The story asserts only `/^v/`.
- Concurrent `bd create` calls from five agents are safe against the local Dolt DB.
- The prototype files named per group carry the state vocabulary. Where a prototype state is not implemented by the component, it is skipped (precedence: contract → DESIGN → prototype).
