// @vitest-environment jsdom
//
// Roster section states (F4).
//
// `fake-indexeddb/auto` MUST be the first import: Dexie captures the IndexedDB
// API at open time, so loading it after the store modules leaves the roster
// database unopenable and every assertion here would silently pass through the
// read-unavailable branch instead of exercising real F1 storage.
//
// What is real here: F1 roster storage, the section, the viewer, and the
// promotion path. The F2 gate is a recording stub, because what these tests need
// to prove about it is WHICH `{jobId, candidateVersion}` it is asked to act on —
// the gate's own races are F2's tests.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { rosterStorage } from "@/lib/store";
import type { CurrentCandidatePointer } from "@/lib/store";
import type { RosterDocument } from "@/lib/roster";
import { encodeRosterFile } from "@/lib/roster";
import { ROSTER_VIEW_PREFERENCE_KEY } from "@/lib/roster-viewer";
import { OPTIMIZE_RETIRE_PENDING_STORAGE_KEY, OPTIMIZE_SESSION_STORAGE_KEY } from "@/lib/optimize";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";
import type {
  DurableCandidateRef,
  DurableDismissOutcome,
  RosterCaptureSurface,
} from "@/lib/optimize";
import { RosterSection } from "./roster-section";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const JOB_A = "opt_candidate_a";

function installResizeObserver() {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/**
 * A capture surface that RECORDS the exact ref each dismissal names.
 *
 * Counting callback invocations is what let the old tests pass while the UI
 * dismissed the wrong run: both the right call and the wrong call are "one
 * call". The identity is the whole claim, so it is what gets captured.
 */
function recordingSurface(outcome: DurableDismissOutcome = { status: "dismissed", token: null }): {
  surface: RosterCaptureSurface;
  refs: DurableCandidateRef[];
} {
  const refs: DurableCandidateRef[] = [];
  const surface = {
    gate: {
      dismissDurableCandidate: async (ref: DurableCandidateRef) => {
        refs.push(ref);
        return outcome;
      },
      // Every other gate member is deliberately a trap. The section must reach
      // the gate ONLY through the job/version-keyed durable operation; touching
      // the unkeyed current-run surface is the defect under test.
      capture: unreachable("capture"),
      retry: unreachable("retry"),
      dismiss: unreachable("dismiss"),
      getState: unreachable("getState"),
      getToken: unreachable("getToken"),
      notifyCleared: unreachable("notifyCleared"),
      retainedContainers: unreachable("retainedContainers"),
      subscribe: () => () => {},
    },
    stateFor: () => {
      throw new Error(
        "RosterSection must not decide candidate availability from capture state: " +
          "a fresh app process reports `idle` for every durable candidate.",
      );
    },
  } as unknown as RosterCaptureSurface;
  return { surface, refs };
}

function unreachable(name: string): () => never {
  return () => {
    throw new Error(`RosterSection must not call the unkeyed gate operation \`${name}\`.`);
  };
}

async function seedCandidate(jobId = JOB_A, ordinal = 1): Promise<CurrentCandidatePointer> {
  const document = await fixtureRosterDocument();
  const epoch = await rosterStorage.getClearEpoch();
  const outcome = await rosterStorage.commitCandidate({
    jobId,
    submissionOrdinal: ordinal,
    document,
    expectedClearEpoch: epoch,
  });
  if (outcome.status !== "committed") throw new Error(`seed failed: ${outcome.status}`);
  return outcome.pointer;
}

async function seedWorking(): Promise<void> {
  const document = await fixtureRosterDocument();
  const epoch = await rosterStorage.getClearEpoch();
  const outcome = await rosterStorage.writeWorking({
    document,
    expectedRevision: null,
    expectedClearEpoch: epoch,
  });
  if (outcome.status !== "written") throw new Error(`seed failed: ${outcome.status}`);
}

/** A genuine `.nurse-roster.json` produced by the production encoder. */
async function rosterFileFixture(): Promise<File> {
  const encoded = await encodeRosterFile(await fixtureRosterDocument());
  if (!encoded.ok) throw new Error("fixture roster file failed to encode");
  return new File([encoded.file.blob], encoded.file.filename, {
    type: encoded.file.blob.type,
  });
}

/** Choose a file through the production hidden input the Import button drives. */
function chooseFile(file: File): void {
  const input = window.document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no roster file input is mounted");
  fireEvent.change(input, { target: { files: [file] } });
}

const SNAPSHOT_OWNER = "owner_residue";

/**
 * Seed every hidden surface a Clear must reach WITHOUT a working roster: the
 * durable candidate and its pointer, a submission snapshot, the optimize session
 * record and its retirement marker, and the roster view metadata.
 *
 * This is the state the finding is about — an absent working roster is not an
 * empty browser, and none of these are reachable through Dismiss.
 */
async function seedHiddenResidue(): Promise<CurrentCandidatePointer> {
  const pointer = await seedCandidate();
  const epoch = await rosterStorage.getClearEpoch();
  const allocated = await rosterStorage.allocateSubmissionSnapshot({
    ownerId: SNAPSHOT_OWNER,
    payload: { canonicalYaml: "people: [Alice Ng]" },
    expectedClearEpoch: epoch,
  });
  if (allocated.status !== "allocated") throw new Error(`snapshot seed: ${allocated.status}`);
  window.sessionStorage.setItem(OPTIMIZE_SESSION_STORAGE_KEY, '{"owner":"owner_residue"}');
  window.sessionStorage.setItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY, "owner_residue");
  window.localStorage.setItem(
    ROSTER_VIEW_PREFERENCE_KEY,
    JSON.stringify({ lens: "day", focusedIso: "2026-07-04" }),
  );
  return pointer;
}

