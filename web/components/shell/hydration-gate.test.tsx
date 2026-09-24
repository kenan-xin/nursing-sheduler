// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";

// The recoverable-error branch is the shell's rarest rendered state: it needs a
// corrupt IndexedDB record to appear at all, so it is exactly the surface a
// route-wide visual migration can leave behind without anything noticing. The
// R1 re-skin did leave it behind once — at the time the global `h1–h6` rule
// still carried v1's -0.02em, so this heading inherited it while every other R1
// heading moved to the v2 -0.015em. That rule is now -0.015em too, but the
// assertion below stays: it pins the component contract, and this branch is
// rare enough that a future drift would otherwise go unseen.
//
// The bring-up seams are stubbed so the branch can be rendered at all: the real
// `initializeScenarioAuthority` opens the repository and drives the status
// straight to `ready`, which is why this state has never had a render test. The
// stubs are created inside the factory because `vi.mock` is hoisted above every
// top-level binding.
//
// T03: the stubbed names are `initializeScenarioAuthority` and
// `registerScenarioLifecycle` (the gate's current mount effects), plus
// `useOwnershipController` — its heartbeat would otherwise construct the app
// authority singleton purely as a side effect of rendering an error surface.
vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    initializeScenarioAuthority: vi.fn(async () => {}),
    registerScenarioLifecycle: () => () => {},
    useOwnershipController: () => {},
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { HydrationGate } from "./hydration-gate";
import { BRING_UP_STALL_MS, rosterStorage, useHotStore } from "@/lib/store";
import { NEW_SCHEDULE_FAILED_MESSAGE } from "@/lib/roster";
import { OPTIMIZE_RETIRE_PENDING_STORAGE_KEY, OPTIMIZE_SESSION_STORAGE_KEY } from "@/lib/optimize";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import type { RosterDocument } from "@/lib/roster";

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

