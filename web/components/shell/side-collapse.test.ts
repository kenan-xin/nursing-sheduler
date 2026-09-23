// @vitest-environment jsdom

// Desktop sidebar collapse preference (G8).
//
// Two things are under test and they are deliberately separate:
//
//   1. The STORE never reads storage at module init, so SSR and the first client
//      render agree on the expanded default; the stored value is adopted after
//      mount. This is the same contract lib/mode/mode.ts holds, and breaking it
//      produces a hydration mismatch rather than a visible bug.
//   2. The PRE-PAINT script — executed here as the exact string that ships —
//      puts the right width on <html> before the first frame, and agrees with
//      the store about the key and the "only `1` collapses" rule.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDE_ADOPTED_ATTRIBUTE,
  SIDE_COLLAPSE_ATTRIBUTE,
  SIDE_COLLAPSE_STORAGE_KEY,
  applySideCollapsed,
  createSideCollapseStore,
  persistSideCollapsed,
  readStoredSideCollapsed,
  useSideCollapseStore,
} from "./side-collapse";
import { SIDE_COLLAPSE_SCRIPT_SOURCE } from "./side-collapse-script";

function resetDom() {
  document.documentElement.removeAttribute(SIDE_COLLAPSE_ATTRIBUTE);
  document.documentElement.removeAttribute(SIDE_ADOPTED_ATTRIBUTE);
  window.localStorage.clear();
}

beforeEach(resetDom);
afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  useSideCollapseStore.setState({ collapsed: false, adopted: false });
});

describe("side-collapse storage", () => {
  it("uses the prototype's ns-side-collapsed key", () => {
    expect(SIDE_COLLAPSE_STORAGE_KEY).toBe("ns-side-collapsed");
  });

  it("collapses on the literal 1 and on nothing else", () => {
    expect(readStoredSideCollapsed()).toBe(false); // absent

    for (const stored of ["0", "", "true", "yes", "collapsed", "1 "]) {
      window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, stored);
      expect(readStoredSideCollapsed()).toBe(false);
    }

    window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, "1");
    expect(readStoredSideCollapsed()).toBe(true);
  });

  it("stays expanded when storage throws rather than hiding navigation", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied partitioned context");
    });
    expect(readStoredSideCollapsed()).toBe(false);
  });

  it("never throws when a write is denied", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => persistSideCollapsed(true)).not.toThrow();
  });

  it("writes an explicit 0 rather than deleting the key when expanded", () => {
    persistSideCollapsed(true);
    expect(window.localStorage.getItem(SIDE_COLLAPSE_STORAGE_KEY)).toBe("1");
    persistSideCollapsed(false);
    expect(window.localStorage.getItem(SIDE_COLLAPSE_STORAGE_KEY)).toBe("0");
    expect(readStoredSideCollapsed()).toBe(false);
  });
});

describe("side-collapse <html> mirror", () => {
  it("adds the attribute when collapsed and REMOVES it when expanded", () => {
    applySideCollapsed(true);
    expect(document.documentElement.getAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe("1");
    // Removed, not set to "0": globals.css keys the compact width off the
    // attribute's PRESENCE, and a leftover attribute would pin 60px forever.
    applySideCollapsed(false);
    expect(document.documentElement.hasAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe(false);
  });
});

describe("side-collapse store", () => {
  it("initializes expanded and unadopted, so SSR and hydration agree", () => {
    const store = createSideCollapseStore();
    expect(store.getState().collapsed).toBe(false);
    expect(store.getState().adopted).toBe(false);
    // Nothing was read at construction, even with a collapsed preference stored.
    window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, "1");
    expect(createSideCollapseStore().getState().collapsed).toBe(false);
  });

  it("persists AND mirrors on set", () => {
    const store = createSideCollapseStore();
    store.getState().setCollapsed(true);
    expect(store.getState().collapsed).toBe(true);
    expect(window.localStorage.getItem(SIDE_COLLAPSE_STORAGE_KEY)).toBe("1");
    expect(document.documentElement.getAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe("1");
  });

  it("persists AND mirrors on toggle, in both directions", () => {
    const store = createSideCollapseStore();
    store.getState().toggleCollapsed();
    expect(store.getState().collapsed).toBe(true);
    expect(document.documentElement.getAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe("1");

    store.getState().toggleCollapsed();
    expect(store.getState().collapsed).toBe(false);
    expect(window.localStorage.getItem(SIDE_COLLAPSE_STORAGE_KEY)).toBe("0");
    expect(document.documentElement.hasAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe(false);
  });

  it("marks adoption on the store and on <html>, idempotently", () => {
    const store = createSideCollapseStore();
    store.getState().markAdopted();
    expect(store.getState().adopted).toBe(true);
    expect(document.documentElement.getAttribute(SIDE_ADOPTED_ATTRIBUTE)).toBe("1");
    store.getState().markAdopted();
    expect(document.documentElement.getAttribute(SIDE_ADOPTED_ATTRIBUTE)).toBe("1");
  });
});

describe("pre-paint script", () => {
  /** Run the EXACT string that ships, the way the browser will. */
  function runScript() {
    new Function(SIDE_COLLAPSE_SCRIPT_SOURCE)();
  }

  it("names the same storage key the store does", () => {
    expect(SIDE_COLLAPSE_SCRIPT_SOURCE).toContain(SIDE_COLLAPSE_STORAGE_KEY);
    expect(SIDE_COLLAPSE_SCRIPT_SOURCE).toContain(SIDE_COLLAPSE_ATTRIBUTE);
  });

  it("sets the compact attribute before paint when the preference is collapsed", () => {
    window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, "1");
    runScript();
    expect(document.documentElement.getAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe("1");
  });

  it("leaves the document untouched for every non-collapsed value", () => {
    for (const stored of [null, "0", "", "true"]) {
      resetDom();
      if (stored !== null) window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, stored);
      runScript();
      expect(document.documentElement.hasAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe(false);
    }
  });

  it("survives storage access throwing, leaving the rail expanded", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => runScript()).not.toThrow();
    expect(document.documentElement.hasAttribute(SIDE_COLLAPSE_ATTRIBUTE)).toBe(false);
  });

  it("never writes to storage", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, "1");
    setItem.mockClear();
    runScript();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("never marks itself adopted — that is React's signal, not the script's", () => {
    window.localStorage.setItem(SIDE_COLLAPSE_STORAGE_KEY, "1");
    runScript();
    expect(document.documentElement.hasAttribute(SIDE_ADOPTED_ATTRIBUTE)).toBe(false);
  });
});
