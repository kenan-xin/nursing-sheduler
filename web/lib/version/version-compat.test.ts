import { describe, expect, it } from "vitest";

import { classifyVersionCompatibility, parseVersionParts } from "./version-compat";

// ── parseVersionParts ─────────────────────────────────────────────────────

describe("parseVersionParts", () => {
  it("parses an exact tag", () => {
    expect(parseVersionParts("v0.1.1")).toEqual({
      major: 0,
      minor: 1,
      patch: 1,
      commitsAfterTag: 0,
      commitId: null,
      dirty: false,
      full: "v0.1.1",
    });
  });

  it("parses a tagged commit with suffix", () => {
    expect(parseVersionParts("v0.1.1-442-g89190ab")).toEqual({
      major: 0,
      minor: 1,
      patch: 1,
      commitsAfterTag: 442,
      commitId: "89190ab",
      dirty: false,
      full: "v0.1.1-442-g89190ab",
    });
  });

  it("parses a bare hash", () => {
    expect(parseVersionParts("89190ab")).toEqual({
      major: null,
      minor: null,
      patch: null,
      commitsAfterTag: 0,
      commitId: "89190ab",
      dirty: false,
      full: "89190ab",
    });
  });

  it("parses a dirty suffix", () => {
    expect(parseVersionParts("v0.1.1-442-g89190ab-dirty")).toEqual({
      major: 0,
      minor: 1,
      patch: 1,
      commitsAfterTag: 442,
      commitId: "89190ab",
      dirty: true,
      full: "v0.1.1-442-g89190ab-dirty",
    });
  });

  it("normalizes an optional leading v (decision B)", () => {
    expect(parseVersionParts("0.1.0")).toEqual(
      expect.objectContaining({ major: 0, minor: 1, patch: 0 }),
    );
    expect(parseVersionParts("0.1.0-5-gabcdef0")).toEqual(
      expect.objectContaining({ major: 0, minor: 1, patch: 0, commitsAfterTag: 5 }),
    );
  });

  it("returns null semver for unparseable input", () => {
    expect(parseVersionParts("garbage")).toEqual(
      expect.objectContaining({ major: null, minor: null, patch: null }),
    );
  });
});

// ── classifyVersionCompatibility — tier tests ────────────────────────────

describe("classifyVersionCompatibility", () => {
  describe("identical", () => {
    it("returns identical for same full string", () => {
      expect(classifyVersionCompatibility("v0.1.1-442-g89190ab", "v0.1.1-442-g89190ab")).toBe(
        "identical",
      );
    });

    it("returns identical for same bare hash", () => {
      expect(classifyVersionCompatibility("89190ab", "89190ab")).toBe("identical");
    });
  });

  describe("compatible", () => {
    it("returns compatible for same major.minor, different commit", () => {
      expect(classifyVersionCompatibility("v0.1.1-442-g89190ab", "v0.1.1-441-g89190ab")).toBe(
        "compatible",
      );
    });

    it("returns compatible for bare semver vs tagged (v-normalization)", () => {
      expect(classifyVersionCompatibility("0.1.0", "v0.1.0")).toBe("compatible");
    });
  });

  describe("incompatible", () => {
    it("returns incompatible for different minor", () => {
      expect(classifyVersionCompatibility("v0.1.1-442-g89190ab", "v0.2.0-10-g1234567")).toBe(
        "incompatible",
      );
    });

    it("returns incompatible for different major", () => {
      expect(classifyVersionCompatibility("v0.1.1-442-g89190ab", "v1.0.0-0-gabcdef0")).toBe(
        "incompatible",
      );
    });
  });

  describe("indeterminate", () => {
    it("returns indeterminate for bare hash vs tagged", () => {
      expect(classifyVersionCompatibility("89190ab", "v0.1.1-442-g89190ab")).toBe("indeterminate");
    });

    it("returns indeterminate for two bare hashes", () => {
      expect(classifyVersionCompatibility("89190ab", "abcdef0")).toBe("indeterminate");
    });
  });

  describe("dirty", () => {
    it("returns dirty when theirs is dirty", () => {
      expect(classifyVersionCompatibility("v0.1.1-442-g89190ab-dirty", "v0.1.1-442-g89190ab")).toBe(
        "dirty",
      );
    });

    it("returns dirty when mine is dirty", () => {
      expect(classifyVersionCompatibility("v0.1.1-442-g89190ab", "v0.1.1-442-g89190ab-dirty")).toBe(
        "dirty",
      );
    });

    it("returns dirty for two identical dirty strings (equal strings don't prove identical code)", () => {
      expect(
        classifyVersionCompatibility("v0.1.1-442-g89190ab-dirty", "v0.1.1-442-g89190ab-dirty"),
      ).toBe("dirty");
    });
  });

  describe("missing", () => {
    it("returns missing when theirs is undefined", () => {
      expect(classifyVersionCompatibility(undefined, "v0.1.1")).toBe("missing");
    });

    it("returns missing when mine is null", () => {
      expect(classifyVersionCompatibility("v0.1.1", null)).toBe("missing");
    });

    it("returns missing for empty string", () => {
      expect(classifyVersionCompatibility("", "v0.1.1")).toBe("missing");
    });

    it("returns missing for 'unknown' sentinel", () => {
      expect(classifyVersionCompatibility("unknown", "v0.1.1")).toBe("missing");
    });

    it("returns missing for 'v0.0.0-unknown' sentinel", () => {
      expect(classifyVersionCompatibility("v0.1.1", "v0.0.0-unknown")).toBe("missing");
    });
  });
});

// ── precedence tests ──────────────────────────────────────────────────────

describe("precedence", () => {
  it("missing beats dirty (dirty + missing → missing)", () => {
    expect(classifyVersionCompatibility("v0.1.1-dirty", undefined)).toBe("missing");
  });

  it("dirty beats identical (two equal dirty strings → dirty, not identical)", () => {
    expect(classifyVersionCompatibility("v0.1.1-dirty", "v0.1.1-dirty")).toBe("dirty");
  });

  it("dirty beats incompatible (dirty + different major.minor → dirty)", () => {
    expect(classifyVersionCompatibility("v0.1.1-dirty", "v0.2.0")).toBe("dirty");
  });

  it("dirty beats indeterminate (dirty-hash vs tagged → dirty)", () => {
    expect(classifyVersionCompatibility("89190ab-dirty", "v0.1.1")).toBe("dirty");
  });

  it("indeterminate beats incompatible (bare hash vs different minor → indeterminate)", () => {
    expect(classifyVersionCompatibility("89190ab", "v0.2.0")).toBe("indeterminate");
  });
});
