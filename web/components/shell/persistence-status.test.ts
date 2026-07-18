import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createGuardedStorage } from "@/lib/store/persistence";
import { resolveWriteOutcome } from "./persistence-status";

// T08f P1 repair — the persistence controller must settle from the NEWEST
// queued revision: an older write failure superseded by a newer durable
// success must resolve `saved`, never a stale `error`.

describe("resolveWriteOutcome — controller settle regression", () => {
  it("settles saved when an older failure is superseded by a newer success", async () => {
    let call = 0;
    const inner: StateStorage = {
      getItem: async () => null,
      setItem: async (_name, value) => {
        // v1 fails; v2 (newest) succeeds.
        if (call++ === 0) throw new Error("disk full");
        void value;
      },
      removeItem: async () => {},
    };
    const storage = createGuardedStorage(() => inner);

    storage.setItem("k", "v1"); // rejects internally
    storage.setItem("k", "v2"); // newest — succeeds, must win

    expect(await resolveWriteOutcome(storage)).toBe("saved");
  });

  it("settles error when the newest revision genuinely fails", async () => {
    const inner: StateStorage = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("disk full");
      },
      removeItem: async () => {},
    };
    const storage = createGuardedStorage(() => inner);

    storage.setItem("k", "v1");

    expect(await resolveWriteOutcome(storage)).toBe("error");
  });

  it("settles saved with no storage (defensive default)", async () => {
    expect(await resolveWriteOutcome(undefined)).toBe("saved");
  });
});
