import { describe, expect, it } from "vitest";
import { getUniqueCopyLabel } from "./duplicate-label";

describe("getUniqueCopyLabel", () => {
  it("appends ' copy' to a trimmed source", () => {
    expect(getUniqueCopyLabel("  Alice  ", [])).toBe("Alice copy");
  });

  it("dedupes with ' 2', ' 3' against the existing namespace", () => {
    expect(getUniqueCopyLabel("Alice", ["Alice copy"])).toBe("Alice copy 2");
    expect(getUniqueCopyLabel("Alice", ["Alice copy", "Alice copy 2"])).toBe("Alice copy 3");
  });

  it("strips a prior ' copy' / ' copy {n}' suffix so a copy of a copy does not stack", () => {
    expect(getUniqueCopyLabel("Alice copy", [])).toBe("Alice copy");
    expect(getUniqueCopyLabel("Alice copy 2", [])).toBe("Alice copy");
    // case-insensitive suffix strip
    expect(getUniqueCopyLabel("Alice COPY 3", [])).toBe("Alice copy");
  });

  it("uses the fallback as the first candidate for an empty/whitespace source", () => {
    // Spec 03 duplicate labeling: an empty source uses the fallback itself
    // ("Copy"), not "Copy copy".
    expect(getUniqueCopyLabel("", [])).toBe("Copy");
    expect(getUniqueCopyLabel("   ", [])).toBe("Copy");
  });

  it("dedupes the fallback when it already exists", () => {
    expect(getUniqueCopyLabel("", ["Copy"])).toBe("Copy 2");
  });

  it("honours a custom fallback", () => {
    expect(getUniqueCopyLabel("", [], "Group")).toBe("Group");
  });
});
