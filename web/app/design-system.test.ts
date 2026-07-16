import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Design-system acceptance checks verifiable statically (token snapshot,
// accent/shell token port, radius-0 declarations, icon-import guard, and a
// raw-color source guard over components/ui/**). Render / viewport / density /
// reduced-motion / hydration rows are covered by e2e/design-system.spec.ts.

const webRoot = join(__dirname, "..");
const globals = readFileSync(join(__dirname, "globals.css"), "utf8");

// README color tokens (light + dark) that are declared as literal hex. brand /
// brandink / brandtint are NOT here — they derive from --accent-color via
// color-mix and are asserted separately below.
const LIGHT_TOKENS: Record<string, string> = {
  ink: "#14161b",
  ink2: "#4a515c",
  ink3: "#8b929c",
  faint: "#aab0ba",
  bg: "#fbfcfd",
  surface: "#ffffff",
  panel: "#f2f4f7",
  line: "#c8cdd5",
  line2: "#e2e5ea",
  success: "#1f9a5c",
  warn: "#b07d10",
  error: "#d94032",
};

const DARK_TOKENS: Record<string, string> = {
  ink: "#eef1f4",
  ink2: "#9aa3b0",
  ink3: "#6b7585",
  bg: "#13171e",
  surface: "#181d25",
  panel: "#1d242e",
  line: "#313a46",
  line2: "#262e38",
  success: "#5fcf94",
  warn: "#d6a743",
  error: "#e06a5e",
};

// Shell tokens from Nurse Scheduling.dc.html:21-24,36,40-43.
const LIGHT_SHELL: Record<string, string> = {
  "panel-alt": "#f1f3f6",
  sidebar: "#ffffff",
  chrome: "#14161b",
  "sidebar-w": "280px",
};

const DARK_SHELL: Record<string, string> = {
  "panel-alt": "#1d242e",
  sidebar: "#13171e",
  chrome: "#0f1319",
};

function sliceBlock(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `expected selector ${selector} in globals.css`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open, close);
}

describe("token port — light theme", () => {
  const root = sliceBlock(globals, ":root {");
  for (const [token, hex] of Object.entries({ ...LIGHT_TOKENS, ...LIGHT_SHELL })) {
    it(`--${token} = ${hex}`, () => {
      expect(root).toContain(`--${token}: ${hex};`);
    });
  }
});

describe("token port — dark theme", () => {
  const dark = sliceBlock(globals, ".dark {");
  for (const [token, hex] of Object.entries({ ...DARK_TOKENS, ...DARK_SHELL })) {
    it(`--${token} = ${hex}`, () => {
      expect(dark).toContain(`--${token}: ${hex};`);
    });
  }
});

describe("selectable-accent axis (README line 116)", () => {
  const root = sliceBlock(globals, ":root {");
  const dark = sliceBlock(globals, ".dark {");

  it("default accent is #2360c4", () => {
    expect(root).toContain("--accent-color: #2360c4;");
  });

  it("brand tracks the accent", () => {
    expect(root).toContain("--brand: var(--accent-color);");
    expect(dark).toContain("--brand: var(--accent-color);");
  });

  it("light derives brandink/brandtint via color-mix (accent, 9% tint)", () => {
    expect(root).toContain("--brandink: var(--accent-color);");
    expect(root).toContain("--brandtint: color-mix(in srgb, var(--accent-color) 9%, #ffffff);");
  });

  it("dark lightens brandink (60%) and darkens brandtint (26%)", () => {
    expect(dark).toContain("--brandink: color-mix(in srgb, var(--accent-color) 60%, #ffffff);");
    expect(dark).toContain("--brandtint: color-mix(in srgb, var(--accent-color) 26%, #13171e);");
  });

  it.each([
    ["teal", "#0e7490"],
    ["magenta", "#b0357a"],
    ["slate", "#3f4a63"],
  ])("[data-accent=%s] sets --accent-color: %s", (name, hex) => {
    expect(globals).toContain(`[data-accent="${name}"]`);
    expect(globals).toContain(`--accent-color: ${hex};`);
  });
});

describe("radius", () => {
  it("every radius token resolves to 0px", () => {
    const radii = globals.match(/--radius[\w-]*:\s*[^;]+;/g) ?? [];
    expect(radii.length).toBeGreaterThan(0);
    for (const decl of radii) {
      expect(decl).toMatch(/:\s*0px;/);
    }
  });
});

describe("breakpoint ladder", () => {
  for (const bp of ["480px", "768px", "1024px", "1280px", "1440px", "1920px"]) {
    it(`type scale steps at ${bp}`, () => {
      expect(globals).toContain(`(min-width: ${bp})`);
    });
  }
});

describe("density presets", () => {
  it.each([
    ["spacious", "1.16"],
    ["compact", "0.9"],
  ])("[data-density=%s] → --density: %s", (name, value) => {
    const block = sliceBlock(globals, `[data-density="${name}"]`);
    expect(block).toContain(`--density: ${value};`);
  });
});

describe("motion + skeleton", () => {
  it("defines the shimmer animation token", () => {
    expect(globals).toContain("--animate-shimmer");
    expect(globals).toContain("@keyframes ns-shimmer");
  });
  it("suppresses motion under prefers-reduced-motion", () => {
    expect(globals).toContain("prefers-reduced-motion: reduce");
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("icon convention (react-icons fa6, no Lucide)", () => {
  const sources = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "components"))];

  it("no source file imports lucide-react", () => {
    const offenders = sources.filter((f) =>
      /from\s+["']lucide-react["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders, `lucide-react imported in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("icons come from react-icons/fa6 via the barrel", () => {
    expect(readFileSync(join(webRoot, "components", "icons.tsx"), "utf8")).toContain(
      'from "react-icons/fa6"',
    );
  });
});

describe("no raw colors in components/ui/**", () => {
  const uiFiles = walk(join(webRoot, "components", "ui")).filter((f) => f.endsWith(".tsx"));

  // Raw color literals (hex / rgb() / hsl()) and Tailwind default-palette color
  // utilities — either would bypass the token layer. Components must reference
  // only the design tokens (bg-brand, text-ink, border-line, …).
  const HEX = /#[0-9a-fA-F]{3,8}\b/;
  const FUNC = /\b(?:rgb|rgba|hsl|hsla)\(/;
  const PALETTE =
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|caret|accent)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/;

  it("scans at least the authored components", () => {
    expect(uiFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(
    [HEX, FUNC, PALETTE].map(
      (re, i) => [["hex", "color-function", "palette-utility"][i], re] as const,
    ),
  )("no %s color literal", (_label, re) => {
    const offenders = uiFiles.filter((f) => re.test(readFileSync(f, "utf8")));
    expect(
      offenders,
      `raw color in: ${offenders.map((f) => f.replace(webRoot, "")).join(", ")}`,
    ).toEqual([]);
  });
});
