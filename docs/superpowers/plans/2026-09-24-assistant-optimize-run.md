# Assistant: Offer an Optimize Run and Read Its Outcome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The schedule assistant can offer to run the optimiser. The user starts the run with the **Run** button on a host card. Then the assistant reads the result: status, solver verdict, error and saved roster. For an infeasible result, it can go on to `test_feasibility_candidates`.

**Architecture:** Two new tools without parameters go in `web/components/ai/use-optimize-tools.ts`. `request_optimize_run` shows a Run card and starts nothing. `get_optimize_result` reads the hot-store run view that the Optimize screen shows. The **Run** button on the card opens the Optimise screen. Then it puts a request into a small channel in `web/lib/optimize/run-request.ts`. The Optimize screen takes that request and calls **its own `onSubmit`**, the function of the Optimize button. Thus the run has the same options, lease preflight, basis, roster capture, download and cleanup as a manual run. The channel is in `lib/optimize` because `.oxlintrc.json` forbids scheduling code to import `lib/ai` or `components/ai` ("AI IS OPTIONAL").

**Tech Stack:** Next.js 16 (`web/`), React 19, TypeScript, zustand 5 and zod 4. Tests use vitest 4 and Testing Library. Also CopilotKit 1.66.2, oxlint and ast-grep.

**Spec:** There is no separate spec document. This plan implements the request of the controller of 2026-09-24. The rule is the product decision in `docs/ai-assistant.md` ("Product decision (2026-09-23)"). The assistant can propose all actions that the UI can do. The user approves each change. The Phase-1 limits go away one family at a time. `web/lib/ai/phase-2-absence.test.ts` changes with each family. This plan removes the limit on **solver runs**.

## Global Constraints

- The model never starts a run. Only the user's click on the card's **Run** button starts it. That click goes into the existing `onSubmit` of the Optimize screen (`web/components/optimize/optimize-and-export-screen.tsx:506-561`) and nowhere else.
- Files under `web/components/optimize/**` and `web/lib/optimize/**` must not import `@/lib/ai*` or `@/components/ai*` (oxlint `no-restricted-imports`, `.oxlintrc.json:81-94`). The assistant can import `@/lib/optimize/*`.
- Runs are visit-scoped: leaving the Optimize screen abandons the run (`optimize-and-export-screen.tsx:221-273`). This plan does not change that. The model must not be able to cause it (Task 6).
- New tools are PARAMETERLESS. Register them with `useParameterlessModelVisibleTool` and add them to `PARAMETERLESS_MODEL_VISIBLE_TOOLS`. Do not change their schemas later without re-running `lib/ai/runtime/model-visible-tools.test.ts`.
- Every handler re-checks `assertTurnAuthority(token, signal)` after each await. It stamps the card from `token.turnEpoch`, never from the closure `turnEpoch` (the reason is in `use-proposal-tools.ts:144-160`).
- `generate-roster.supportedCommands` stays `[]`. That field is typed `ScenarioCommandType[]` (`web/lib/capability/types.ts:43`), and a run writes no scenario.
- No backend (`core/`) change. No new BFF route. No new timeout except the 15 s request TTL.
- Copy uses British "optimise/optimiser" in user text, as the screen does. Tool names keep the US `optimize` spelling of the codebase.
- Tests: `cd web && pnpm vitest run <path>`. Gates: `pnpm typecheck` and `pnpm run lint`. The lint script is `oxlint && ast-grep scan`. Use `run` so that pnpm 11 does not resolve a built-in command. Do not run `pnpm install` or `pnpm build`.
- Sibling plans of the same day can also edit `help-content.ts` (`ai-assistant-conversation` summary), `ASSISTANT_AUTHORITY_STATEMENT`, `phase-2-absence.test.ts` and the welcome copy. For a conflict with an edit of this plan, keep both sentences. Do not overwrite.

## Review Focus

1. **Leaving the Optimise screen while a run is going.** Expected: the model cannot move the user away. `open_app_screen` refuses any target other than the Optimise screen while a run is live, and says why. (Test: Task 6, `refuses to leave the Optimise screen while a run is live`.)
2. **A Run click from a stopped turn.** The user presses Stop, or another tab takes over, after the card appears. Expected: the card shows as stopped with no Run button, like a stopped Preview. (Test: Task 5, `shows a stopped card with no Run control after the turn moved on`.)
3. **A request the screen never picks up** (navigation succeeded but the user left at once, or the screen mounted late). Expected: no surprise run on a later visit. The request expires after 15 s. (Test: Task 1, `expires rather than starting a run on a later visit`.)
4. **Run while a run is already live.** A manual run started after the card appeared. Expected: the Run button is disabled with a reason, and the tool refuses to offer a second run. (Tests: Task 5, `disables Run while a run is live`, and Task 4, `refuses a second run while one is live`.)
5. **Asking for the result after leaving the screen.** Expected: the answer is "no run on screen", with the rule that leaving the screen ends the run. It is never a stale result from a previous visit. The screen resets the view on exit, and the summary reports what is there. (Test: Task 4, `reports an idle screen and how to get a run`.)

---

## File Structure

- Create `web/lib/optimize/run-request.ts`: the request channel (`requestOptimizeRun`, `takeOptimizeRunRequest`, `reportOptimizeRunRequest`, `useRunRequestStore`, `isRunLive`, `RUN_REQUEST_TTL_MS`). No React, no AI imports.
- Modify `web/lib/optimize/index.ts`: re-export the channel.
- Modify `web/components/optimize/optimize-and-export-screen.tsx`: one effect that consumes the request and calls `onSubmit`.
- Modify `web/lib/ai/assistant/store.ts`: `activeRunRequest` state plus `showRunRequest` / `clearRunRequest`.
- Create `web/components/ai/use-optimize-tools.ts`: the two tools and the pure `summarizeOptimizeRun`.
- Modify `web/components/ai/use-context-tools.ts`: register `useOptimizeTools`.
- Modify `web/components/ai/model-visible-tools.ts`: add the two names to `PARAMETERLESS_MODEL_VISIBLE_TOOLS`.
- Create `web/components/ai/optimize-run-request-card.tsx`: the host Run card.
- Modify `web/components/ai/assistant-conversation.tsx`: mount the card, two `TOOL_ACTIVITY` labels, welcome copy.
- Modify `web/components/ai/use-help-tools.ts`: `open_app_screen` refuses to leave a live run.
- Modify `web/lib/ai/assistant/scenario-context.ts`: one sentence in `ASSISTANT_AUTHORITY_STATEMENT`.
- Modify `web/lib/capability/help-content.ts` and regenerate `web/lib/capability/registry.generated.ts`.
- Modify `docs/ai-assistant.md`.
- New tests:
  - `web/lib/optimize/run-request.test.ts`
  - `web/components/ai/use-optimize-tools.test.tsx`
  - `web/components/ai/optimize-run-request-card.test.tsx`
- Changed tests:
  - `web/components/optimize/optimize-and-export-screen.test.tsx`
  - `web/components/ai/assistant-activity.test.tsx`
  - `web/components/ai/use-help-tools.test.tsx`
  - `web/lib/ai/assistant/scenario-context.test.ts`
  - `web/lib/ai/phase-2-absence.test.ts` (locked list)
  - `web/lib/capability/tools.test.ts` (locked list)

---

### Task 1: The run-request channel

**Files:**
- Create: `web/lib/optimize/run-request.ts`
- Modify: `web/lib/optimize/index.ts` (append an export block)
- Test: `web/lib/optimize/run-request.test.ts`

