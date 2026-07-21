import { describe, expect, it } from "vitest";
import {
  MAX_CURSOR_BYTES,
  MAX_DISPLAY_FILENAME_BYTES,
  MAX_DISPLAY_LABEL_BYTES,
  MAX_DISPLAY_MESSAGE_BYTES,
  isNonEmptyStringWithin,
  truncateUtf8,
  utf8ByteLength,
  withinUtf8Bytes,
} from "@/lib/query/sse-limits";

describe("utf8ByteLength", () => {
  it("counts ASCII one byte per char", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("abc")).toBe(3);
  });

  it("counts 2 bytes for U+0080..U+07FF", () => {
    // U+00A9 (©) is a 2-byte UTF-8 char.
    expect(utf8ByteLength("©")).toBe(2);
    expect(utf8ByteLength("©©")).toBe(4);
  });

  it("counts 3 bytes for the BMP outside the ASCII/Latin-1 ranges", () => {
    // U+3042 (HIRAGANA A) is a 3-byte UTF-8 char.
    expect(utf8ByteLength("あ")).toBe(3);
    expect(utf8ByteLength("ああ")).toBe(6);
  });

  it("counts 4 bytes for astral-plane chars (surrogate pair)", () => {
    // U+1F600 (😀) is a 4-byte UTF-8 char encoded as a surrogate pair in JS.
    expect(utf8ByteLength("😀")).toBe(4);
  });

  it("counts 3 bytes for a lone high surrogate (matches TextEncoder replacement behavior defensively)", () => {
    expect(utf8ByteLength("\uD83D")).toBe(3);
  });

  it("matches TextEncoder.encode for a mixed BMP+astral string", () => {
    const value = "abc©あ😀";
    const expected = new TextEncoder().encode(value).length;
    expect(utf8ByteLength(value)).toBe(expected);
  });
});

describe("withinUtf8Bytes / isNonEmptyStringWithin", () => {
  it("withinUtf8Bytes is true at the cap, false one byte over", () => {
    expect(withinUtf8Bytes("abc", 3)).toBe(true);
    expect(withinUtf8Bytes("abc", 2)).toBe(false);
    expect(withinUtf8Bytes("あ", 3)).toBe(true); // exactly 3 bytes
    expect(withinUtf8Bytes("あ", 2)).toBe(false);
  });

  it("isNonEmptyStringWithin rejects empty / non-string / oversized", () => {
    expect(isNonEmptyStringWithin("", 10)).toBe(false);
    expect(isNonEmptyStringWithin(undefined, 10)).toBe(false);
    expect(isNonEmptyStringWithin(null, 10)).toBe(false);
    expect(isNonEmptyStringWithin(123, 10)).toBe(false);
    expect(isNonEmptyStringWithin("ok", 10)).toBe(true);
    expect(isNonEmptyStringWithin("ok", 1)).toBe(false);
  });
});

describe("truncateUtf8 (UTF-8-safe display truncation)", () => {
  it("returns the value unchanged when it already fits", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc");
    expect(truncateUtf8("abc", 100)).toBe("abc");
    expect(truncateUtf8("", 0)).toBe("");
  });

  it("truncates ASCII to exactly the byte cap", () => {
    expect(truncateUtf8("abcdef", 3)).toBe("abc");
    expect(utf8ByteLength(truncateUtf8("x".repeat(5000), 1024))).toBe(1024);
  });

  it("never splits a multibyte character (truncates to a whole code point)", () => {
    // Three 3-byte chars = 9 bytes. A cap of 8 must drop the third char whole,
    // never emit a 2-byte partial sequence.
    const value = "あああ";
    const out = truncateUtf8(value, 8);
    expect(out).toBe("ああ");
    expect(utf8ByteLength(out)).toBe(6);
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(8);
  });

  it("keeps an astral-plane surrogate pair whole", () => {
    // One 4-byte emoji. A cap of 3 cannot fit it, so the result is empty rather
    // than a broken half-pair.
    const emoji = "😀";
    expect(truncateUtf8(emoji, 3)).toBe("");
    expect(truncateUtf8(emoji, 4)).toBe(emoji);
    // A trailing emoji that does not fit is dropped whole.
    expect(truncateUtf8("ab" + emoji, 4)).toBe("ab");
  });

  it("bounds a pathological multi-megabyte string to the cap", () => {
    const huge = "z".repeat(2 * 1024 * 1024);
    expect(utf8ByteLength(truncateUtf8(huge, MAX_DISPLAY_MESSAGE_BYTES))).toBe(
      MAX_DISPLAY_MESSAGE_BYTES,
    );
  });
});

// The cap values are load-bearing constants; guard against accidental drift and
// document the structural-vs-display distinction (`sse-record-byte-bounds`).
describe("byte-bound cap authority (sse-record-byte-bounds)", () => {
  it("MAX_CURSOR_BYTES is 4 KiB and exceeds the worst-case protocol cursor", () => {
    expect(MAX_CURSOR_BYTES).toBe(4096);
    // Worst case: "v1." + b64url(512 UTF-8 bytes) + "." + b64url(41 bytes).
    const worstCaseCursorBytes =
      "v1.".length + Math.ceil((512 * 4) / 3) + ".".length + Math.ceil((41 * 4) / 3);
    expect(MAX_CURSOR_BYTES).toBeGreaterThan(worstCaseCursorBytes);
  });

  it("display caps hold their documented finite values", () => {
    expect(MAX_DISPLAY_LABEL_BYTES).toBe(640);
    expect(MAX_DISPLAY_FILENAME_BYTES).toBe(512);
    expect(MAX_DISPLAY_MESSAGE_BYTES).toBe(2048);
    // Each is a positive finite bound (truncation, never rejection).
    for (const cap of [
      MAX_DISPLAY_LABEL_BYTES,
      MAX_DISPLAY_FILENAME_BYTES,
      MAX_DISPLAY_MESSAGE_BYTES,
    ]) {
      expect(cap).toBeGreaterThan(0);
      expect(Number.isFinite(cap)).toBe(true);
    }
  });
});
