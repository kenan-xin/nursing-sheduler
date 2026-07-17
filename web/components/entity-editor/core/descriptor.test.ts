import { describe, expect, it } from "vitest";
import { entityKey, sameEntityId } from "./descriptor";

describe("entityKey (presentation identity)", () => {
  it("tags both branches disjointly so numeric/string domains never collide (MAJOR 1)", () => {
    // The old `#`-prefix collision: numeric 1 and the LEGAL string "#1" both encoded
    // as "#1". Disjoint `number:` / `string:` tags keep the whole domain unique.
    expect(entityKey(1)).toBe("number:1");
    expect(entityKey("1")).toBe("string:1");
    expect(entityKey("#1")).toBe("string:#1");
    expect(entityKey(1)).not.toBe(entityKey("#1"));

    // Negative ids likewise stay disjoint.
    expect(entityKey(-1)).toBe("number:-1");
    expect(entityKey("#-1")).toBe("string:#-1");
    expect(entityKey(-1)).not.toBe(entityKey("#-1"));
  });

  it("is injective across a mixed id set (every distinct id → a distinct key)", () => {
    const ids = [1, "1", "#1", -1, "#-1", 0, "0", "A"];
    const keys = ids.map(entityKey);
    expect(new Set(keys).size).toBe(ids.length);
  });
});

describe("sameEntityId (logical identity)", () => {
  it("is exact typed equality — 1 and '1' never collapse", () => {
    expect(sameEntityId(1, 1)).toBe(true);
    expect(sameEntityId("1", "1")).toBe(true);
    expect(sameEntityId(1, "1")).toBe(false);
    expect(sameEntityId(1, "#1")).toBe(false);
    expect(sameEntityId("#1", "#1")).toBe(true);
  });
});