**Interfaces:**
- Consumes: `isActiveLifecycle`, `RunLifecycle` from `./run-view`.
- Produces:
  - `RUN_REQUEST_TTL_MS: number` (15 000)
  - `type RunRequestOutcome = "started" | "not-ready" | "backend-offline" | "busy"`
  - `useRunRequestStore` (zustand): `{ pending: { requestedAt: number } | null; last: RunRequestOutcome | null }`
  - `requestOptimizeRun(now?: number): void`: sets `pending` and clears `last`
  - `takeOptimizeRunRequest(now?: number): boolean`: clears `pending`. It returns true only for a fresh request.
  - `reportOptimizeRunRequest(outcome: RunRequestOutcome): void`
  - `isRunLive(lifecycle: RunLifecycle): boolean`: `submitting` or queued/running/cancelling

- [ ] **Step 1: Write the failing test**

Create `web/lib/optimize/run-request.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  RUN_REQUEST_TTL_MS,
  isRunLive,
  reportOptimizeRunRequest,
  requestOptimizeRun,
  takeOptimizeRunRequest,
  useRunRequestStore,
} from "./run-request";

beforeEach(() => {
  useRunRequestStore.setState({ pending: null, last: null });
});

describe("the assistant's run request", () => {
  it("is taken exactly once", () => {
    requestOptimizeRun(1_000);
    expect(takeOptimizeRunRequest(1_000)).toBe(true);
    expect(takeOptimizeRunRequest(1_000)).toBe(false);
  });

  it("expires rather than starting a run on a later visit", () => {
    requestOptimizeRun(1_000);
    expect(takeOptimizeRunRequest(1_000 + RUN_REQUEST_TTL_MS + 1)).toBe(false);
    // Consumed either way: an expired request must not linger for the next mount.
    expect(useRunRequestStore.getState().pending).toBeNull();
  });

  it("forgets the previous outcome when a new request is made", () => {
    reportOptimizeRunRequest("backend-offline");
    requestOptimizeRun(1_000);
    expect(useRunRequestStore.getState().last).toBeNull();
  });

  it("treats a POST in flight and every server-active lifecycle as live", () => {
    for (const lifecycle of ["submitting", "queued", "running", "cancelling"] as const) {
      expect(isRunLive(lifecycle), lifecycle).toBe(true);
    }
    for (const lifecycle of [
      "idle",
      "submit-blocked",
      "submit-rejected",
      "submit-unknown",
      "completed",
      "cancelled",
      "failed",
    ] as const) {
      expect(isRunLive(lifecycle), lifecycle).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `cd web && pnpm vitest run lib/optimize/run-request.test.ts`
Expected: FAIL, `Failed to resolve import "./run-request"`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/optimize/run-request.ts`:

```ts
// The one seam through which something OUTSIDE the Optimize screen can ask it to run.
//
// The assistant's confirm card calls `requestOptimizeRun` after the user presses Run;
// the screen takes the request and calls its own `onSubmit`, the exact function the
// Optimize button calls. So an assistant-started run IS a manual run: same options,
// same lease preflight, same basis, capture, download and cleanup.
//
// It lives here, not in lib/ai, because scheduling code may never import assistant
// code (`.oxlintrc.json`, "AI IS OPTIONAL"). The dependency points the allowed way:
// the assistant imports this; this imports nothing of the assistant's.

import { create } from "zustand";
import { isActiveLifecycle, type RunLifecycle } from "./run-view";

/** How long a Run click waits for the Optimize screen to pick it up. */
// ponytail: fixed TTL. A request the screen did not see in time is dropped so it can
// never start a surprise run on a later visit; make it configurable only if slow
// route transitions show up in practice.
export const RUN_REQUEST_TTL_MS = 15_000;

/** What the screen did with the last request it took. */
export type RunRequestOutcome = "started" | "not-ready" | "backend-offline" | "busy";

export interface RunRequestState {
  pending: { requestedAt: number } | null;
  last: RunRequestOutcome | null;
}

export const useRunRequestStore = create<RunRequestState>()(() => ({
  pending: null,
  last: null,
}));

export function requestOptimizeRun(now: number = Date.now()): void {
  useRunRequestStore.setState({ pending: { requestedAt: now }, last: null });
}

/** Consume the pending request. True only when it was still fresh. */
export function takeOptimizeRunRequest(now: number = Date.now()): boolean {
  const { pending } = useRunRequestStore.getState();
  if (pending === null) return false;
  useRunRequestStore.setState({ pending: null });
  return now - pending.requestedAt <= RUN_REQUEST_TTL_MS;
}

export function reportOptimizeRunRequest(outcome: RunRequestOutcome): void {
  useRunRequestStore.setState({ last: outcome });
}

/** A POST in flight, or a server job that is queued, running or cancelling. */
export function isRunLive(lifecycle: RunLifecycle): boolean {
  return lifecycle === "submitting" || isActiveLifecycle(lifecycle);
}
```

Append to `web/lib/optimize/index.ts`:

```ts
// The seam an assistant Run click uses to ask the Optimize screen for its own run.
export {
  RUN_REQUEST_TTL_MS,
  isRunLive,
  reportOptimizeRunRequest,
  requestOptimizeRun,
  takeOptimizeRunRequest,
  useRunRequestStore,
  type RunRequestOutcome,
  type RunRequestState,
} from "./run-request";
```

- [ ] **Step 4: Run the test and check that it passes**

Run: `cd web && pnpm vitest run lib/optimize/run-request.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/optimize/run-request.ts web/lib/optimize/run-request.test.ts web/lib/optimize/index.ts
git commit -m "feat(optimize): run-request seam for an externally confirmed run"
```

---

### Task 2: The Optimize screen takes the request through its own `onSubmit`

**Files:**
- Modify: `web/components/optimize/optimize-and-export-screen.tsx`: imports (`:39-67`), and a new effect after `disabledReason` (`:604-608`), before `return`
- Test: `web/components/optimize/optimize-and-export-screen.test.tsx` (new `describe` at the end, and the `@/lib/optimize` import at `:33-41`)

**Interfaces:**
- Consumes: `useRunRequestStore`, `takeOptimizeRunRequest`, `reportOptimizeRunRequest` from `@/lib/optimize` (Task 1). Uses the screen's existing `onSubmit`, `readiness.ready`, `serverInfo.status`, `submitInFlight`.
- Produces: after a request is taken, `useRunRequestStore.getState().last` is one of `"started" | "not-ready" | "backend-offline" | "busy"`.

- [ ] **Step 1: Write the failing tests**

In `web/components/optimize/optimize-and-export-screen.test.tsx`, add `requestOptimizeRun` and `useRunRequestStore` to the existing `from "@/lib/optimize"` import. Then append:

```tsx
describe("OptimizeAndExportScreen — assistant run request", () => {
  beforeEach(() => {
    useRunRequestStore.setState({ pending: null, last: null });
  });

  /** Routes the run's traffic and counts POSTs, the one fact these cases assert. */
  function countPosts(): () => number {
    let posts = 0;
    routeFetch((u, init) => {
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/optimize") && method === "POST") {
        posts += 1;
        return json(202, baseJob());
      }
      if (u.endsWith("/events")) return streamResponse(": keepalive\n\n");
      // Unmount abandons a live run, and retirement cancels it.
      if (u.endsWith("/cancel")) return json(200, baseJob({ state: "cancelled", terminal: true }));
      if (/\/api\/optimize\/[^/]+$/.test(u)) return json(200, baseJob({ state: "running" }));
      throw new Error(`unexpected request: ${u}`);
    });
    return () => posts;
  }

  function renderScreen(serverInfoDeps = onlineInfo()) {
    render(
      <OptimizeAndExportScreen
        serverInfoDeps={serverInfoDeps}
        controllerDeps={{
          prepare: () => okPrep,
          stageSnapshot: degradedCapture,
          storage: memStorage(),
        }}
      />,
      { wrapper },
    );
  }

  it("starts the run through the Optimize path when the assistant card asks", async () => {
    await readyStore();
    const posts = countPosts();
    requestOptimizeRun();
    renderScreen();

    await waitFor(() => expect(posts()).toBe(1));
    expect(useRunRequestStore.getState()).toEqual({ pending: null, last: "started" });
  });

  it("reports not-ready and posts nothing when set-up is missing", async () => {
    const posts = countPosts();
    requestOptimizeRun();
    renderScreen();

    await waitFor(() => expect(useRunRequestStore.getState().last).toBe("not-ready"));
    expect(posts()).toBe(0);
  });

  it("reports backend-offline and posts nothing when the backend is down", async () => {
    await readyStore();
    const posts = countPosts();
    requestOptimizeRun();
    renderScreen({
      fetchInfo: async () => ({
        status: 502,
        body: { status: "unavailable", reason: "backend_unreachable" },
      }),
      clientVersion: "1.0.0",
    });

    await waitFor(() => expect(useRunRequestStore.getState().last).toBe("backend-offline"));
    expect(posts()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd web && pnpm vitest run components/optimize/optimize-and-export-screen.test.tsx -t "assistant run request"`
