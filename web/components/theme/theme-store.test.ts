// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCENTS,
  ACCENT_KEY,
  DEFAULT_ACCENT,
  THEME_KEY,
  getServerSnapshot,
  getSnapshot,
  setAccent,
  setTheme,
  subscribe,
  toggleTheme,
  __resetForTests,
} from "./theme-store";

// The store's job is the hydration split plus per-axis persistence. Two things
// it must never do: adopt DOM state during render (that would race the fixed SSR
// snapshot), and write an axis the user did not touch.

let setItem: ReturnType<typeof vi.fn>;

function installStorage(throwOnWrite = false) {
  const store = new Map<string, string>();
  setItem = vi.fn((key: string, value: string) => {
    if (throwOnWrite) throw new DOMException("quota", "QuotaExceededError");
    store.set(key, value);
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem,
      removeItem: vi.fn((key: string) => store.delete(key)),
    },
  });
}

function paint(theme: "light" | "dark", accent: string | null) {
  const el = document.documentElement;
  el.classList.toggle("dark", theme === "dark");
  if (accent === null) el.removeAttribute("data-accent");
  else el.setAttribute("data-accent", accent);
}

beforeEach(() => {
  __resetForTests();
  paint("light", null);
  installStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("accent allowlist", () => {
  it("is exactly the four v2 accents, teal first", () => {
    expect([...ACCENTS]).toEqual(["teal", "sage", "rose", "plum"]);
    expect(DEFAULT_ACCENT).toBe("teal");
  });
});

describe("server / hydration snapshot", () => {
  it("is a stable reference so useSyncExternalStore never loops", () => {
    expect(getServerSnapshot()).toBe(getServerSnapshot());
  });

  it("is the fixed light + teal default", () => {
    expect(getServerSnapshot()).toEqual({ theme: "light", accent: "teal" });
  });

  it("is what getSnapshot returns before the first subscribe", () => {
    paint("dark", "plum");
    // No adoption has happened yet: the hydration render must still match SSR.
    expect(getSnapshot()).toEqual({ theme: "light", accent: "teal" });
  });
});

describe("post-commit adoption of the pre-painted DOM", () => {
  it.each(ACCENTS)("adopts dark + %s from <html>", (accent) => {
    paint("dark", accent);
    subscribe(() => {});
    expect(getSnapshot()).toEqual({ theme: "dark", accent });
  });

  it.each([null, "", "blue", "magenta", "slate", "nonsense"])(
    "adopts teal when data-accent is %o",
    (accent) => {
      paint("light", accent);
      subscribe(() => {});
      expect(getSnapshot().accent).toBe("teal");
    },
  );

  it("writes nothing to storage while adopting", () => {
    paint("dark", "rose");
    subscribe(() => {});
    expect(setItem).not.toHaveBeenCalled();
  });

  it("adopts once, so a second subscriber does not re-read a mutated DOM", () => {
    paint("dark", "sage");
    subscribe(() => {});
    paint("light", "plum");
    subscribe(() => {});
    expect(getSnapshot()).toEqual({ theme: "dark", accent: "sage" });
  });

  it("notifies subscribers and detaches them on unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    setTheme("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setTheme("light");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("each user action persists only the axis it changed", () => {
  beforeEach(() => subscribe(() => {}));

  it("setTheme writes ns-theme and nothing else", () => {
    setTheme("dark");
    expect(setItem.mock.calls).toEqual([[THEME_KEY, "dark"]]);
  });

  it("toggleTheme writes ns-theme and nothing else", () => {
    toggleTheme();
    expect(setItem.mock.calls).toEqual([[THEME_KEY, "dark"]]);
  });

  it.each(ACCENTS)("setAccent(%s) writes ns-accent and nothing else", (accent) => {
    setAccent(accent);
    expect(setItem.mock.calls).toEqual([[ACCENT_KEY, accent]]);
  });

  // A persisted value must mean "the user picked this", never "the user was here
  // once": coupling the axes previously froze the accent on any theme toggle.
  it("a theme toggle never pins the accent", () => {
    toggleTheme();
    toggleTheme();
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([THEME_KEY, THEME_KEY]);
  });
});

describe("DOM reflection", () => {
  beforeEach(() => subscribe(() => {}));

  it("keeps data-accent carrying the CHOICE, never a resolved hex", () => {
    setAccent("plum");
    expect(document.documentElement.getAttribute("data-accent")).toBe("plum");
    setTheme("dark");
    expect(document.documentElement.getAttribute("data-accent")).toBe("plum");
  });

  it("toggles the .dark class rather than writing colours", () => {
    setTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("style")).toBeNull();
  });

  it("still updates state and the DOM when the storage write throws", () => {
    installStorage(true);
    expect(() => setAccent("rose")).not.toThrow();
    expect(getSnapshot().accent).toBe("rose");
    expect(document.documentElement.getAttribute("data-accent")).toBe("rose");
  });
});
