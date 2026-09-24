import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANGE_HIGHLIGHT_MS,
  changeTargetProps,
  clearChangeHighlight,
  showChangeHighlight,
  useChangeHighlightStore,
} from "./store";

const keys = () => [...useChangeHighlightStore.getState().keys];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  clearChangeHighlight();
  vi.useRealTimers();
});

describe("the change highlight channel", () => {
  it("holds the keys, then clears itself", () => {
    showChangeHighlight(["a", "b"]);
    expect(keys()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(CHANGE_HIGHLIGHT_MS - 1);
    expect(keys()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(keys()).toEqual([]);
  });

  it("a second highlight replaces the first and restarts the clock", () => {
    showChangeHighlight(["a"]);
    vi.advanceTimersByTime(CHANGE_HIGHLIGHT_MS - 10);
    showChangeHighlight(["b"]);
    vi.advanceTimersByTime(20);
    expect(keys()).toEqual(["b"]);
  });

  it("clear drops everything at once", () => {
    showChangeHighlight(["a"]);
    clearChangeHighlight();
    expect(keys()).toEqual([]);
  });
});

describe("changeTargetProps", () => {
  it("always names the target, and marks it only while highlighted", () => {
    expect(changeTargetProps("k", false)).toEqual({ "data-change-key": "k" });
    expect(changeTargetProps("k", true)).toEqual({
      "data-change-key": "k",
      "data-change-highlight": "true",
    });
  });
  it("renders nothing for a row with no key (a built-in rule)", () => {
    expect(changeTargetProps(undefined, true)).toEqual({});
  });
});