Expected: FAIL. The three cases time out in `waitFor`: `posts()` stays 0 and `last` stays `null`.

- [ ] **Step 3: Write the implementation**

In `optimize-and-export-screen.tsx`, add to the `from "@/lib/optimize"` import list:

```ts
  reportOptimizeRunRequest,
  takeOptimizeRunRequest,
  useRunRequestStore,
```

Directly after the `disabledReason` constant (before `return (`), add:

```tsx
  // ASSISTANT RUN REQUEST. The assistant's confirm card asks for exactly the run the
  // Optimize button starts, so this calls the SAME `onSubmit`: options, lease
  // preflight, basis, capture, download and cleanup are the button's, not a copy.
  // It waits while the backend check is still `checking`; the request itself
  // expires (`run-request.ts`), so a late mount never starts a surprise run.
  const runRequested = useRunRequestStore((state) => state.pending !== null);
  useEffect(() => {
    if (!runRequested || serverInfo.status === "checking") return;
    if (!takeOptimizeRunRequest()) return;
    if (!readiness.ready) {
      reportOptimizeRunRequest("not-ready");
      return;
    }
    if (serverInfo.status !== "online") {
      reportOptimizeRunRequest("backend-offline");
      return;
    }
    if (submitInFlight) {
      reportOptimizeRunRequest("busy");
      return;
    }
    reportOptimizeRunRequest("started");
    void onSubmit();
  }, [runRequested, serverInfo.status, readiness.ready, submitInFlight, onSubmit]);
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run components/optimize/optimize-and-export-screen.test.tsx`
Expected: PASS, the whole file, including the three new cases.

- [ ] **Step 5: Commit**

```bash
git add web/components/optimize/optimize-and-export-screen.tsx web/components/optimize/optimize-and-export-screen.test.tsx
git commit -m "feat(optimize): screen starts a requested run through its own onSubmit"
```

---

### Task 3: Assistant store holds the live run-request card

**Files:**
- Modify: `web/lib/ai/assistant/store.ts`: `AssistantUiState` (after `activeDiagnostic`, about `:323`), `INITIAL` (about `:360`), `assistantActions` (after `clearDiagnostic`, `:1054`)

**Interfaces:**
- Produces:
  - `AssistantUiState.activeRunRequest: { turnEpoch: number } | null`
  - `assistantActions.showRunRequest(turnEpoch: number): void`
  - `assistantActions.clearRunRequest(): void`

No test of its own: it is two setters. Tasks 4 and 5 exercise it. `resetForTest` spreads `INITIAL`, so the field resets with no extra code.

- [ ] **Step 1: Add the state**

In `AssistantUiState`, after `activeDiagnostic`:

```ts
  /**
   * The live "Run the optimiser?" card, stamped with the turn that asked for it.
   *
   * Same authority rule as `activeProposal`: after an interruption the card renders
   * as stopped with no Run control, rather than as a live action for a conversation
   * the user already stopped. In memory only; a reload has no live card.
   */
  activeRunRequest: { turnEpoch: number } | null;
```

In `INITIAL`, after `activeDiagnostic: null,`:

```ts
  activeRunRequest: null,
```

In `assistantActions`, after `clearDiagnostic()`:

```ts
  /** Show the host confirm card for an optimiser run the current turn asked for. */
  showRunRequest(turnEpoch: number): void {
    useAssistantStore.setState({ activeRunRequest: { turnEpoch } });
  },

  /** Dismiss the run card: Run was pressed, or the user said not now. */
  clearRunRequest(): void {
    useAssistantStore.setState({ activeRunRequest: null });
  },
```

- [ ] **Step 2: Typecheck**

Run: `cd web && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/lib/ai/assistant/store.ts
git commit -m "feat(assistant): store slot for the optimiser run card"
```

---

### Task 4: The two tools, and the locked tool lists

**Files:**
- Create: `web/components/ai/use-optimize-tools.ts`
- Modify: `web/components/ai/use-context-tools.ts`:
  - imports
  - a call inside `useModelVisibleTools` after `useDiagnosticTools(...)` (`:74`)
  - the header comment (`:5-11`)
- Modify: `web/components/ai/model-visible-tools.ts:43-46`
- Modify (locked): `web/lib/ai/phase-2-absence.test.ts:43-56`, `web/lib/capability/tools.test.ts:30-33`
- Test: `web/components/ai/use-optimize-tools.test.tsx`

**Interfaces:**
- Consumes:
  - `isRunLive`, `useRunRequestStore`, `RunRequestOutcome` (Task 1)
  - `assistantActions.showRunRequest` (Task 3)
  - `deriveOptimizeReadiness` (`@/lib/optimize/optimize-readiness`)
  - `terminalHeading` (`@/lib/optimize/run-display`)
  - `getRosterCaptureGate` (`@/lib/optimize/roster-capture-app`)
  - `pickScenario`, `useScenarioStore`, `useHotStore`, `readAuthoritativeScenarioOwnership` (`@/lib/store`)
- Produces:
  - `useOptimizeTools(agentId: string, turnEpoch: number): void`
  - `summarizeOptimizeRun(view: OptimizeRunView, rosterSaved: boolean, lastRequest: RunRequestOutcome | null): OptimizeRunSummary`
  - tool names `"request_optimize_run"`, `"get_optimize_result"`

- [ ] **Step 1: Write the failing test**

Create `web/components/ai/use-optimize-tools.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createEmptyScenarioUiState, type ScenarioUiState } from "@/lib/scenario";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW, type OptimizeRunView } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { useOptimizeTools } from "./use-optimize-tools";
import { bindTurnForTest, type TestTurnHandle } from "./turn-authority.test-support";

// Tools are exercised through their REGISTERED definitions, as in use-help-tools.test:
// what matters is the object the model is offered and what its handler answers.
interface CapturedTool {
  name: string;
  description: string;
  handler: (args: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}
const captured: CapturedTool[] = [];
vi.mock("@copilotkit/react-core/v2", () => ({
  useFrontendTool: (definition: CapturedTool) => {
    if (!captured.some((tool) => tool.name === definition.name)) captured.push(definition);
  },
  useCopilotKit: () => ({ copilotkit: SCOPE }),
}));
const SCOPE = {};

const fixture = vi.hoisted(() => ({
  scenario: null as unknown,
  isOwner: true,
  capture: "idle",
}));
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    pickScenario: () => fixture.scenario,
    readAuthoritativeScenarioOwnership: async () => ({
      isOwner: fixture.isOwner,
      documentRevision: 1,
    }),
  };
});
vi.mock("@/lib/optimize/roster-capture-app", () => ({
  getRosterCaptureGate: () => ({ getState: () => ({ status: fixture.capture }) }),
}));

const TURN = 7;
let boundTurn: TestTurnHandle;

function readyScenario(overrides: Partial<ScenarioUiState> = {}): ScenarioUiState {
  return {
    ...createEmptyScenarioUiState(),
    rangeStart: "2026-10-01",
    rangeEnd: "2026-10-14",
    staff: [{ id: "p1" }] as ScenarioUiState["staff"],
    shifts: [{ id: "D" }] as ScenarioUiState["shifts"],
    ...overrides,
  };
}

function view(overrides: Partial<OptimizeRunView>): OptimizeRunView {
  return { ...INITIAL_OPTIMIZE_RUN_VIEW, ...overrides };
}

function Host() {
  useOptimizeTools("scheduler:thread-1", TURN);
  return null;
}

function tool(name: string): CapturedTool {
  const found = captured.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool "${name}" was never registered`);
  return found;
}

