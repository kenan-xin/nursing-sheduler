import { describe, expect, it } from "vitest";
import { resolvePersistenceStatus } from "./persistence-status";

// The badge must never claim "Saved" about a write that did not happen. Before
// T03 that required a settle protocol — drain the write queue, read a
// self-clearing error flag, and guard against an older revision settling after a
// newer one — because `persist` wrote behind the store and reported nothing back.
//
// A repository command reports its own outcome, so the status is now a pure fold
// of two published facts. These cases pin the fold, including the one place it is
// deliberately NOT a straight pass-through: bring-up outranks write status,
// because "is your work saved?" is meaningless before authority exists.

describe("resolvePersistenceStatus", () => {
  it("reports restoring until authority bring-up resolves, whatever the write status", () => {
    expect(resolvePersistenceStatus("unhydrated", "idle")).toBe("restoring");
    expect(resolvePersistenceStatus("hydrating", "writing")).toBe("restoring");
    expect(resolvePersistenceStatus("hydrating", "error")).toBe("restoring");
  });

  it("reports error when bring-up itself failed", () => {
    expect(resolvePersistenceStatus("recoverable-error", "saved")).toBe("error");
  });

  it("reflects an in-flight transaction as saving", () => {
    expect(resolvePersistenceStatus("ready", "writing")).toBe("saving");
  });

  it("surfaces a failed transaction rather than swallowing it", () => {
    expect(resolvePersistenceStatus("ready", "error")).toBe("error");
  });

  it("treats a ready store with no command yet as saved, not as unknown", () => {
    // `idle` means nothing has been written this session — which, once bring-up
    // published the committed envelope, is exactly "what you see is what is stored".
    expect(resolvePersistenceStatus("ready", "idle")).toBe("saved");
    expect(resolvePersistenceStatus("ready", "saved")).toBe("saved");
  });
});
