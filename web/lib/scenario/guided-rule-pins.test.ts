import { describe, expect, it } from "vitest";
import type { CardsByKind, GuidedRulePin } from "./types";
import {
  createGuidedRulePin,
  dedupeGuidedRulePinsBySource,
  pruneOrphanedGuidedRulePins,
  removeGuidedRulePin,
  removeGuidedRulePins,
  updateGuidedRulePin,
  upsertGuidedRulePin,
  upsertGuidedRulePinBySource,
} from "./guided-rule-pins";

function emptyCards(): CardsByKind {
  return { requirements: [], successions: [], counts: [], affinities: [], coverings: [] };
}

function cardsWithCount(uid: string): CardsByKind {
  return {
    ...emptyCards(),
    counts: [
      {
        uid,
        person: "ALL",
        countDates: "ALL",
        countShiftTypes: "D",
        expression: ">=",
        target: 1,
        weight: 1,
      },
    ],
  };
}

describe("createGuidedRulePin", () => {
  it("builds a pin with a fresh id and the given draft fields", () => {
    const pin = createGuidedRulePin({
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      description: "Cap nights",
      quickFields: ["target"],
    });
    expect(typeof pin.id).toBe("string");
    expect(pin.id.length).toBeGreaterThan(0);
    expect(pin).toMatchObject({
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      description: "Cap nights",
      quickFields: ["target"],
    });
  });

  it("assigns distinct ids across calls", () => {
    const draft = {
      constraintKind: "counts" as const,
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const a = createGuidedRulePin(draft);
    const b = createGuidedRulePin(draft);
    expect(a.id).not.toBe(b.id);
  });
});

describe("upsertGuidedRulePin", () => {
  it("appends a new pin", () => {
    const pin: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    expect(upsertGuidedRulePin([], pin)).toEqual([pin]);
  });

  it("replaces an existing pin with the same id in place", () => {
    const pin: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const replacement: GuidedRulePin = { ...pin, category: "Rest" };
    expect(upsertGuidedRulePin([pin], replacement)).toEqual([replacement]);
  });
});

describe("updateGuidedRulePin", () => {
  const pin: GuidedRulePin = {
    id: "p1",
    constraintKind: "counts",
    constraintId: "c1",
    category: "Hours",
    quickFields: ["target"],
  };

  it("patches shortcut metadata by id", () => {
    const next = updateGuidedRulePin([pin], "p1", { category: "Rest", description: "Cap it" });
    expect(next).toEqual([{ ...pin, category: "Rest", description: "Cap it" }]);
  });

  it("is a reference-stable no-op for an unknown id", () => {
    const pins = [pin];
    expect(updateGuidedRulePin(pins, "missing", { category: "Rest" })).toBe(pins);
  });
});

describe("upsertGuidedRulePinBySource", () => {
  it("appends a new pin for a source with no existing pin", () => {
    const next = upsertGuidedRulePinBySource([], {
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: ["target"],
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ constraintKind: "counts", constraintId: "c1" });
  });

  it("replaces the existing pin for the same source in place, keeping its id", () => {
    const existing: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: ["target"],
    };
    const next = upsertGuidedRulePinBySource([existing], {
      constraintKind: "counts",
      constraintId: "c1",
      category: "Custom shortcuts",
      description: "New blurb",
      quickFields: [],
    });
    expect(next).toEqual([
      {
        id: "p1",
        constraintKind: "counts",
        constraintId: "c1",
        category: "Custom shortcuts",
        description: "New blurb",
        quickFields: [],
      },
    ]);
  });

  it("leaves pins for other sources untouched", () => {
    const other: GuidedRulePin = {
      id: "other",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: [],
    };
    const existing: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const next = upsertGuidedRulePinBySource([other, existing], {
      constraintKind: "counts",
      constraintId: "c1",
      category: "Rest",
      quickFields: [],
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(other);
  });
});

describe("dedupeGuidedRulePinsBySource", () => {
  it("collapses duplicate pins for the same source to the last (most recent) one", () => {
    const first: GuidedRulePin = {
      id: "old",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const second: GuidedRulePin = {
      id: "new",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Custom shortcuts",
      quickFields: ["target"],
    };
    expect(dedupeGuidedRulePinsBySource([first, second])).toEqual([second]);
  });

  it("keeps pins for distinct sources, in their original relative order", () => {
    const a: GuidedRulePin = {
      id: "a",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const b: GuidedRulePin = {
      id: "b",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: [],
    };
    expect(dedupeGuidedRulePinsBySource([a, b])).toEqual([a, b]);
  });

  it("is reference-stable when there are no duplicates", () => {
    const pins: GuidedRulePin[] = [
      { id: "a", constraintKind: "counts", constraintId: "c1", category: "Hours", quickFields: [] },
    ];
    expect(dedupeGuidedRulePinsBySource(pins)).toBe(pins);
  });

  it("drops every earlier duplicate when more than two share a source", () => {
    const pins: GuidedRulePin[] = [
      { id: "p1", constraintKind: "counts", constraintId: "c1", category: "A", quickFields: [] },
      { id: "p2", constraintKind: "counts", constraintId: "c1", category: "B", quickFields: [] },
      { id: "p3", constraintKind: "counts", constraintId: "c1", category: "C", quickFields: [] },
    ];
    expect(dedupeGuidedRulePinsBySource(pins)).toEqual([pins[2]]);
  });
});

describe("removeGuidedRulePins", () => {
  const pins: GuidedRulePin[] = [
    {
      id: "keep",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    },
    {
      id: "drop1",
      constraintKind: "requirements",
      constraintId: "r1",
      category: "Staffing",
      quickFields: [],
    },
    {
      id: "drop2",
      constraintKind: "affinities",
      constraintId: "a1",
      category: "Pairing",
      quickFields: [],
    },
  ];

  it("removes every pin whose id is in the given list, in one call", () => {
    expect(removeGuidedRulePins(pins, ["drop1", "drop2"])).toEqual([pins[0]]);
  });

  it("is a no-op (reference-stable) for an empty id list", () => {
    expect(removeGuidedRulePins(pins, [])).toBe(pins);
  });

  it("is reference-stable when none of the given ids match", () => {
    expect(removeGuidedRulePins(pins, ["nonexistent"])).toBe(pins);
  });
});

describe("removeGuidedRulePin", () => {
  const pin: GuidedRulePin = {
    id: "p1",
    constraintKind: "counts",
    constraintId: "c1",
    category: "Hours",
    quickFields: [],
  };

  it("removes a pin by id — unpinning never touches the source constraint", () => {
    expect(removeGuidedRulePin([pin], "p1")).toEqual([]);
  });

  it("is a reference-stable no-op for an unknown id", () => {
    const pins = [pin];
    expect(removeGuidedRulePin(pins, "missing")).toBe(pins);
  });
});

describe("pruneOrphanedGuidedRulePins", () => {
  it("drops a pin whose source card no longer exists", () => {
    const pin: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "gone",
      category: "Hours",
      quickFields: [],
    };
    expect(pruneOrphanedGuidedRulePins([pin], emptyCards())).toEqual([]);
  });

  it("keeps a pin whose source card still exists", () => {
    const pin: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    expect(pruneOrphanedGuidedRulePins([pin], cardsWithCount("c1"))).toEqual([pin]);
  });

  it("prunes only the orphaned pin, leaving surviving pins untouched", () => {
    const surviving: GuidedRulePin = {
      id: "keep",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const orphaned: GuidedRulePin = {
      id: "drop",
      constraintKind: "counts",
      constraintId: "deleted",
      category: "Hours",
      quickFields: [],
    };
    const next = pruneOrphanedGuidedRulePins([surviving, orphaned], cardsWithCount("c1"));
    expect(next).toEqual([surviving]);
  });

  it("is reference-stable when nothing is pruned", () => {
    const pin: GuidedRulePin = {
      id: "p1",
      constraintKind: "counts",
      constraintId: "c1",
      category: "Hours",
      quickFields: [],
    };
    const pins = [pin];
    expect(pruneOrphanedGuidedRulePins(pins, cardsWithCount("c1"))).toBe(pins);
  });

  it("matches on constraintKind AND constraintId — a same-uid card of another kind does not save it", () => {
    const pin: GuidedRulePin = {
      id: "p1",
      constraintKind: "requirements",
      constraintId: "shared-uid",
      category: "Staffing",
      quickFields: [],
    };
    // "shared-uid" only exists under counts, not requirements.
    const cards: CardsByKind = cardsWithCount("shared-uid");
    expect(pruneOrphanedGuidedRulePins([pin], cards)).toEqual([]);
  });
});