beforeEach(() => {
  captured.length = 0;
  fixture.scenario = readyScenario();
  fixture.isOwner = true;
  fixture.capture = "idle";
  useAssistantStore.setState({ turnEpoch: TURN });
  useRunRequestStore.setState({ pending: null, last: null });
  useHotStore.getState().resetRunView();
  boundTurn = bindTurnForTest({ turnEpoch: TURN });
  render(<Host />);
});

afterEach(() => {
  boundTurn.release();
  cleanup();
  assistantActions.resetForTest();
  useHotStore.getState().resetRunView();
});

describe("the optimiser tools", () => {
  it("registers exactly the two tools", () => {
    expect(captured.map((t) => t.name).sort()).toEqual([
      "get_optimize_result",
      "request_optimize_run",
    ]);
  });
});

describe("request_optimize_run", () => {
  it("shows a card stamped with the turn and starts nothing", async () => {
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/Nothing has started/);
    expect(useAssistantStore.getState().activeRunRequest).toEqual({ turnEpoch: TURN });
    expect(useRunRequestStore.getState().pending).toBeNull();
  });

  it("refuses and names what is missing when set-up is incomplete", async () => {
    fixture.scenario = readyScenario({ staff: [] });
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/Staff/);
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });

  it("refuses in a tab that does not hold the schedule", async () => {
    fixture.isOwner = false;
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/another tab/);
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });

  it("refuses a second run while one is live", async () => {
    useHotStore.getState().setRunView(view({ lifecycle: "running", jobId: "opt_1" }));
    const answer = await tool("request_optimize_run").handler({}, {});
    expect(answer).toMatch(/already going/);
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });
});

