import { describe, expect, it } from "vitest";

import { ASSISTANT_SETTLEMENTS, isRetryableSettlement } from "./lifecycle";

// WHICH SETTLED TURNS THE USER MAY SEND AGAIN.
//
// The panel used to say "Send again to retry" and offer nothing to press, so the
// rule lives here, beside the classes and the wording it is derived from. It is a
// product statement rather than an implementation detail, so it is pinned over the
// WHOLE settlement list: a new settlement class has to decide, in the same place,
// whether a failed turn can be sent again.
describe("the retry rule", () => {
  it("offers Retry for every settled turn that did not complete", () => {
    for (const settlement of ASSISTANT_SETTLEMENTS) {
      expect(isRetryableSettlement(settlement)).toBe(settlement !== "completed");
    }
  });

  it("covers a FAILED turn", () => {
    for (const settlement of ["run_failed", "detached_reload", "revoked"] as const) {
      expect(isRetryableSettlement(settlement)).toBe(true);
    }
  });

  it("covers an INTERRUPTED turn", () => {
    for (const settlement of [
      "stopped",
      "cancelled",
      "detached_timeout",
      "detached_runtime",
    ] as const) {
      expect(isRetryableSettlement(settlement)).toBe(true);
    }
  });

  it("offers nothing for a turn that answered", () => {
    expect(isRetryableSettlement("completed")).toBe(false);
  });
});
