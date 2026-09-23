import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";

describe("canonicalJson", () => {
  it("sorts object keys so insertion order cannot change the hash", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }));
  });

  it("preserves array order, which IS content", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("treats an absent field and an explicitly undefined one as the same", () => {
    // They mean the same thing to every registry consumer, so they must not produce
    // two different manifests.
    expect(canonicalJson({ a: 1, routeId: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ x: { b: 1, a: [{ d: 1, c: 2 }] } })).toBe(
      '{"x":{"a":[{"c":2,"d":1}],"b":1}}',
    );
  });

  it("refuses what it cannot represent rather than coercing it", () => {
    // A value silently encoded as `null` is a hash that has stopped tracking the
    // content it claims to identify.
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/not representable/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/not representable/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/cannot encode function/);
    expect(() => canonicalJson({ a: Symbol("s") })).toThrow(/cannot encode symbol/);
  });

  it("encodes the primitives a manifest actually contains", () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(1)).toBe("1");
  });
});