describe("get_optimize_result", () => {
  it("reports an idle screen and how to get a run", async () => {
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      status: string;
      guidance: string;
    };
    expect(summary.status).toBe("idle");
    expect(summary.guidance).toMatch(/request_optimize_run/);
    expect(summary.guidance).toMatch(/leaving it stops the run/);
  });

  it("says why a requested run did not start", async () => {
    useRunRequestStore.setState({ last: "backend-offline" });
    const summary = (await tool("get_optimize_result").handler({}, {})) as { guidance: string };
    expect(summary.guidance).toMatch(/not reachable/);
  });

  it("tells the model a live run has no result yet", async () => {
    useHotStore
      .getState()
      .setRunView(view({ lifecycle: "queued", jobId: "opt_1", queuePosition: 2 }));
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      queuePosition: number;
      guidance: string;
    };
    expect(summary.queuePosition).toBe(2);
    expect(summary.guidance).toMatch(/still going/);
  });

  it("points an infeasible run at the bounded diagnostic, and forbids a cause", async () => {
    useHotStore.getState().setRunView(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        outcome: "infeasible",
        result: {
          outcome: "infeasible",
          score: null,
          solverStatus: "INFEASIBLE",
          terminationReason: null,
        },
      }),
    );
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      heading: string;
      guidance: string;
    };
    expect(summary.heading).toBe("This roster can't be built");
    expect(summary.guidance).toMatch(/test_feasibility_candidates/);
    expect(summary.guidance).toMatch(/never name a cause/);
  });

  it("reports a saved roster for a solved run", async () => {
    fixture.capture = "committed";
    useHotStore.getState().setRunView(
      view({
        lifecycle: "completed",
        jobId: "opt_1",
        outcome: "optimal",
        result: {
          outcome: "optimal",
          score: 42,
          solverStatus: "OPTIMAL",
          terminationReason: "optimality_proven",
        },
      }),
    );
    const summary = (await tool("get_optimize_result").handler({}, {})) as {
      rosterSaved: boolean;
      score: number;
      guidance: string;
    };
    expect(summary.rosterSaved).toBe(true);
    expect(summary.score).toBe(42);
    expect(summary.guidance).toMatch(/Open & adjust roster/);
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `cd web && pnpm vitest run components/ai/use-optimize-tools.test.tsx`
Expected: FAIL, `Failed to resolve import "./use-optimize-tools"`.

- [ ] **Step 3: Write the tool module**

Create `web/components/ai/use-optimize-tools.ts`:

```ts
"use client";

// The assistant's optimiser tools (plan 2026-09-24-assistant-optimize-run).
//
// THE MODEL ASKS; THE USER STARTS. `request_optimize_run` only shows a host card.
// The run begins when the user presses Run on it, and then through the Optimize
// screen's own `onSubmit` -- the exact path the Optimize button takes (see
// `lib/optimize/run-request.ts`). `get_optimize_result` reads the run view that
// screen renders. Neither tool starts, stops or alters a run, and neither takes an
// argument, so there is no payload for the model to shape.

import { useParameterlessModelVisibleTool } from "./register-model-visible-tool";
import {
  pickScenario,
  readAuthoritativeScenarioOwnership,
  useHotStore,
  useScenarioStore,
} from "@/lib/store";
import { deriveOptimizeReadiness } from "@/lib/optimize/optimize-readiness";
import { terminalHeading } from "@/lib/optimize/run-display";
import type { OptimizeRunView } from "@/lib/optimize/run-view";
import { isRunLive, useRunRequestStore, type RunRequestOutcome } from "@/lib/optimize/run-request";
import { getRosterCaptureGate } from "@/lib/optimize/roster-capture-app";
import { assistantActions } from "@/lib/ai/assistant/store";
import { assertTurnAuthority, SUPERSEDED } from "./turn-authority";

/** What the model reads about the run on the Optimise screen. Compact on purpose. */
export interface OptimizeRunSummary {
  status: OptimizeRunView["lifecycle"];
  /** The screen's own heading for a settled run, e.g. "This roster can't be built". */
  heading: string | null;
  outcome: OptimizeRunView["outcome"];
  score: number | null;
  solverStatus: string | null;
  terminationReason: string | null;
  error: { code: string | null; message: string } | null;
  queuePosition: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  downloaded: boolean;
  rosterSaved: boolean;
  guidance: string;
}

const REQUEST_REFUSAL: Record<Exclude<RunRequestOutcome, "started">, string> = {
  "not-ready": "The requested run did not start: dates, staff or shifts are still missing.",
  "backend-offline": "The requested run did not start: the optimiser is not reachable right now.",
  busy: "The requested run did not start: another start was already in progress.",
};

function guidanceFor(
  view: OptimizeRunView,
  rosterSaved: boolean,
  lastRequest: RunRequestOutcome | null,
): string {
  if (view.lifecycle === "idle") {
    if (lastRequest !== null && lastRequest !== "started") {
      return `${REQUEST_REFUSAL[lastRequest]} Tell the user, and help them fix it.`;
    }
    return (
      "No run is showing on the Optimise screen. A run lives only while that screen is " +
      "open; leaving it stops the run. If the user wants a roster, use request_optimize_run."
    );
  }
  if (isRunLive(view.lifecycle)) {
    return (
      "The run is still going. Tell the user to stay on the Optimise screen, where they can " +
      "cancel it or ask it to finish now. Do not describe a result yet; check again later."
    );
  }
  if (view.lifecycle === "completed") {
    switch (view.outcome) {
      case "optimal":
      case "feasible":
        return (
          "A roster was produced. Its XLSX file downloads in the browser, as for any run; if " +
          "it did not, the user can press Download again on the Optimise screen. " +
          (rosterSaved
            ? "It is also saved in the app: the user can open it with Open & adjust roster."
            : "No copy was saved to open in the app; the downloaded file is the result.")
        );
      case "infeasible":
        return (
          "The rules as written cannot all be met, so no roster exists. The solver does not " +
          "say which rule is responsible: never name a cause. You may use " +
          "test_feasibility_candidates to test candidate changes on copies."
        );
      case "inconclusive":
        return (
          "The optimiser found no roster within its time limit and proved nothing either " +
          "way. Suggest a longer time limit on the Optimise screen, or softening hard rules, " +
          "then another run."
        );
    }
  }
  return (
    "The run ended without a roster. Explain the error in plain words; the user can run " +
    "again when ready."
  );
}

/** Project the screen's run view into what the model may read. Pure. */
export function summarizeOptimizeRun(
  view: OptimizeRunView,
  rosterSaved: boolean,
  lastRequest: RunRequestOutcome | null,
): OptimizeRunSummary {
  return {
    status: view.lifecycle,
    heading: terminalHeading(view),
    outcome: view.outcome,
    score: view.result?.score ?? null,
    solverStatus: view.result?.solverStatus ?? null,
    terminationReason: view.result?.terminationReason ?? null,
    error: view.error ? { code: view.error.code, message: view.error.message } : null,
    queuePosition: view.queuePosition,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    downloaded: view.download.status === "downloaded",
    rosterSaved,
    guidance: guidanceFor(view, rosterSaved, lastRequest),
  };
}

export function useOptimizeTools(agentId: string, turnEpoch: number): void {
  useParameterlessModelVisibleTool(
    {
      name: "request_optimize_run",
      agentId,
      description:
        "Offer to run the optimiser on the schedule as it is now. This does NOT start " +
        "anything: it shows the user a card, and the run starts only if they press Run -- " +
        "exactly as if they had pressed Optimize on the Optimise screen. Use it when the " +
        "user wants a roster. A run can take minutes, and leaving the Optimise screen stops it.",
      handler: async ({ token, signal }) => {
        if (isRunLive(useHotStore.getState().runView.lifecycle)) {
          return (
            "A run is already going on the Optimise screen. Do not offer another; use " +
            "get_optimize_result to follow it."
          );
        }
        const readiness = deriveOptimizeReadiness(pickScenario(useScenarioStore.getState()));
        if (!readiness.ready) {
          const missing = readiness.issues.map((issue) => issue.linkLabel).join(", ");
          return (
            `The optimiser cannot run yet. Missing: ${missing}. Help the user set these up ` +
            "first, preparing changes where you can."
          );
        }
        const ownership = await readAuthoritativeScenarioOwnership();
        const late = assertTurnAuthority(token, signal);
        if (late) return late;
        // Narrowing only; the guard above already refuses a null token.
        if (token === null) return SUPERSEDED;
        if (ownership === null || !ownership.isOwner) {
          return (
            "This schedule is being edited in another tab, so a run cannot start here. Tell " +
            "the user they can take over editing in this tab."
          );
        }
        assistantActions.showRunRequest(token.turnEpoch);
        return (
          "The user now sees a card asking whether to run the optimiser. Nothing has started, " +
          "and only the user can start it by pressing Run. Do not say a run has started. Tell " +
          "them it uses the Optimise screen's settings, downloads an XLSX when it finishes, and " +
          "stops if they leave that screen. Once they have pressed Run, use get_optimize_result " +
          "to see how it is going."
        );
      },
    },
    [agentId, turnEpoch],
  );

  useParameterlessModelVisibleTool(
    {
      name: "get_optimize_result",
      agentId,
      description:
        "Read how the latest optimiser run on the Optimise screen is going or how it ended: " +
        "its status, the solver verdict (optimal, feasible, infeasible or inconclusive), any " +
        "error, and whether a roster was saved. It reports only what that screen shows and " +
        "never starts or changes a run.",
      handler: async () => {
        const view = useHotStore.getState().runView;
        const rosterSaved =
          view.jobId !== null && getRosterCaptureGate().getState(view.jobId).status === "committed";
        return summarizeOptimizeRun(view, rosterSaved, useRunRequestStore.getState().last);
      },
    },
    [agentId, turnEpoch],
  );
}
```

- [ ] **Step 4: Register the tools**

In `web/components/ai/use-context-tools.ts`, add the import:

```ts
import { useOptimizeTools } from "./use-optimize-tools";
```

and, right after `useDiagnosticTools(agentId, turnEpoch);`:

```ts
  // The optimiser pair (plan 2026-09-24): offer a run the USER starts from a host
  // card, and read the run view the Optimise screen renders. Neither starts a run.
  useOptimizeTools(agentId, turnEpoch);
```

In the header comment (`:5-11`), change "All three are non-mutating. There is deliberately no Apply tool and no diagnostic submit" to "All of them are non-mutating. There is deliberately no Apply tool and no run-start tool: a run starts only from the user's click on a host card".

In `web/components/ai/model-visible-tools.ts`, change the parameterless list to:

```ts
export const PARAMETERLESS_MODEL_VISIBLE_TOOLS: readonly string[] = Object.freeze([
  "get_schedule_overview",
  "list_app_capabilities",
  "request_optimize_run",
  "get_optimize_result",
]);
```

- [ ] **Step 5: Update the locked tool lists, with a dated reason**

In `web/lib/ai/phase-2-absence.test.ts`, add to `MODEL_VISIBLE_TOOLS` after `"test_feasibility_candidates",`:

```ts
  // WIDENED DELIBERATELY (2026-09-24, plan assistant-optimize-run): solver runs are
  // the next lifted family. request_optimize_run only shows a host card; the run
  // starts from the user's Run click through the Optimize screen's own onSubmit.
  // get_optimize_result reads that screen's run view. Neither names a roster verb.
  "request_optimize_run",
  "get_optimize_result",
```

In `web/lib/capability/tools.test.ts`, add to `NOT_REGISTRY_GOVERNED`:

```ts
  request_optimize_run: "Optimiser run: shows a host card; the USER starts the run",
  get_optimize_result: "Optimiser run: reads the Optimise screen's run view",
```

- [ ] **Step 6: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run components/ai/use-optimize-tools.test.tsx lib/ai/phase-2-absence.test.ts lib/capability/tools.test.ts lib/ai/runtime/model-visible-tools.test.ts components/ai/session-real-core.test.tsx components/ai/tool-payload-boundary.test.tsx`
Expected: PASS. `phase-2-absence` "names no tool after a roster-repair capability" still passes (`PHASE_2_VERBS` has no match in either name).

- [ ] **Step 7: Commit**

```bash
git add web/components/ai/use-optimize-tools.ts web/components/ai/use-optimize-tools.test.tsx web/components/ai/use-context-tools.ts web/components/ai/model-visible-tools.ts web/lib/ai/phase-2-absence.test.ts web/lib/capability/tools.test.ts
git commit -m "feat(assistant): request_optimize_run and get_optimize_result tools"
```

---

### Task 5: The Run card, activity labels and welcome copy

**Files:**
- Create: `web/components/ai/optimize-run-request-card.tsx`
- Modify: `web/components/ai/assistant-conversation.tsx`:
  - the import
  - `<OptimizeRunRequestCard />` after `<DiagnosticSearchCard />` (`:170`)
  - `TOOL_ACTIVITY` (`:106-115`)
  - the `WelcomeState` copy (`:44-46`)
- Test: `web/components/ai/optimize-run-request-card.test.tsx`, `web/components/ai/assistant-activity.test.tsx`

**Interfaces:**
- Consumes: `activeRunRequest`, `turnEpoch`, `showRunRequest`, `clearRunRequest` (Task 3). `isRunLive`, `requestOptimizeRun`, `useRunRequestStore` (Task 1). `useCapabilityNavigation` (`./use-capability-navigation`). `CAPABILITY_UNAVAILABLE` (`@/lib/capability/resolve`). `useHotStore` (`@/lib/store`).
- Produces: `OptimizeRunRequestCard(): JSX.Element | null`. Test ids: `assistant-run-request`, `run-request-run`, `run-request-dismiss`, `run-request-live`, `run-request-failed`.

- [ ] **Step 1: Write the failing tests**

Create `web/components/ai/optimize-run-request-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import { useRunRequestStore } from "@/lib/optimize/run-request";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { OptimizeRunRequestCard } from "./optimize-run-request-card";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("./use-capability-navigation", () => ({
  useCapabilityNavigation: () => navigate,
}));

const TURN = 3;

beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue({ status: "focused" });
  useAssistantStore.setState({ turnEpoch: TURN });
  useRunRequestStore.setState({ pending: null, last: null });
  useHotStore.getState().resetRunView();
});

