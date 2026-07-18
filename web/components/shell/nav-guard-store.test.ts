import { beforeEach, describe, expect, it } from "vitest";
import { hasLosableDrafts, useNavGuardStore } from "./nav-guard-store";

// T08a — the keyed losable-draft registry replaces the old `draftOpen: boolean`.
// A boolean is unsafe once two editors can register independently: one owner's
// cleanup must never disarm another's registration.

describe("nav-guard-store — losable-draft registry", () => {
  // The store is a module-level singleton; reset it so one test's registrations
  // never leak into the next.
  beforeEach(() => {
    useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
  });

  it("is disarmed with no registrations", () => {
    expect(hasLosableDrafts()).toBe(false);
  });

  it("arms while a draft is registered and disarms on cleanup", () => {
    const unregister = useNavGuardStore.getState().registerDraft({ id: "a", label: "Draft A" });
    expect(hasLosableDrafts()).toBe(true);
    unregister();
    expect(hasLosableDrafts()).toBe(false);
  });

  it("two simultaneous owners: closing one leaves the other armed", () => {
    const unregisterA = useNavGuardStore.getState().registerDraft({ id: "a", label: "Draft A" });
    const unregisterB = useNavGuardStore.getState().registerDraft({ id: "b", label: "Draft B" });
    expect(hasLosableDrafts()).toBe(true);

    unregisterA();
    expect(hasLosableDrafts()).toBe(true); // B is still open

    unregisterB();
    expect(hasLosableDrafts()).toBe(false);
  });

  it("cleanup is idempotent — calling it twice is a no-op the second time", () => {
    const unregisterA = useNavGuardStore.getState().registerDraft({ id: "a", label: "Draft A" });
    useNavGuardStore.getState().registerDraft({ id: "b", label: "Draft B" });

    unregisterA();
    unregisterA(); // second call must not touch B's registration
    expect(hasLosableDrafts()).toBe(true);
    expect(useNavGuardStore.getState().drafts.has("b")).toBe(true);
  });

  it("re-registering the same id replaces its entry without duplicating", () => {
    useNavGuardStore.getState().registerDraft({ id: "a", label: "First open" });
    useNavGuardStore.getState().registerDraft({ id: "a", label: "Second open" });
    expect(useNavGuardStore.getState().drafts.size).toBe(1);
    expect(useNavGuardStore.getState().drafts.get("a")?.label).toBe("Second open");
  });

  it("a stale cleanup from a replaced same-id registration cannot disarm its replacement (T08f P2)", () => {
    const unregisterFirst = useNavGuardStore
      .getState()
      .registerDraft({ id: "a", label: "First open" });
    useNavGuardStore.getState().registerDraft({ id: "a", label: "Second open" });

    // The FIRST owner's cleanup fires after the id was already replaced (e.g. a
    // stale unmount effect) — it must be a no-op, not remove the newer entry.
    unregisterFirst();

    expect(hasLosableDrafts()).toBe(true);
    expect(useNavGuardStore.getState().drafts.get("a")?.label).toBe("Second open");
  });
});

describe("nav-guard-store — single unresolved intent (T08f P1)", () => {
  beforeEach(() => {
    useNavGuardStore.setState({ drafts: new Map(), pendingIntent: null, open: false });
  });

  it("requestIntent ignores a second stage while one is already pending", () => {
    const firstCommit = () => {};
    const secondCommit = () => {};
    useNavGuardStore.getState().requestIntent({ kind: "back", commit: firstCommit });
    useNavGuardStore.getState().requestIntent({ kind: "back", commit: secondCommit });

    // The FIRST intent is still the one bound to the dialog — a repeated Back
    // press before Confirm/Cancel must not overwrite it.
    expect(useNavGuardStore.getState().pendingIntent?.commit).toBe(firstCommit);
  });

  it("cancel clears the pending intent without running any commit — including a later ignored stage's", () => {
    let firstCommitted = false;
    let secondCommitted = false;
    useNavGuardStore.getState().requestIntent({
      kind: "back",
      commit: () => {
        firstCommitted = true;
      },
    });
    useNavGuardStore.getState().requestIntent({
      kind: "back",
      commit: () => {
        secondCommitted = true;
      },
    });

    useNavGuardStore.getState().cancel();
    expect(firstCommitted).toBe(false);
    expect(secondCommitted).toBe(false);
    expect(useNavGuardStore.getState().pendingIntent).toBeNull();
    expect(useNavGuardStore.getState().open).toBe(false);
  });

  it("after confirm/cancel resolves the pending intent, a new one can be staged", () => {
    let confirmed = 0;
    useNavGuardStore.getState().requestIntent({
      kind: "push",
      commit: () => {
        confirmed++;
      },
    });
    useNavGuardStore.getState().confirm();
    expect(confirmed).toBe(1);

    let secondConfirmed = 0;
    useNavGuardStore.getState().requestIntent({
      kind: "push",
      commit: () => {
        secondConfirmed++;
      },
    });
    useNavGuardStore.getState().confirm();
    expect(secondConfirmed).toBe(1);
  });
});
