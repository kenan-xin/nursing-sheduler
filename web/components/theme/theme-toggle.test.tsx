// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "./theme-provider";
import { AccentControl, ThemeToggle } from "./theme-toggle";
import { ACCENTS, ACCENT_KEY, THEME_KEY, __resetForTests } from "./theme-store";

// F1 owns the four accepted accent values and the lifecycle wiring through the
// store. F2 owns the control itself: it is now a consumer of the shared Base UI
// ToggleGroup shell, and its swatch paint lives in the single CSS authority in
// globals.css rather than in an inline hex table here.

let setItem: ReturnType<typeof vi.fn>;

function installStorage() {
  const store = new Map<string, string>();
  setItem = vi.fn((key: string, value: string) => store.set(key, value));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem,
      removeItem: (key: string) => store.delete(key),
    },
  });
}

function renderControls() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <AccentControl />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  __resetForTests();
  document.documentElement.className = "";
  document.documentElement.setAttribute("data-accent", "teal");
  installStorage();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AccentControl offers exactly the four v2 accents", () => {
  it("renders one swatch per allowlisted accent, in order", () => {
    renderControls();
    const swatches = screen
      .getByRole("group", { name: "Accent" })
      .querySelectorAll("[data-accent-swatch]");
    expect([...swatches].map((el) => el.getAttribute("data-accent-swatch"))).toEqual([...ACCENTS]);
  });

  it.each([...ACCENTS])("the %s swatch declares its accent without painting it", (accent) => {
    renderControls();
    const swatch = document.querySelector(`[data-accent-swatch="${accent}"]`) as HTMLElement;
    expect(swatch).not.toBeNull();
    // The component names the CHOICE; globals.css owns the paint. An inline
    // background here would be a second source of truth for the accent table.
    expect(swatch.style.background).toBe("");
    expect(swatch.getAttribute("style")).toBeNull();
    // Decorative — the accessible name lives on the real control around it.
    expect(swatch).toHaveAttribute("aria-hidden");
  });

  it("authors no colour literal in the component", () => {
    const source = readFileSync(join(__dirname, "theme-toggle.tsx"), "utf8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
  });

  it("takes its membership and order from the store's allowlist, not a local table", () => {
    const source = readFileSync(join(__dirname, "theme-toggle.tsx"), "utf8");
    expect(source).toContain("ACCENTS.map");
    expect(source).not.toContain("ACCENT_SWATCHES");
  });

  it.each(["blue", "magenta", "slate"])("offers no retired %s swatch", (retired) => {
    renderControls();
    expect(document.querySelector(`[data-accent-swatch="${retired}"]`)).toBeNull();
  });

  it("labels each swatch for assistive tech", () => {
    renderControls();
    for (const accent of ACCENTS) {
      expect(screen.getByRole("button", { name: `${accent} accent` })).toBeInTheDocument();
    }
  });
});

describe("AccentControl is a Base UI ToggleGroup consumer", () => {
  it("renders one real toggle item per accent inside a labelled group", () => {
    renderControls();
    const group = screen.getByRole("group", { name: "Accent" });
    expect(group).toHaveAttribute("data-slot", "toggle-group");

    const items = group.querySelectorAll("[data-slot='toggle-group-item']");
    expect(items).toHaveLength(ACCENTS.length);
    for (const item of items) {
      // Real controls, not swatches with a hit area painted on: the pressable
      // element carries the size, so it can reach 44px on a coarse pointer.
      expect(item.tagName).toBe("BUTTON");
      expect(item.getAttribute("class")).toContain("pointer-coarse:min-h-touch");
      expect(item.getAttribute("class")).toContain("pointer-coarse:min-w-touch");
    }
  });

  it("drives selection from Base UI's own state, in controlled single-select", () => {
    document.documentElement.setAttribute("data-accent", "sage");
    renderControls();
    const sage = screen.getByRole("button", { name: "sage accent" });
    const plum = screen.getByRole("button", { name: "plum accent" });
    expect(sage).toHaveAttribute("data-pressed");
    expect(plum).not.toHaveAttribute("data-pressed");
    // Exactly one item is pressed — single-select, not a multi-toggle group.
    expect(document.querySelectorAll("[data-pressed]")).toHaveLength(1);
  });

  it("re-clicking the active accent PINS it rather than unsetting it", async () => {
    const user = userEvent.setup();
    renderControls();
    // teal is the default an unset accent renders as. Base UI emits an empty
    // array here; applying it verbatim would clear the choice.
    await user.click(screen.getByRole("button", { name: "teal accent" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("teal");
    expect(setItem.mock.calls).toEqual([[ACCENT_KEY, "teal"]]);
    expect(screen.getByRole("button", { name: "teal accent" })).toHaveAttribute("data-pressed");
  });

  it("moves focus with the arrow keys and activates without a pointer", async () => {
    const user = userEvent.setup();
    renderControls();
    const teal = screen.getByRole("button", { name: "teal accent" });
    teal.focus();
    expect(teal).toHaveFocus();

    // Base UI's roving focus: one tab stop, arrows move within the group.
    await user.keyboard("{ArrowRight}");
    const sage = screen.getByRole("button", { name: "sage accent" });
    expect(sage).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(document.documentElement.getAttribute("data-accent")).toBe("sage");
    expect(setItem.mock.calls).toEqual([[ACCENT_KEY, "sage"]]);
  });
});

describe("lifecycle wiring", () => {
  it("reflects the pre-painted accent after adoption", () => {
    document.documentElement.setAttribute("data-accent", "plum");
    renderControls();
    expect(screen.getByRole("button", { name: "plum accent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "teal accent" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("falls back to teal when the pre-painted accent is unsupported", () => {
    document.documentElement.setAttribute("data-accent", "magenta");
    renderControls();
    expect(screen.getByRole("button", { name: "teal accent" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it.each(ACCENTS)("selecting %s updates the DOM and persists only that axis", async (accent) => {
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByRole("button", { name: `${accent} accent` }));
    expect(document.documentElement.getAttribute("data-accent")).toBe(accent);
    expect(setItem.mock.calls).toEqual([[ACCENT_KEY, accent]]);
  });

  it("keeps the accent choice across a theme change, writing no colour", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByRole("button", { name: "rose accent" }));
    await user.click(screen.getByRole("button", { name: /switch to dark theme/i }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-accent")).toBe("rose");
    expect(setItem.mock.calls).toEqual([
      [ACCENT_KEY, "rose"],
      [THEME_KEY, "dark"],
    ]);
  });
});

describe("ThemeToggle", () => {
  it("announces the theme it switches TO", async () => {
    const user = userEvent.setup();
    renderControls();
    const toggle = screen.getByRole("button", { name: /switch to dark theme/i });
    await user.click(toggle);
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });

  it("reflects a pre-painted dark theme after adoption", () => {
    document.documentElement.classList.add("dark");
    renderControls();
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeInTheDocument();
  });

  it("persists only ns-theme", async () => {
    const user = userEvent.setup();
    renderControls();
    await user.click(screen.getByRole("button", { name: /switch to dark theme/i }));
    expect(setItem.mock.calls).toEqual([[THEME_KEY, "dark"]]);
  });
});
