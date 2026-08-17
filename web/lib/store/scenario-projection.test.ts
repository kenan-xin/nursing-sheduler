// THE RUNTIME HALF of the projection façade (custom-AST ticket 2).
//
// `scenario-projection.negative.test-d.ts` proves the TYPE carries no mutator. That is
// not enough on its own: a type is erased, so a value annotated read-only can still be
// a live zustand api that `Reflect.get(store, "setState")` walks straight into. This
// file asserts the ABSENCE at runtime, which is what makes the compile-time claim more
// than a naming convention.
//
// The control at the bottom is load-bearing: a raw zustand store DOES expose every one
// of these, so the assertions above it are about this façade rather than about zustand
// having changed.

import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { createEmptyScenarioUiState } from "@/lib/scenario";
import { createScenarioProjection } from "./scenario-store";
import { resetScenarioProjection, stateSpine, useScenarioStore } from "./spine";

/** Everything zustand's store api exposes that can change or tear down the store. */
const MUTATORS = ["setState", "destroy", "temporal"] as const;

describe("the exported scenario projection has no writer", () => {
  it("exposes no mutating member, however it is asked for", () => {
    for (const name of MUTATORS) {
      expect(Reflect.get(useScenarioStore, name), name).toBeUndefined();
    }
  });

  it("cannot have one added to it later", () => {
    expect(Object.isFrozen(useScenarioStore)).toBe(true);
    expect(Object.isFrozen(stateSpine)).toBe(true);
  });

  it("is the same value the spine holds, so there is no wider second handle", () => {
    expect(stateSpine.scenario).toBe(useScenarioStore);
  });

  it("still reads, selects and subscribes", () => {
    expect(typeof useScenarioStore.getState().rangeStart).toBe("string");
    expect(typeof useScenarioStore.getInitialState()).toBe("object");

    let notified = 0;
    const unsubscribe = useScenarioStore.subscribe(() => {
      notified += 1;
    });
    resetScenarioProjection();
    unsubscribe();
    expect(notified).toBeGreaterThan(0);
  });

  it("is genuinely wired: the named reset command changes what it reads", () => {
    // Non-vacuity for the whole façade. Without this, every assertion above would
    // also pass against an inert object that projects nothing at all.
    const empty = createEmptyScenarioUiState();
    resetScenarioProjection();
    expect(useScenarioStore.getState().rangeStart).toBe(empty.rangeStart);
    expect(useScenarioStore.getState().backupFingerprint).toBeNull();
  });
});

describe("the writer is reachable only from the handle that created the projection", () => {
  it("a freshly minted projection writes its OWN store and not the app one", () => {
    const own = createScenarioProjection();
    const before = useScenarioStore.getState().rangeStart;

    own.write.replace({
      ...createEmptyScenarioUiState(),
      rangeStart: "2099-01-01",
      backupFingerprint: null,
    });

    expect(own.read.getState().rangeStart).toBe("2099-01-01");
    // The point of the whole design: minting a handle is not a route into the
    // projection the components read.
    expect(useScenarioStore.getState().rangeStart).toBe(before);
  });

  it("and its own read face is narrowed the same way", () => {
    const own = createScenarioProjection();
    for (const name of MUTATORS) {
      expect(Reflect.get(own.read, name), name).toBeUndefined();
    }
  });
});

describe("the control that keeps the absence meaningful", () => {
  it("a raw zustand store exposes exactly what the façade withholds", () => {
    const raw = create<{ value: number }>()(() => ({ value: 0 }));
    expect(typeof Reflect.get(raw, "setState")).toBe("function");
    expect(typeof raw.getState).toBe("function");
  });
});