afterEach(() => {
  cleanup();
  assistantActions.resetForTest();
  useHotStore.getState().resetRunView();
});

describe("OptimizeRunRequestCard", () => {
  it("renders nothing when no run was offered", () => {
    const { container } = render(<OptimizeRunRequestCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the Optimise screen, hands it the request, and goes away on Run", async () => {
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    await userEvent.click(screen.getByTestId("run-request-run"));

    expect(navigate).toHaveBeenCalledWith("generate-roster");
    await waitFor(() => expect(useRunRequestStore.getState().pending).not.toBeNull());
    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
  });

  it("asks for nothing when the Optimise screen cannot be opened", async () => {
    navigate.mockResolvedValue({ status: "capability_unavailable", reason: "route_not_reached" });
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    await userEvent.click(screen.getByTestId("run-request-run"));

    expect(await screen.findByTestId("run-request-failed")).toBeInTheDocument();
    expect(useRunRequestStore.getState().pending).toBeNull();
  });

  it("shows a stopped card with no Run control after the turn moved on", () => {
    assistantActions.showRunRequest(TURN);
    useAssistantStore.setState({ turnEpoch: TURN + 1 });
    render(<OptimizeRunRequestCard />);

    expect(screen.getByTestId("assistant-run-request")).toHaveAttribute("data-status", "stopped");
    expect(screen.queryByTestId("run-request-run")).not.toBeInTheDocument();
  });

  it("disables Run while a run is live", () => {
    useHotStore
      .getState()
      .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "running", jobId: "opt_1" });
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    expect(screen.getByTestId("run-request-run")).toBeDisabled();
    expect(screen.getByTestId("run-request-live")).toBeInTheDocument();
  });

  it("dismisses on Not now without asking for a run", async () => {
    assistantActions.showRunRequest(TURN);
    render(<OptimizeRunRequestCard />);

    await userEvent.click(screen.getByTestId("run-request-dismiss"));

    expect(useAssistantStore.getState().activeRunRequest).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(useRunRequestStore.getState().pending).toBeNull();
  });
});
```

In `web/components/ai/assistant-activity.test.tsx`, inside `describe("AssistantActivityStatus")`, add:

```tsx
  it("labels the optimiser tools without claiming a run", () => {
    render(<AssistantActivityStatus activity={{ kind: "tool", name: "request_optimize_run" }} />);
    expect(screen.getByRole("status").textContent).toContain("Offering an optimiser run…");
    cleanup();
    render(<AssistantActivityStatus activity={{ kind: "tool", name: "get_optimize_result" }} />);
    expect(screen.getByRole("status").textContent).toContain("Checking the optimiser run…");
  });
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd web && pnpm vitest run components/ai/optimize-run-request-card.test.tsx components/ai/assistant-activity.test.tsx -t "OptimizeRunRequestCard|optimiser tools"`
Expected: FAIL. The card import does not resolve, and the activity case shows "Working…".

- [ ] **Step 3: Write the card**

Create `web/components/ai/optimize-run-request-card.tsx`:

```tsx
"use client";

// The host card behind `request_optimize_run`.
//
// A SIBLING OF THE TRANSCRIPT, like the Preview card: the Run control is host state
// and the model cannot press it. Run takes the user to the Optimise screen (if they
// are not there), then hands the request to that screen, which starts it through its
// own Optimize path (`lib/optimize/run-request.ts`). A card from a turn that was since
// stopped renders as stopped, with no Run control, like a stopped Preview.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { assistantActions, useAssistantStore } from "@/lib/ai/assistant/store";
import { CAPABILITY_UNAVAILABLE } from "@/lib/capability/resolve";
import { isRunLive, requestOptimizeRun } from "@/lib/optimize/run-request";
import { useHotStore } from "@/lib/store";
import { useCapabilityNavigation } from "./use-capability-navigation";

