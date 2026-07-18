// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isPlainLeftClick, isSameOriginInternalHref } from "./guarded-link";

// T08f P2 — GuardedLink must intercept ONLY an unmodified, primary,
// same-origin `_self` click; everything else (modified click, non-primary
// button, external destination) is native anchor behavior.

describe("isSameOriginInternalHref", () => {
  it("treats a root-relative path as internal", () => {
    expect(isSameOriginInternalHref("/people")).toBe(true);
    expect(isSameOriginInternalHref("/shift-requests?tab=history#row-3")).toBe(true);
  });

  it("treats a protocol-relative URL as external", () => {
    expect(isSameOriginInternalHref("//example.com/x")).toBe(false);
  });

  it("treats a same-origin absolute URL as internal", () => {
    expect(isSameOriginInternalHref(`${window.location.origin}/people`)).toBe(true);
  });

  it("treats a different-origin absolute URL as external", () => {
    expect(isSameOriginInternalHref("https://example.com/people")).toBe(false);
  });
});

interface ClickEventOverrides {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

function clickEvent(overrides: ClickEventOverrides = {}) {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as unknown as import("react").MouseEvent<HTMLAnchorElement>;
}

describe("isPlainLeftClick", () => {
  it("is true for an unmodified primary click", () => {
    expect(isPlainLeftClick(clickEvent())).toBe(true);
  });

  it("is false for a middle/right click", () => {
    expect(isPlainLeftClick(clickEvent({ button: 1 }))).toBe(false);
    expect(isPlainLeftClick(clickEvent({ button: 2 }))).toBe(false);
  });

  it("is false for a modified click (Ctrl/Cmd/Shift/Alt)", () => {
    expect(isPlainLeftClick(clickEvent({ ctrlKey: true }))).toBe(false);
    expect(isPlainLeftClick(clickEvent({ metaKey: true }))).toBe(false);
    expect(isPlainLeftClick(clickEvent({ shiftKey: true }))).toBe(false);
    expect(isPlainLeftClick(clickEvent({ altKey: true }))).toBe(false);
  });
});