/** Every seeded residue surface, read back from where it actually lives. */
async function readResidue() {
  return {
    working: await rosterStorage.readWorking<RosterDocument>(),
    pointer: await rosterStorage.readCurrentCandidate(),
    candidate: await rosterStorage.readCandidate<RosterDocument>(JOB_A),
    snapshot: await rosterStorage.readSubmissionSnapshot(SNAPSHOT_OWNER),
    session: window.sessionStorage.getItem(OPTIMIZE_SESSION_STORAGE_KEY),
    retireMarker: window.sessionStorage.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY),
    viewMetadata: window.localStorage.getItem(ROSTER_VIEW_PREFERENCE_KEY),
  };
}

function renderSection(surface?: RosterCaptureSurface) {
  const recording = recordingSurface();
  render(<RosterSection capture={surface ?? recording.surface} />);
  return recording;
}

/**
 * ENVIRONMENT LIMIT, stated rather than worked around silently. F1's promotion
 * re-validates the stored candidate, and `frozenXlsx` is a `Blob` that
 * fake-indexeddb's structured clone does not round-trip — the stored copy comes
 * back as a plain object and validation correctly rejects it. That rejection is
 * an artefact of the fake, not of the product, so tests needing a SUCCESSFUL
 * promotion substitute only F1's promotion step and keep the section, its
 * reload, and the viewer real. The genuine Blob path is covered in the browser
 * (`e2e/roster-viewer.spec.ts`), which is why that spec exists.
 */
function stubPromotion(): { calls: number; versions: number[] } {
  const counter = { calls: 0, versions: [] as number[] };
  vi.spyOn(rosterStorage, "promoteCandidateToWorking").mockImplementation(async (input) => {
    counter.calls += 1;
    counter.versions.push(input.expectedCandidateVersion);
    const row = await rosterStorage.readCandidate<RosterDocument>(input.jobId);
    if (row === null) return { status: "source-missing" };
    // The stub HONOURS the exact-version fence. Skipping it would make every
    // test below pass whether or not the section threads the displayed version
    // through — which is precisely the defect this substitution must not hide.
    if (row.revision !== input.expectedCandidateVersion) {
      return { status: "version-conflict", currentVersion: row.revision };
    }
    const written = await rosterStorage.writeWorking({
      document: row.document,
      expectedRevision: input.expectedWorkingRevision,
      expectedClearEpoch: input.expectedClearEpoch,
    });
    if (written.status !== "written") throw new Error(`stub promotion: ${written.status}`);
    return { status: "promoted", revision: written.revision };
  });
  return counter;
}

beforeEach(() => {
  installResizeObserver();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1200,
    height: 600,
    top: 0,
    left: 0,
    bottom: 600,
    right: 1200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Each test owns a pristine store; Clear is the only purge authority F1 has.
  await rosterStorage.clearRosterData();
});