export function OptimizeRunRequestCard() {
  const active = useAssistantStore((state) => state.activeRunRequest);
  const liveEpoch = useAssistantStore((state) => state.turnEpoch);
  const runLive = useHotStore((state) => isRunLive(state.runView.lifecycle));
  const navigate = useCapabilityNavigation();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  if (active === null) return null;
  const stopped = active.turnEpoch !== liveEpoch;

  const onRun = async () => {
    setOpening(true);
    setFailed(false);
    try {
      // The user's click is its own authority, so navigation is unguarded -- the same
      // as a manual jump. It lands on the run options and confirms they are on screen.
      const outcome = await navigate("generate-roster");
      if (outcome.status === CAPABILITY_UNAVAILABLE) {
        setFailed(true);
        return;
      }
      requestOptimizeRun();
      assistantActions.clearRunRequest();
    } finally {
      setOpening(false);
    }
  };

  return (
    <Surface
      level="surface"
      geometry="card"
      className="m-3 flex shrink-0 flex-col gap-3 p-4"
      data-testid="assistant-run-request"
      data-status={stopped ? "stopped" : "live"}
      aria-label="Run the optimiser"
    >
      <h3 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
        Run the optimiser?
      </h3>
      {stopped ? (
        <p className="text-meta text-ink2">
          This request was stopped. Ask the assistant again if you still want a run.
        </p>
      ) : (
        <>
          <p className="text-meta text-ink2">
            This sends the schedule as it is now to the optimiser, exactly as pressing Optimize on
            the Optimise screen does. It changes nothing in your set-up. It uses that screen&apos;s
            settings (up to 5 minutes by default) and downloads an XLSX file when it finishes. Stay
            on that screen while it runs: leaving it stops the run.
          </p>
          {runLive ? (
            <p className="text-meta text-ink2" data-testid="run-request-live">
              A run is already going. Wait for it to finish, or cancel it on the Optimise screen.
            </p>
          ) : null}
          {failed ? (
            <p className="text-meta text-errorink" role="status" data-testid="run-request-failed">
              The Optimise screen could not be opened. Open it yourself and press Optimize.
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center gap-2 border-t border-line2 pt-3">
            <Button
              data-testid="run-request-run"
              disabled={runLive || opening}
              onClick={() => void onRun()}
            >
              {opening ? "Opening…" : "Run optimiser"}
            </Button>
            <Button
              variant="ghost"
              data-testid="run-request-dismiss"
              onClick={() => assistantActions.clearRunRequest()}
            >
              Not now
            </Button>
          </footer>
        </>
      )}
    </Surface>
  );
}
```

- [ ] **Step 4: Mount the card, label the tools, fix the welcome line**

In `web/components/ai/assistant-conversation.tsx`:

Import:

```tsx
import { OptimizeRunRequestCard } from "./optimize-run-request-card";
```

After `<DiagnosticSearchCard />`:

```tsx
      <OptimizeRunRequestCard />
```

Add to `TOOL_ACTIVITY`:

```ts
  request_optimize_run: "Offering an optimiser run…",
  get_optimize_result: "Checking the optimiser run…",
```

In `WelcomeState`, replace `yet, and I never run the optimiser.` with `yet, and I only start the optimiser when you press Run.` (keep "I cannot change anything", because `assistant-panel.test.tsx:236` pins it).

- [ ] **Step 5: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run components/ai/optimize-run-request-card.test.tsx components/ai/assistant-activity.test.tsx components/ai/assistant-panel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/components/ai/optimize-run-request-card.tsx web/components/ai/optimize-run-request-card.test.tsx web/components/ai/assistant-conversation.tsx web/components/ai/assistant-activity.test.tsx
git commit -m "feat(assistant): Run the optimiser confirm card"
```

---

### Task 6: `open_app_screen` cannot pull the user off a live run

**Files:**
- Modify: `web/components/ai/use-help-tools.ts`:
  - imports
  - the start of the `open_app_screen` handler (`:193-212`)
- Test: `web/components/ai/use-help-tools.test.tsx`

**Interfaces:**
- Consumes: `isRunLive` (Task 1), `useHotStore` (`@/lib/store`), `resolveCapability` + `readCapabilityContext` (already imported in this file).
- Produces: `RUN_LIVE_NAVIGATION_REFUSAL: string` (exported for the test).

- [ ] **Step 1: Write the failing test**

In `web/components/ai/use-help-tools.test.tsx`, add the imports:

```tsx
import { useHotStore } from "@/lib/store";
import { INITIAL_OPTIMIZE_RUN_VIEW } from "@/lib/optimize/run-view";
import { RUN_LIVE_NAVIGATION_REFUSAL } from "./use-help-tools";
```

(merge the last one into the existing `./use-help-tools` import). Add `useHotStore.getState().resetRunView();` to `afterEach`. Append:

```tsx
describe("open_app_screen during a live optimiser run", () => {
  beforeEach(() => {
    useHotStore
      .getState()
      .setRunView({ ...INITIAL_OPTIMIZE_RUN_VIEW, lifecycle: "running", jobId: "opt_1" });
  });

  it("refuses to leave the Optimise screen while a run is live", async () => {
    const result = await tool("open_app_screen").handler(
      { capabilityId: "leave-and-requests" },
      {},
    );
    expect(result).toBe(RUN_LIVE_NAVIGATION_REFUSAL);
    expect(push).not.toHaveBeenCalled();
  });

  it("still allows the Optimise screen itself", async () => {
    mountAnchor("optimize.run-options");
    const result = await tool("open_app_screen").handler({ capabilityId: "generate-roster" }, {});
    expect(result).not.toBe(RUN_LIVE_NAVIGATION_REFUSAL);
    expect(push).toHaveBeenCalledWith(expect.stringContaining("optimize"));
  });
});
```

- [ ] **Step 2: Run the test and check that it fails**

Run: `cd web && pnpm vitest run components/ai/use-help-tools.test.tsx -t "live optimiser run"`
Expected: FAIL. The import of `RUN_LIVE_NAVIGATION_REFUSAL` is `undefined`, and `push` was called with the leave-and-requests route.

- [ ] **Step 3: Write the guard**

In `web/components/ai/use-help-tools.ts`, add the imports:

```ts
import { useHotStore } from "@/lib/store";
import { isRunLive } from "@/lib/optimize/run-request";
```

Below `policyParameters`:

```ts
/**
 * Leaving the Optimise screen abandons its run (the visit is the unit), so the model
 * may not cause that. The user can still navigate freely; this binds only the tool.
 */
export const RUN_LIVE_NAVIGATION_REFUSAL =
  "An optimiser run is going on the Optimise screen, and leaving that screen stops it. " +
  "Do not move the user now; tell them where to go once the run has finished.";

function leavesLiveRun(capabilityId: string): boolean {
  if (!isRunLive(useHotStore.getState().runView.lifecycle)) return false;
  const target = resolveCapability(capabilityId, readCapabilityContext());
  return target.status !== "ok" || target.value.routeId !== "optimize-and-export";
}
```

At the very start of the `open_app_screen` handler body (before `const { token } = context;`):

```ts
        if (leavesLiveRun(args.capabilityId)) return RUN_LIVE_NAVIGATION_REFUSAL;
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run components/ai/use-help-tools.test.tsx`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add web/components/ai/use-help-tools.ts web/components/ai/use-help-tools.test.tsx
git commit -m "fix(assistant): open_app_screen will not abandon a live optimiser run"
```

---

### Task 7: Model instruction, help content, manifest, docs, locked roster test

**Files:**
- Modify: `web/lib/ai/assistant/scenario-context.ts:100-107`
- Modify: `web/lib/ai/assistant/scenario-context.test.ts` (the "tells the model to propose…" case)
- Modify: `web/lib/capability/help-content.ts`: `generate-roster` (`:193-205`) and `ai-assistant-conversation` (`:281-292`) summaries
- Regenerate: `web/lib/capability/registry.generated.ts`
- Modify (locked): `web/lib/ai/phase-2-absence.test.ts:115-136`
- Modify: `docs/ai-assistant.md` (table at `:11-18`, product decision at `:32-38`, `:119`)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing assertions**

In `scenario-context.test.ts`, add to the "tells the model to propose supported changes…" case:

```ts
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/request_optimize_run/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/only when the user presses Run/);
    expect(ASSISTANT_AUTHORITY_STATEMENT).toMatch(/get_optimize_result/);
```

In `phase-2-absence.test.ts`, replace the whole `it("can point at roster generation, but has no way to start one", …)` block with:

```ts
  it("can offer a roster run, but only the user can start one", () => {
    // CHANGED DELIBERATELY (2026-09-24, plan assistant-optimize-run). This used to lock
    // "can point at roster generation, but has no way to start one". Solver runs are
    // now a lifted family: request_optimize_run shows a host card, and the run starts
    // only from the user's Run click, through the Optimize screen's own onSubmit.
    //
    // What stays locked: `generate-roster` still carries an EMPTY `supportedCommands`.
    // That field lists SCENARIO writes, and a run writes none -- a non-empty list here
    // would mean a run had started mutating the schedule.
    const entry = CAPABILITY_ENTRIES.find((candidate) => candidate.id === "generate-roster");
    expect(entry, "the generate-roster entry is missing").toBeDefined();
    expect(entry?.routeId).toBe("optimize-and-export");
    expect(entry?.controlAnchor).toBe("optimize.run-options");
    expect(entry?.supportedCommands).toEqual([]);
    expect(entry?.nurseFacingSummary).toMatch(/only when you press Run/);
  });
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `cd web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts lib/ai/phase-2-absence.test.ts`
Expected: FAIL on the new `toMatch` lines.

- [ ] **Step 3: Update the instruction and the help text**

In `ASSISTANT_AUTHORITY_STATEMENT`, insert after the `open_app_screen` line:

```ts
  "You can OFFER an optimiser run with request_optimize_run; it starts only when the user presses Run. Read how it went with get_optimize_result, and never say a run has started or finished unless that tool says so.",
```

In `help-content.ts`, `generate-roster.nurseFacingSummary` becomes:

```ts
      "Send the current setup to the optimiser and, when it finishes, download the result. The " +
      "optimiser only knows the rules that are written down here — it cannot infer ward custom, " +
      "policy or anything outside the recorded rules. The assistant can offer to start a run " +
      "for you; it starts only when you press Run on its card, and then runs exactly as if you " +
      "had pressed Optimize.",
```

In `ai-assistant-conversation.nurseFacingSummary`, after "…which you review and apply yourself." insert:

```ts
      "It can also offer to run the optimiser — the run starts only when you press Run — and " +
      "then tell you how it went. " +
```

(so the next sentence "It cannot change the roster on its own, …" follows unchanged).

- [ ] **Step 4: Regenerate the manifest**

Run: `cd web && pnpm capability:generate`
Expected: `lib/capability/registry.generated.ts` is rewritten with a new `manifestSha256`.

- [ ] **Step 5: Update the docs**

In `docs/ai-assistant.md`:

Add a table row after "Prepare a change for you to review…":

```markdown
| Offer to run the optimiser, then tell you how the run went | Start a run without your Run click |
```

Append to the "Product decision (2026-09-23)" paragraph:

```markdown
**(2026-09-24) Solver runs lifted.** The assistant can offer an Optimize run with a
card; the run starts only when you press Run, and goes through the Optimise screen's
own Optimize path, so it is an ordinary run in every respect (settings, download,
saved roster, Cancel). The assistant then reads the result, and after an infeasible
run it can test candidate fixes on copies.
```

Replace "None of this touches an ordinary Optimize run you started yourself." with:

```markdown
None of this touches an ordinary Optimize run, including one you started from the
assistant's card: Stop ends the answer, not the run. Cancel the run on the Optimise
screen.
```

- [ ] **Step 6: Run the tests and check that they pass**

Run: `cd web && pnpm vitest run lib/ai/assistant/scenario-context.test.ts lib/ai/phase-2-absence.test.ts lib/capability`
Expected: PASS, including `registry.generated.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add web/lib/ai/assistant/scenario-context.ts web/lib/ai/assistant/scenario-context.test.ts web/lib/capability/help-content.ts web/lib/capability/registry.generated.ts web/lib/ai/phase-2-absence.test.ts docs/ai-assistant.md
git commit -m "docs(assistant): assistant can offer an optimiser run the user starts"
```

---

### Task 8: Whole-branch gates

- [ ] **Step 1: Affected suites**

Run: `cd web && pnpm vitest run components/ai lib/ai lib/capability lib/optimize components/optimize`
Expected: PASS. A failure in a sibling plan's area (proposal ops) that also fails on `main` must be reported, not fixed here.

- [ ] **Step 2: Types and lint**

Run: `cd web && pnpm typecheck && pnpm run lint`
Expected: no errors. For a `no-restricted-imports` hit on `components/optimize/optimize-and-export-screen.tsx`, remove the AI import from the screen. The screen must use only `@/lib/optimize`.

- [ ] **Step 3: Commit anything the gates changed (formatting only)**

```bash
cd web && pnpm format && git add -u && git commit -m "chore: format" || true
```

---

## Decisions

1. **Start with a Run card, then the screen's own `onSubmit` (option a)**. A run changes no scenario data. It only makes a candidate roster and a download, so one click is enough friction. The reuse of `onSubmit` makes it a manual run in all ways. That includes the submission basis that `test_feasibility_candidates` needs.
2. **The request goes through a channel in `lib/optimize`, not a call into the controller**. The controller, attempt registry and terminal chain belong to the screen and to one visit. A run exists only while the screen is mounted. Also, oxlint forbids the screen to import assistant code.
3. **The tool does not wait for the run**. `request_optimize_run` returns at once. The click and the run occur after the turn. A turn that stays open for minutes behind a click blocks the input and ties Stop to the run. The model reads the outcome with `get_optimize_result` at the next user question.
4. **The outcome comes from the hot-store run view**. That is the object the screen shows. The summary keeps about 13 fields, plus `terminalHeading` and the "committed" state of the capture gate. There is no list of unmet constraints. `JobResponse` does not carry one, and the solver gives no cause (`CAUSE_UNAVAILABLE`).
5. **`test_feasibility_candidates` works with no code change**. Its parent is the latest ordinary basis for the current revision (`readDiagnosticParent`). An assistant-started run records that basis, because it is the screen's run. Any applied change moves the revision, and then a new run is necessary. The tool already tells the model this.
6. **Export needs no separate tool**. A completed run downloads the XLSX automatically (the auto chain in `useOptimizeTerminal`). The card tells the user this. "Download again" stays a user button on the screen.
7. **Concurrency**. While a run is live, the tool refuses and the card disables Run. The card does not replace a live run. The Optimize button still can, as the user's own choice. A card from a stopped turn has no Run button. A second request replaces the card. Stop, AI disable and Clear do not touch a started run, because it is the user's run.
8. **Read-only tab**. The tool refuses (`readAuthoritativeScenarioOwnership`). The screen preflight refuses again at click time, with its own toast.
9. **The model cannot abandon a run**. During a live run, `open_app_screen` refuses all targets except the Optimise screen (Task 6).
10. **The tool checks Tier-1 readiness only**. The full data check stays on the screen path. Bad data comes back as `submit-rejected`, with the issue list in `error.message`, as on the screen. A second check in the tool builds the YAML twice for a rare case.
11. **The activity labels are "Offering…" and "Checking…"**. Neither tool runs the optimiser, so a label such as "Running the optimiser…" is false.

## Open questions (with recommended answers)

1. **Can the model set the time limit, anonymise or prettify**? Recommendation: no, for now. The card uses the settings of the screen, which keeps the promise "same as the button". Later, add an optional `timeLimitMinutes` argument on user demand. That needs an override in `buildSubmitInput` on the screen.
2. **Does `get_optimize_result` wait up to 30 s for a live run to end**? Recommendation: no. The model tells the user to ask again. Add a bounded wait later for evidence of repeated polling.
3. **Does the card show the scenario stats (nurses, days, shifts, rules on)**? Recommendation: no. The Optimise screen shows them next to its button. Keep the card short.
4. **Is a TTL of 15 s long enough**? Recommendation: yes. The card waits for navigation and the anchor before it sets the request. Thus the TTL covers only the `/api/info` read of the screen. Increase it for slow backend info reads in the field.
5. **The welcome text still says "I cannot change anything yet"**. That text is already out of date. Recommendation: the sibling plan for proposal copy fixes it. This plan changes only the optimiser clause, to prevent a merge conflict.

## Assumptions

- The `serverInfo.status` of the Optimize screen goes from `checking` to `online` or `offline` soon after mount (`optimize-server-info.ts`). The effect waits for that change.
- `readAuthoritativeScenarioOwnership()` returns `{ isOwner, documentRevision } | null`. The screen preflight uses it in that form (`optimize-and-export-screen.tsx:448-462`).
- The assistant can safely call `getRosterCaptureGate().getState(jobId)`. The gate is an app-lifetime singleton (`use-roster-capture.ts:74`).
- A completed infeasible run has `lifecycle: "completed"` and `result.outcome: "infeasible"` (`run-display.ts:165-172`).
- The app shell mounts the assistant panel (`components/shell/app-shell.tsx`). Thus the card stays through the route change to the Optimise screen.

## Follow-ups

- Report unmet soft constraints in `JobResponse` (backend and `summarizeOptimizeRun`). Then the assistant can explain trade-offs in a feasible roster.
- An optional time-limit argument on `request_optimize_run` (open question 1).
- A tool that reads the saved roster on the Roster screen. That is Phase-2 work, and it needs its own change to the locked tests.
- An e2e (Playwright) journey: empty scenario, proposals, Run card, result, then diagnostic.
