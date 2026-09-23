// @vitest-environment jsdom
//
// Controller-level queue-intent regression for the card-editor family (T03F1
// round-2, finding 2).
//
// Proves two properties the round-2 review flagged:
//   • add/remove/duplicate/reorder are QUEUE-HEAD TRANSFORMS: two rapid actions
//     from one render both land, instead of the second being silently dropped
//     as `superseded` because its whole-list baseline moved.
//   • edit-save AWAITS and surfaces the baseline-guarded refusal: `update`
//     returns the outcome so a caller can keep its draft open on `superseded`
//     rather than closing over a dropped save.
//
// Uses `useCounts` as the representative controller; the shared mechanism
// (`commitCardsTransform` / `commitCardsSlice`) is the same across every card
// family.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useScenarioStore, scenarioCommands } from "@/lib/store";
import { drainScenarioCommands, resetScenarioForTest } from "@/lib/store/test-authority";
import { useCounts } from "./use-counts";
import { emptyCountForm, type CountFormState } from "./counts-model";

function makeForm(overrides: Partial<CountFormState> = {}): CountFormState {
  return { ...emptyCountForm(), ...overrides };
}

beforeEach(async () => {
  await resetScenarioForTest();
  // Seed one shift type so the count-card domain (shift types + groups) is valid.
  await scenarioCommands.mutate({ shifts: [{ id: "D" }] });
});

afterEach(() => {
  cleanup();
});

describe("useCounts — rapid two-action queue-head transforms", () => {
  it("two rapid duplicates from one render BOTH land", async () => {
    // THE BUG THIS CATCHES: before the queue-head transform repair, both
    // duplicates captured the SAME render-snapshot baseline. The first commit
    // changed the list reference; the second's baseline check then failed and
    // its write was silently dropped (`superseded`). The user asked for two
    // copies and got one.
    const { result } = renderHook(() => useCounts());

    // Seed one count card via the controller's own add (handles the domain).
    result.current.add(makeForm({ description: "Original" }));
    await drainScenarioCommands();

    // Re-render to capture the post-add snapshot.
    const { result: latest } = renderHook(() => useCounts());
    const uid = latest.current.counts[0].uid;

    // Fire two duplicates WITHOUT awaiting — the exact shape of two rapid clicks
    // in the same render frame. Each captures the same `counts` baseline.
    latest.current.duplicate(uid);
    latest.current.duplicate(uid);

    await drainScenarioCommands();

    const final = useScenarioStore.getState().cardsByKind.counts;
    // Original + TWO copies, not one. The second action composed on top of the
    // first at the queue head rather than being dropped.
    expect(final).toHaveLength(3);
    expect(final[0].description).toBe("Original");
  });

  it("two rapid adds from one render BOTH land", async () => {
    const { result } = renderHook(() => useCounts());

    // Fire two adds WITHOUT awaiting.
    result.current.add(makeForm({ description: "A" }));
    result.current.add(makeForm({ description: "B" }));

    await drainScenarioCommands();

    const final = useScenarioStore.getState().cardsByKind.counts;
    expect(final.map((c) => c.description)).toEqual(["A", "B"]);
  });

  it("add then rapid remove of a DIFFERENT card both land", async () => {
    const { result } = renderHook(() => useCounts());

    // Seed two cards.
    result.current.add(makeForm({ description: "Keep" }));
    await drainScenarioCommands();
    const { result: r2 } = renderHook(() => useCounts());
    r2.current.add(makeForm({ description: "Drop" }));
    await drainScenarioCommands();

    const { result: latest } = renderHook(() => useCounts());
    const dropUid = latest.current.counts.find((c) => c.description === "Drop")!.uid;

    // Rapid: add one, remove the other — both from the same render snapshot.
    latest.current.add(makeForm({ description: "New" }));
    latest.current.remove(dropUid);

    await drainScenarioCommands();

    const final = useScenarioStore.getState().cardsByKind.counts;
    expect(final.map((c) => c.description).sort()).toEqual(["Keep", "New"]);
  });
});

describe("useCounts — edit-save surfaces a superseded refusal", () => {
  it("update returns { ok: false, reason: 'superseded' } when the baseline list moved", async () => {
    // THE BUG THIS CATCHES: before the repair, `update` returned `void` and the
    // editor closed the draft immediately, silently dropping a save whose
    // baseline had moved under it. Now `update` awaits and returns the outcome
    // so the editor can keep the draft open on `superseded`.
    const { result } = renderHook(() => useCounts());
    result.current.add(makeForm({ description: "Original" }));
    await drainScenarioCommands();

    // Render to capture the baseline list reference (ref A = [card1]).
    const { result: baseline } = renderHook(() => useCounts());
    const uid = baseline.current.counts[0].uid;

    // Enqueue a command that changes the counts list WITHOUT draining. The
    // projection has NOT published yet, so the baseline hook has NOT re-rendered
    // — its `counts` closure is still ref A.
    const { result: mover } = renderHook(() => useCounts());
    mover.current.add(makeForm({ description: "Injected" }));

    // Now call update through the BASELINE controller. Its `counts` is ref A,
    // but by the time the updater runs at the queue head, the mover's add has
    // committed and the projection holds ref B ([card1, card2]). The baseline
    // guard `state.cardsByKind.counts === counts` fails → `superseded`.
    const outcome = await baseline.current.update(uid, makeForm({ description: "Edited" }));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("superseded");
    // The edited card was NOT applied — the original description survives.
    const final = useScenarioStore.getState().cardsByKind.counts;
    expect(final.find((c) => c.uid === uid)?.description).toBe("Original");
  });

  it("update succeeds when the baseline list is unchanged", async () => {
    const { result } = renderHook(() => useCounts());
    result.current.add(makeForm({ description: "Original" }));
    await drainScenarioCommands();

    const { result: latest } = renderHook(() => useCounts());
    const uid = latest.current.counts[0].uid;

    const outcome = await latest.current.update(uid, makeForm({ description: "Edited" }));

    expect(outcome.ok).toBe(true);
    const final = useScenarioStore.getState().cardsByKind.counts;
    expect(final.find((c) => c.uid === uid)?.description).toBe("Edited");
  });
});
