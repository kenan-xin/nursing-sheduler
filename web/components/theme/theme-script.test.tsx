// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_SCRIPT_SOURCE } from "./theme-script";

// Executes the EXACT inline string that ships in <head>, so the pre-paint
// contract is tested rather than a re-implementation of it.
//
// The invariant under test is resilience: the two axes are read in independently
// guarded operations, so a browser that blocks or throws on storage still gets
// system theme plus the teal accent, and one failing read never aborts the
// other. The script must also never WRITE — an unsupported stored accent is
// ignored and left in place (adoption record D4b), with no migration marker.

type StorageStub = {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

let storage: StorageStub;

/** Installs a localStorage whose reads come from `values`; `throwFor` keys throw. */
function installStorage(values: Record<string, string> = {}, throwFor: string[] = []) {
  storage = {
    getItem: vi.fn((key: string) => {
      if (throwFor.includes(key)) throw new DOMException("denied", "SecurityError");
      return key in values ? values[key] : null;
    }),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

/** Installs a matchMedia reporting the given system preference, or one that throws. */
function installMatchMedia(prefersDark: boolean | "throws") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      if (prefersDark === "throws") throw new Error("matchMedia unavailable");
      return { matches: prefersDark && query.includes("dark"), media: query };
    },
  });
}

function runScript() {
  new Function(THEME_SCRIPT_SOURCE)();
}

function html() {
  return document.documentElement;
}

beforeEach(() => {
  html().className = "";
  html().removeAttribute("data-accent");
  installStorage();
  installMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme axis", () => {
  it("falls back to the system preference when nothing is stored", () => {
    installMatchMedia(true);
    runScript();
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("stays light when the system prefers light and nothing is stored", () => {
    runScript();
    expect(html().classList.contains("dark")).toBe(false);
  });

  it.each([
    ["dark", true],
    ["light", false],
  ])("applies the stored %s theme before paint", (stored, expectDark) => {
    installStorage({ "ns-theme": stored });
    installMatchMedia(!expectDark);
    runScript();
    expect(html().classList.contains("dark")).toBe(expectDark);
  });

  it.each(["", "DARK", "sepia"])(
    "ignores the unsupported stored theme %o and uses the system preference",
    (stored) => {
      installStorage({ "ns-theme": stored });
      installMatchMedia(true);
      runScript();
      expect(html().classList.contains("dark")).toBe(true);
    },
  );

  it("resolves to light when matchMedia itself throws", () => {
    installMatchMedia("throws");
    expect(() => runScript()).not.toThrow();
    expect(html().classList.contains("dark")).toBe(false);
    expect(html().getAttribute("data-accent")).toBe("teal");
  });
});

describe("accent axis", () => {
  it.each(["teal", "sage", "rose", "plum"])("applies the stored %s accent", (accent) => {
    installStorage({ "ns-accent": accent });
    runScript();
    expect(html().getAttribute("data-accent")).toBe(accent);
  });

  it("falls back to teal when nothing is stored", () => {
    runScript();
    expect(html().getAttribute("data-accent")).toBe("teal");
  });

  // The retired v1 hues have no mapping and no migration layer (D4b).
  it.each(["", "blue", "magenta", "slate", "TEAL", "null"])(
    "falls back to teal for the unsupported stored value %o",
    (stored) => {
      installStorage({ "ns-accent": stored });
      runScript();
      expect(html().getAttribute("data-accent")).toBe("teal");
    },
  );

  it("leaves an unsupported stored accent untouched rather than rewriting it", () => {
    installStorage({ "ns-accent": "blue" });
    runScript();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("always leaves data-accent set, so no consumer sees a missing attribute", () => {
    runScript();
    expect(html().hasAttribute("data-accent")).toBe(true);
  });
});

describe("the two axes are guarded independently", () => {
  it("a blocked theme read still applies the stored accent", () => {
    installStorage({ "ns-accent": "rose" }, ["ns-theme"]);
    installMatchMedia(true);
    expect(() => runScript()).not.toThrow();
    expect(html().classList.contains("dark")).toBe(true); // system fallback
    expect(html().getAttribute("data-accent")).toBe("rose");
  });

  it("a blocked accent read still applies the stored theme", () => {
    installStorage({ "ns-theme": "dark" }, ["ns-accent"]);
    expect(() => runScript()).not.toThrow();
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().getAttribute("data-accent")).toBe("teal");
  });

  it("a fully blocked storage still applies system theme plus teal", () => {
    installStorage({}, ["ns-theme", "ns-accent"]);
    installMatchMedia(true);
    expect(() => runScript()).not.toThrow();
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().getAttribute("data-accent")).toBe("teal");
  });

  it("survives localStorage access throwing on the property itself", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    installMatchMedia(true);
    expect(() => runScript()).not.toThrow();
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().getAttribute("data-accent")).toBe("teal");
  });
});

describe("the script never writes", () => {
  it.each([
    ["nothing stored", {}],
    ["a valid pick", { "ns-theme": "dark", "ns-accent": "plum" }],
    ["a retired accent", { "ns-accent": "magenta" }],
  ])("performs no storage mutation with %s", (_label, values) => {
    installStorage(values);
    runScript();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("carries no legacy migration marker", () => {
    expect(THEME_SCRIPT_SOURCE).not.toContain("ns-accent-migrated");
    expect(THEME_SCRIPT_SOURCE).not.toContain("setItem");
    expect(THEME_SCRIPT_SOURCE).not.toContain("removeItem");
  });

  it("does not read the removed density key", () => {
    expect(THEME_SCRIPT_SOURCE).not.toContain("ns-density");
  });
});