beforeEach(async () => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("HydrationGate — recoverable-error state", () => {
  function renderRecoverable() {
    useHotStore.setState({ hydrationStatus: "recoverable-error" });
    render(
      <HydrationGate>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
  }

  it("renders the recovery surface instead of the gated children", async () => {
    renderRecoverable();
    // Guards the guard: if this branch stopped rendering, every typography
    // assertion below would vanish with it rather than fail.
    expect(screen.getByTestId("hydration-error")).toBeTruthy();
    expect(screen.queryByTestId("gated-children")).toBeNull();
    expect(screen.getByRole("button", { name: /reset to new schedule/i })).toBeTruthy();
  });

  it("tracks its heading at the v2 -0.015em, not a Tailwind default", async () => {
    renderRecoverable();
    const heading = screen.getByTestId("hydration-error-heading");

    expect(heading.tagName).toBe("H2");
    // States the v2 value as a component contract; the global h1–h6 safety net
    // resolves to the same -0.015em.
    // `tracking-tight` is a different value again (-0.025em) and is not it.
    expect(classesOf(heading)).toContain("tracking-[-0.015em]");
    expect(classesOf(heading)).not.toContain("tracking-tight");
  });

  it("leaves the loading state's own markup alone", async () => {
    // The sibling branch has no heading, so the fix must not have grown one.
    useHotStore.setState({ hydrationStatus: "hydrating" });
    render(
      <HydrationGate>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
    expect(screen.getByTestId("hydration-loading")).toBeTruthy();
    expect(screen.queryByTestId("hydration-error-heading")).toBeNull();
    expect(screen.queryByTestId("gated-children")).toBeNull();
  });
});

describe("HydrationGate — stalled restore (dna)", () => {
  it("offers a reload, never the destructive reset, and hides the app", () => {
    useHotStore.setState({ hydrationStatus: "stalled" });
    render(
      <HydrationGate>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
    expect(screen.getByTestId("hydration-stalled")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reset/i })).toBeNull();
    expect(screen.queryByTestId("gated-children")).toBeNull();
  });
});

// u2o: live, the first load after a deploy sat at RESTORING for 15s+ and the dna Reload
// surface never came. That surface is armed by the gate's mount EFFECT, so it cannot
// exist until the client has hydrated -- and the server-rendered page (hot store
// `unhydrated`) is exactly the skeleton the user was left looking at. The stall
// affordance must therefore already be in the server markup, revealed by time alone.
describe("HydrationGate — stall surface before hydration (u2o)", () => {
  it("server-renders a time-revealed Reload that needs no JavaScript", () => {
    useHotStore.setState({ hydrationStatus: "unhydrated" });
    document.body.innerHTML = renderToString(
      <HydrationGate>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
    const slow = document.querySelector<HTMLElement>('[data-testid="hydration-slow"]');
    expect(slow, "the server markup has no stall surface").not.toBeNull();
    // Hidden until the same deadline the post-hydration timer uses, then revealed by CSS.
    expect(slow!.className).toContain("invisible");
    expect(slow!.style.animation).toContain("ns-reveal");
    expect(slow!.style.animation).toContain(`${BRING_UP_STALL_MS}ms`);
    // A plain link: it reloads whether or not React ever attached a handler.
    const reload = slow!.querySelector("a");
    expect(reload?.textContent).toMatch(/reload/i);
    expect(reload?.getAttribute("href")).toBe("");
    expect(slow!.textContent).not.toMatch(/reset/i);
  });
});

// ---------------------------------------------------------------------------
// G4.1 — the corrupt-storage recovery reset is the SAME reset as Save & Load.
//
// It used to call the scenario-only `resetToNewScenario` and toast success
// unconditionally, so a user recovering from a corrupt scenario record kept the
// previous run's working roster, candidate, snapshot, capture state and session
// residue — all real-identity data — inside what they were told was a new schedule.
// A corrupt scenario is not an exception to that contract.
//
// The success case drives the PRODUCTION authority (nothing injected) against the
// real `rosterStorage` singleton and real session/local storage, so the absence
// assertions are read back from storage rather than inferred.
// ---------------------------------------------------------------------------

describe("HydrationGate — the corrupt-storage reset", () => {
  const JOB = "opt_hydration_residue";
  const OWNER = "owner_hydration_residue";

  /** Everything the previous run leaves behind, on the surfaces Clear must reach. */
  async function seedPreviousRun() {
    const document = await fixtureRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const committed = await rosterStorage.commitCandidate<RosterDocument>({
      jobId: JOB,
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    if (committed.status !== "committed") throw new Error(`seed failed: ${committed.status}`);
    const allocated = await rosterStorage.allocateSubmissionSnapshot({
      ownerId: OWNER,
      payload: { canonicalYaml: "people: [Alice Ng]" },
      expectedClearEpoch: epoch,
    });
    if (allocated.status !== "allocated") throw new Error(`seed failed: ${allocated.status}`);
    window.sessionStorage.setItem(OPTIMIZE_SESSION_STORAGE_KEY, '{"reverseMap":[["P1","Real"]]}');
    window.sessionStorage.setItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY, OWNER);
  }

  function renderRecoverable(props: Partial<Parameters<typeof HydrationGate>[0]> = {}) {
    useHotStore.setState({ hydrationStatus: "recoverable-error" });
    render(
      <HydrationGate {...props}>
        <div data-testid="gated-children" />
      </HydrationGate>,
    );
  }

  async function confirmReset() {
    fireEvent.click(screen.getByRole("button", { name: /reset to new schedule/i }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
  }

  beforeEach(async () => {
    await rosterStorage.clearRosterData();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("clears the previous run's roster and session residue, then completes hydration", async () => {
    await seedPreviousRun();
    // ACCEPTING PRE-STATE — the absences below cannot pass against an empty store.
    expect(await rosterStorage.readWorking<RosterDocument>()).not.toBeNull();
    expect(await rosterStorage.readCandidate<RosterDocument>(JOB)).not.toBeNull();
    expect(await rosterStorage.readSubmissionSnapshot(OWNER)).not.toBeNull();

    renderRecoverable();
    await confirmReset();

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("New schedule created"));
    // Exactly one success message, and no failure alongside it.
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();

    // The state a stale Optimize capture notice is a projection of is gone.
    expect(await rosterStorage.readWorking<RosterDocument>()).toBeNull();
    expect(await rosterStorage.readCandidate<RosterDocument>(JOB)).toBeNull();
    expect(await rosterStorage.readCurrentCandidate()).toBeNull();
    expect(await rosterStorage.readSubmissionSnapshot(OWNER)).toBeNull();
    expect(window.sessionStorage.getItem(OPTIMIZE_SESSION_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY)).toBeNull();

    // Hydration completed into the empty workspace: the gate stops gating.
    await waitFor(() => expect(screen.getByTestId("gated-children")).toBeTruthy());
    expect(screen.queryByTestId("hydration-error")).toBeNull();
  });

  it("claims nothing when the cleanup cannot be verified, and stays retryable", async () => {
    const resetNewSchedule = vi.fn(async () => ({
      status: "failed" as const,
      failure: "stored-data" as const,
      storedData: null,
    }));
    renderRecoverable({ resetNewSchedule });
    await confirmReset();

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NEW_SCHEDULE_FAILED_MESSAGE));
    expect(toast.success).not.toHaveBeenCalled();
    // Being blocked here is honest; claiming a fresh schedule over surviving
    // real-identity roster data is not. The recovery surface — and therefore the
    // retry — is still on screen.
    expect(screen.getByTestId("hydration-error")).toBeTruthy();
    expect(screen.getByRole("button", { name: /reset to new schedule/i })).toBeTruthy();
    expect(screen.queryByTestId("gated-children")).toBeNull();
  });

  it("cancelling runs no cleanup and no scenario reset", async () => {
    const resetNewSchedule = vi.fn();
    renderRecoverable({ resetNewSchedule });

    fireEvent.click(screen.getByRole("button", { name: /reset to new schedule/i }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-cancel"));

    expect(resetNewSchedule).not.toHaveBeenCalled();
    const { toast } = await import("sonner");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId("hydration-error")).toBeTruthy();
  });
});