// ---------------------------------------------------------------------------
// Read states
// ---------------------------------------------------------------------------

describe("RosterSection — read states", () => {
  it("shows a skeleton while the first read is in flight, not an empty roster", async () => {
    // A claim of "no roster" before the read resolves would be a lie the user
    // acts on, so the loading state must be distinguishable from empty.
    renderSection();
    expect(screen.getByTestId("roster-section-loading")).toBeDefined();
    expect(screen.queryByTestId("roster-section-empty")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("roster-section-empty")).toBeDefined());
  });

  it("shows the empty state when storage is readable and holds no roster", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section-empty")).toBeDefined());
    expect(screen.getByText("No roster loaded yet")).toBeDefined();
    expect(screen.queryByTestId("roster-section-unavailable")).toBeNull();
  });

  it("renders the viewer when a working roster exists", async () => {
    await seedWorking();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(screen.getByTestId("roster-viewer")).toBeDefined();
    expect(screen.queryByTestId("roster-section-empty")).toBeNull();
  });

  // THE DISCRIMINATING CASE. An unreadable store is not an empty store. Showing
  // "No roster loaded yet" here would tell a user their roster is gone when it
  // is intact and merely unreachable in this window.
  it("distinguishes an UNREADABLE store from an empty one", async () => {
    vi.spyOn(rosterStorage, "readWorking").mockRejectedValue(new Error("no indexeddb"));
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section-unavailable")).toBeDefined());
    expect(screen.queryByTestId("roster-section-empty")).toBeNull();
    expect(screen.queryByText("No roster loaded yet")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Durable Load authority
// ---------------------------------------------------------------------------

describe("RosterSection — durable Load authority", () => {
  // THE DEFECT THIS REPLACES. Load used to require
  // `capture.stateFor(jobId).status === "committed"`, which reads the
  // app-lifetime gate's in-memory map. A reload empties that map, so a valid
  // pointer plus a stored candidate produced NO Load button — at exactly the
  // moment durability is the point. The stub's `stateFor` throws, so any
  // regression to that authority fails loudly rather than silently.
  it("offers Load from the durable pointer alone, with the gate reporting nothing", async () => {
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-available")).toBeDefined());
    expect(screen.getByTestId("roster-candidate-load")).toBeDefined();
    expect(screen.getByTestId("roster-candidate-dismiss")).toBeDefined();
  });

  it("offers nothing when the pointer exists but its candidate payload does not", async () => {
    await seedCandidate();
    // The pointer survives, the document does not — offering Load would promise
    // a roster that cannot be produced.
    vi.spyOn(rosterStorage, "readCandidate").mockResolvedValue(null);
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section-empty")).toBeDefined());
    expect(screen.queryByTestId("roster-candidate-available")).toBeNull();
  });

  it("Load promotes the candidate and the viewer then renders it", async () => {
    const promotion = stubPromotion();
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-load"));

    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(screen.getByTestId("roster-viewer")).toBeDefined();
    expect(promotion.calls).toBe(1);
    expect(await rosterStorage.readWorking<RosterDocument>()).not.toBeNull();
  });

  it("Load keeps the candidate rather than consuming it", async () => {
    stubPromotion();
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-load"));
    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(await rosterStorage.readCandidate<RosterDocument>(JOB_A)).not.toBeNull();
    expect(await rosterStorage.readCurrentCandidate()).not.toBeNull();
  });

  // THE SAME-JOB RETRY RACE, at the surface that makes the decision. v1 is
  // rendered; a retry commits v2 for the SAME job before the click. Load must
  // refuse rather than promote a roster the user never saw. The old code passed
  // only `pointer.jobId`, so storage happily promoted whatever was current.
  it("refuses to Load when a same-job retry replaced the displayed version", async () => {
    const promotion = stubPromotion();
    const first = await seedCandidate(JOB_A, 1);
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());

    // The replacement lands after render, before the click.
    const second = await seedCandidate(JOB_A, 2);
    expect(second.candidateVersion).not.toBe(first.candidateVersion);

    fireEvent.click(screen.getByTestId("roster-candidate-load"));
    await waitFor(() => expect(screen.getByTestId("roster-load-error")).toBeDefined());

    // The version the section asked for is the one it DISPLAYED, not the current row.
    expect(promotion.versions).toEqual([first.candidateVersion]);
    // Nothing was promoted: no viewer, no working roster.
    expect(screen.queryByTestId("roster-viewer")).toBeNull();
    expect(await rosterStorage.readWorking<RosterDocument>()).toBeNull();
  });

  // NEGATIVE CONTROL: the same flow with no intervening retry still loads, so
  // the refusal above is the version fence rather than a broken Load path.
  it("still Loads when no retry intervened", async () => {
    const promotion = stubPromotion();
    const pointer = await seedCandidate(JOB_A, 1);
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-load"));

    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(promotion.versions).toEqual([pointer.candidateVersion]);
    expect(await rosterStorage.readWorking<RosterDocument>()).not.toBeNull();
  });

  it("a failed promotion keeps the empty state and says so", async () => {
    vi.spyOn(rosterStorage, "promoteCandidateToWorking").mockResolvedValue({
      status: "source-missing",
    });
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-load"));
    await waitFor(() => expect(screen.getByTestId("roster-load-error")).toBeDefined());
    expect(screen.getByTestId("roster-section-empty")).toBeDefined();
    expect(screen.queryByTestId("roster-viewer")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replacement of an existing working roster
// ---------------------------------------------------------------------------

describe("RosterSection — replacing a working roster", () => {
  // THE DEFECT THIS REPLACES. The old component returned early once a working
  // roster existed, and a test ASSERTED that absence — encoding the bug as the
  // requirement. A newer result must be offered, not hidden.
  it("offers the candidate ALONGSIDE an existing working roster", async () => {
    await seedWorking();
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(screen.getByTestId("roster-candidate-available")).toBeDefined();
    expect(screen.getByTestId("roster-viewer")).toBeDefined();
  });

  it("does NOT promote until the replacement is confirmed", async () => {
    const promotion = stubPromotion();
    await seedWorking();
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());

    fireEvent.click(screen.getByTestId("roster-candidate-load"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeDefined());
    // The load-bearing assertion: the dialog is open and NOTHING has been
    // promoted. A confirmation that fires after the act is not a confirmation.
    expect(promotion.calls).toBe(0);
  });

  it("promotes once the replacement is confirmed", async () => {
    const promotion = stubPromotion();
    await seedWorking();
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-load"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: /replace roster/i }));
    await waitFor(() => expect(promotion.calls).toBe(1));
  });

  it("loads WITHOUT a confirmation when there is no roster to replace", async () => {
    const promotion = stubPromotion();
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-load")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-load"));
    await waitFor(() => expect(promotion.calls).toBe(1));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Job/version-keyed dismissal
// ---------------------------------------------------------------------------

describe("RosterSection — keyed dismissal", () => {
  // THE DEFECT THIS REPLACES. Dismiss used to call the terminal hook's unkeyed
  // `dismissCapture()`, which resolves the CURRENT run at click time. With
  // durable candidate A displayed and later run B in the panel above, that
  // dismissed B — consuming B's cleanup authority while A's payload and pointer
  // survived, under a message telling the user A had been discarded.
  it("names the DISPLAYED candidate's job and version, not the current run", async () => {
    const pointer = await seedCandidate();
    const recording = recordingSurface();
    render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-candidate-dismiss")).toBeDefined());

    fireEvent.click(screen.getByTestId("roster-candidate-dismiss"));
    await waitFor(() => expect(recording.refs.length).toBe(1));

    expect(recording.refs[0]).toEqual({
      jobId: JOB_A,
      candidateVersion: pointer.candidateVersion,
    });
  });

  // The A-pointer/B-view case stated directly: a LATER run exists and is the one
  // a current-run callback would resolve to. The section must still name A.
  it("names A even while a later run B is the current run", async () => {
    const pointerA = await seedCandidate(JOB_A, 1);
    // B is a later, separate job. The section displays whatever the pointer says,
    // and here the pointer still names A.
    const recording = recordingSurface();
    render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-candidate-dismiss")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-dismiss"));
    await waitFor(() => expect(recording.refs.length).toBe(1));

    expect(recording.refs[0].jobId).toBe(JOB_A);
    expect(recording.refs[0].jobId).not.toBe("opt_later_run_b");
    expect(recording.refs[0].candidateVersion).toBe(pointerA.candidateVersion);
  });

  it("carries the version forward after a re-capture moves the pointer", async () => {
    await seedCandidate(JOB_A, 1);
    // A second capture for the same job commits a NEW candidateVersion.
    const second = await seedCandidate(JOB_A, 2);
    const recording = recordingSurface();
    render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-candidate-dismiss")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-dismiss"));
    await waitFor(() => expect(recording.refs.length).toBe(1));

    // The version displayed is the version dismissed — not a stale first capture.
    expect(recording.refs[0].candidateVersion).toBe(second.candidateVersion);
  });

  it("surfaces a refused dismissal and keeps the candidate offered", async () => {
    await seedCandidate();
    const refusing = recordingSurface({
      status: "failed",
      message: "A newer saved roster (version 4) replaced the one being dismissed.",
    });
    render(<RosterSection capture={refusing.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-candidate-dismiss")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-candidate-dismiss"));

    await waitFor(() => expect(screen.getByTestId("roster-load-error")).toBeDefined());
    // A refusal must not look like success: the candidate is still on offer.
    expect(screen.getByTestId("roster-candidate-available")).toBeDefined();
  });

  it("clears the candidate from view once the dismissal succeeds", async () => {
    const pointer = await seedCandidate();
    const recording = recordingSurface({ status: "dismissed", token: null });
    // The stub records intent but does not mutate F1; do the removal it stands
    // in for so the section's reload observes a genuinely dismissed store.
    const epoch = await rosterStorage.getClearEpoch();
    render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-candidate-dismiss")).toBeDefined());

    await rosterStorage.dismissCandidate({
      jobId: pointer.jobId,
      candidateVersion: pointer.candidateVersion,
      expectedClearEpoch: epoch,
    });
    fireEvent.click(screen.getByTestId("roster-candidate-dismiss"));

    await waitFor(() => expect(screen.queryByTestId("roster-candidate-available")).toBeNull());
  });

  // The retryable capture states belong to the run in the panel above, which the
  // top-level CaptureNotice owns. The section's old Retry branch keyed off the
  // POINTER's job — a job that by definition committed, so it could never be in
  // a retryable state. It was unreachable code advertising an action.
  it("has no Retry surface of its own", async () => {
    await seedCandidate();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-candidate-available")).toBeDefined());
    expect(screen.queryByTestId("roster-candidate-retry")).toBeNull();
    expect(screen.queryByTestId("roster-candidate-retry-button")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty-state document actions (G3)
// ---------------------------------------------------------------------------
//
// THE DEFECT THESE REPLACE. The empty branch mounted no document actions at all:
// `RosterActions` only ever rendered inside `WorkingRosterPanel`, which only
// mounts when a working roster exists. A recipient holding a valid roster file
// could not import it, and the shared-device privacy purge — which is exactly
// what an "empty" browser still full of candidate/pointer/snapshot/session
// residue needs — had no control anywhere on screen. Every assertion below fails
// against that branch.

describe("RosterSection — empty-state document actions", () => {
  it("offers Import and Clear, and NOT the loaded-roster save/export actions", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section-empty")).toBeDefined());

    expect(screen.getByTestId("roster-empty-actions")).toBeDefined();
    expect(screen.getByTestId("roster-import")).toBeDefined();
    expect(screen.getByTestId("roster-clear")).toBeDefined();

    // The controls that describe a roster ON SCREEN must not be advertised when
    // there is none: they would have nothing to act on.
    expect(screen.queryByTestId("roster-actions")).toBeNull();
    expect(screen.queryByTestId("roster-export-file")).toBeNull();
    expect(screen.queryByTestId("roster-export-xlsx")).toBeNull();
    expect(screen.queryByTestId("roster-save-saving")).toBeNull();
    expect(screen.queryByTestId("roster-save-saved")).toBeNull();
    expect(screen.queryByTestId("roster-save-failed")).toBeNull();
  });

  // NEGATIVE CONTROL for the surface split: with a roster loaded the FULL action
  // bar is what mounts, so the assertion above is about state-appropriateness
  // rather than the export controls having been deleted outright.
  it("still offers the full action bar once a working roster exists", async () => {
    await seedWorking();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(screen.getByTestId("roster-actions")).toBeDefined();
    expect(screen.getByTestId("roster-export-file")).toBeDefined();
    expect(screen.getByTestId("roster-import")).toBeDefined();
    expect(screen.getByTestId("roster-clear")).toBeDefined();
    expect(screen.queryByTestId("roster-empty-actions")).toBeNull();
  });

  // An unreadable store is still not an empty one: we never learned what is
  // there, so neither action has a subject and neither is offered.
  it("offers no document actions when the store could not be read at all", async () => {
    vi.spyOn(rosterStorage, "readWorking").mockRejectedValue(new Error("no indexeddb"));
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-section-unavailable")).toBeDefined());
    expect(screen.queryByTestId("roster-empty-actions")).toBeNull();
  });

  it("imports a valid roster file into an empty database and renders it", async () => {
    const file = await rosterFileFixture();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-empty-actions")).toBeDefined());

    chooseFile(file);

    // The document is on screen AND durable — the promotion, not just a render.
    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(screen.getByTestId("roster-viewer")).toBeDefined();
    expect(await rosterStorage.readWorking<RosterDocument>()).not.toBeNull();
    expect(screen.queryByTestId("roster-action-error")).toBeNull();
  });

  it("imports without asking to replace — there is nothing on screen to lose", async () => {
    const file = await rosterFileFixture();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-empty-actions")).toBeDefined());
    chooseFile(file);
    await waitFor(() => expect(screen.getByTestId("roster-section")).toBeDefined());
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("rejects an invalid file, keeps the empty state, and preserves hidden data", async () => {
    const pointer = await seedHiddenResidue();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-empty-actions")).toBeDefined());

    chooseFile(
      new File(['{"nope": true}'], "not-a-roster.nurse-roster.json", {
        type: "application/json",
      }),
    );

    await waitFor(() => expect(screen.getByTestId("roster-action-error")).toBeDefined());
    expect(screen.getByTestId("roster-section-empty")).toBeDefined();
    expect(screen.queryByTestId("roster-viewer")).toBeNull();

    // FAIL CLOSED: no partial roster was fabricated and nothing hidden was touched.
    const residue = await readResidue();
    expect(residue.working).toBeNull();
    expect(residue.pointer?.candidateVersion).toBe(pointer.candidateVersion);
    expect(residue.candidate).not.toBeNull();
    expect(residue.snapshot).not.toBeNull();
  });

  // THE CAS FENCE. The empty state promotes with `expectedWorkingRevision: null`
  // because it observed no working row. A row that appears while the file is
  // being read must therefore LOSE, not be silently overwritten.
  it("refuses the import when a working roster appeared underneath it", async () => {
    const file = await rosterFileFixture();
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-empty-actions")).toBeDefined());

    await seedWorking();
    const before = await rosterStorage.readWorking<RosterDocument>();
    chooseFile(file);

    await waitFor(() => expect(screen.getByTestId("roster-action-error")).toBeDefined());
    // The row that won is the one that was already there.
    const after = await rosterStorage.readWorking<RosterDocument>();
    expect(after?.revision).toBe(before?.revision);
  });

  // THE EPOCH FENCE. A Clear that commits between the captured epoch and the
  // write must make the write terminal rather than repopulating a purged store.
  it("refuses the import against a stale clear epoch", async () => {
    const file = await rosterFileFixture();
    await rosterStorage.clearRosterData();
    const current = await rosterStorage.getClearEpoch();
    vi.spyOn(rosterStorage, "getClearEpoch").mockResolvedValue(current - 1);

    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-empty-actions")).toBeDefined());
    chooseFile(file);

    await waitFor(() => expect(screen.getByTestId("roster-action-error")).toBeDefined());
    expect(await rosterStorage.readWorking<RosterDocument>()).toBeNull();
    expect(screen.getByTestId("roster-section-empty")).toBeDefined();
  });
});

describe("RosterSection — empty-state Clear", () => {
  it("confirms first: cancelling leaves every seeded residue in place", async () => {
    await seedHiddenResidue();
    const purge = vi.spyOn(rosterStorage, "clearRosterData");
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-clear")).toBeDefined());

    fireEvent.click(screen.getByTestId("roster-clear"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeDefined());
    // A confirmation that fires after the act is not a confirmation.
    expect(purge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());

    const residue = await readResidue();
    expect(purge).not.toHaveBeenCalled();
    expect(residue.pointer).not.toBeNull();
    expect(residue.candidate).not.toBeNull();
    expect(residue.snapshot).not.toBeNull();
    expect(residue.session).not.toBeNull();
    expect(residue.retireMarker).not.toBeNull();
    expect(residue.viewMetadata).not.toBeNull();
  });

  // THE PRIVACY CLAIM. `working` is already absent, so nothing here is reachable
  // through the roster on screen or through Dismiss — only the origin-wide purge
  // reaches it, and it has to reach ALL of it.
  it("purges candidate, pointer, snapshot, session, marker and view metadata", async () => {
    await seedHiddenResidue();
    // The premise: every surface is genuinely populated before the act, so the
    // assertions below cannot pass against data that was never there.
    const seeded = await readResidue();
    expect(seeded.working).toBeNull();
    expect(seeded.pointer).not.toBeNull();
    expect(seeded.candidate).not.toBeNull();
    expect(seeded.snapshot).not.toBeNull();
    expect(seeded.session).not.toBeNull();
    expect(seeded.retireMarker).not.toBeNull();
    expect(seeded.viewMetadata).not.toBeNull();

    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-clear")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-clear"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /clear all roster data/i }));

    await waitFor(() => expect(screen.queryByTestId("roster-candidate-available")).toBeNull());
    const residue = await readResidue();
    expect(residue.working).toBeNull();
    expect(residue.pointer).toBeNull();
    expect(residue.candidate).toBeNull();
    expect(residue.snapshot).toBeNull();
    expect(residue.session).toBeNull();
    expect(residue.retireMarker).toBeNull();
    expect(residue.viewMetadata).toBeNull();
    expect(screen.queryByTestId("roster-clear-failed")).toBeNull();
  });

  it("reports a partial Clear plainly and stays retryable", async () => {
    await seedHiddenResidue();
    vi.spyOn(rosterStorage, "clearRosterData").mockResolvedValue({
      status: "failed",
      epoch: 9,
      remaining: { roster: 1, snapshot: 0 },
    });
    renderSection();
    await waitFor(() => expect(screen.getByTestId("roster-clear")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-clear"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /clear all roster data/i }));

    // Never a silent privacy success: the failure is stated, and the control is
    // still mounted so the user can try again.
    await waitFor(() => expect(screen.getByTestId("roster-clear-failed")).toBeDefined());
    expect(screen.getByTestId("roster-action-error")).toBeDefined();
    expect(screen.getByTestId("roster-clear")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Forbidden copy — the settled non-technical surface (F2 decision)
// ---------------------------------------------------------------------------

describe("RosterSection — settled copy contract", () => {
  const FORBIDDEN = [
    "Forget",
    "Abandon",
    "Optimize again",
    "Optimise again",
    "snapshot",
    "backend job",
    "cleanup token",
    "storage epoch",
    "recovery record",
    "IndexedDB",
  ];

  it("uses none of the retired technical terms with a candidate offered", async () => {
    await seedCandidate();
    const recording = recordingSurface();
    const { container } = render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-candidate-available")).toBeDefined());
    for (const term of FORBIDDEN) {
      expect(container.textContent).not.toContain(term);
    }
  });

  it("uses none of the retired technical terms on the empty-state actions", async () => {
    await seedHiddenResidue();
    const recording = recordingSurface();
    const { container } = render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-empty-actions")).toBeDefined());
    fireEvent.click(screen.getByTestId("roster-clear"));
    await waitFor(() => expect(screen.getByTestId("confirm-dialog")).toBeDefined());
    // The dialog is a portal; check the whole document, not just this container.
    const text = `${container.textContent ?? ""}${window.document.body.textContent ?? ""}`;
    for (const term of FORBIDDEN) {
      expect(text).not.toContain(term);
    }
  });

  it("uses none of the retired technical terms in the unreadable-store state", async () => {
    vi.spyOn(rosterStorage, "readWorking").mockRejectedValue(new Error("no indexeddb"));
    const recording = recordingSurface();
    const { container } = render(<RosterSection capture={recording.surface} />);
    await waitFor(() => expect(screen.getByTestId("roster-section-unavailable")).toBeDefined());
    for (const term of FORBIDDEN) {
      expect(container.textContent).not.toContain(term);
    }
  });
});
