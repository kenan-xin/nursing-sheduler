import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

// THE STATIC HALF OF THE ASSISTANT'S STYLE CONTRACT (t34.12.1.30).
//
// WHAT ACTUALLY ESCAPED, stated exactly, because this file exists to make that one
// mistake impossible rather than to describe styling in general:
//
//   `components/ai/assistant-surface.tsx` carried a comment saying the v2 stylesheet's
//   reset was active and scoped to `[data-copilotkit]`. It was not active. NO
//   production CSS entry imported `@copilotkit/react-core/v2/styles.css`, and although
//   the package imports `./index.css` from its own `dist/v2/index.mjs`, Next does not
//   process a stylesheet imported from inside an untranspiled node_modules package. A
//   production build with the assistant mounted emitted ZERO `[data-copilotkit]`
//   rules, so every `cpk:*` class in the library's markup was an inert string and the
//   shipped panel was unusable.
//
// WHAT THIS FILE OWNS, and only this: the INSTALLED PACKAGE BYTES and their integration
// with `app/globals.css`. Specifically -- the package still exports `./v2/styles.css` and
// the file that export points at exists; those bytes really do carry the scoped chat
// layout; that scoping cannot reach the rest of the app; and the token mapping in
// `globals.css` answers every custom property the package declares, at a specificity that
// outranks the package's own, with no literal values.
//
// WHAT IT DOES NOT OWN. It does not check that `app/layout.tsx` imports the stylesheet,
// nor where that import sits. Those belong elsewhere and are not repeated here:
//
//   * the sheet is imported EXACTLY ONCE, and only by `app/layout.tsx` -- Oxlint
//     `copilotkit-stylesheet-entry`, which closes the specifier repository-wide and
//     exempts that one file, so a second entry is unavailable rather than unspelled;
//   * the sheet is actually SHIPPED AND ACTIVE -- `e2e/ai-assistant-chat-ui.spec.ts`
//     against a real production build, which is the stronger proof because the defect
//     above was an import that was PRESENT and not processed;
//   * the import's ORDER relative to `./globals.css` is NOT asserted as a spelling
//     anywhere. Only its rendered consequence -- the token mapping winning -- is measured,
//     by that same browser suite.
//
// It is deliberately a READER of the installed package and of `globals.css`: no bundler,
// no browser, nothing that could pass because a mock behaved. It is one half of the
// picture and the browser suite is the other, but they are not two halves of the SAME
// claim -- this file answers "are the bytes right", the browser answers "did they reach
// the screen".
//
// WHAT THIS FILE NO LONGER DOES (custom-AST ticket 6 fixup, cold-review P1).
//
// It used to prove the IMPORT ITSELF by reading authored TypeScript as text: it read
// `app/layout.tsx` and string-matched the import statement and its position relative to
// `./globals.css`; it walked `app/` and `components/` recursively, opened every
// `.ts`/`.tsx`/`.mts` file and applied a hand-built import regex to find a second entry;
// and it read `components/ui/button.tsx` to string-match a JSX attribute. That was a
// repository-owned source analyzer of exactly the kind this migration exists to remove,
// and it sat behind the only production-source-read exception in the repository.
//
// The three guarantees moved OUT, each to a layer that can own it honestly:
//
//   1. "the stylesheet is actually shipped and active" -> `e2e/ai-assistant-chat-ui.spec.ts`
//      against a real production build. This is strictly stronger than reading the import
//      line: an import that is present but not processed -- WHICH IS THE EXACT DEFECT THIS
//      FILE WAS WRITTEN FOR -- passes a source match and fails the browser. Proved causal:
//      deleting the import from `app/layout.tsx` fails the light desktop case at the
//      transcript geometry assertion, and restoring it passes.
//   2. "nothing else imports it, so there is no second CSS entry" -> Oxlint
//      `no-restricted-imports`. The specifier is closed repository-wide and exempted at
//      `app/layout.tsx` alone, so a second entry is UNAVAILABLE rather than merely
//      unspelled -- and unlike the walk, that covers `import type`, aliases, re-export
//      chains and dynamic `import()`, in every directory rather than two.
//   3. "the app's own Button stamps `data-slot=\"button\"`, which is WHY the override needs
//      a CopilotKit-owned root" -> retired as a source assertion. It was documenting a
//      rationale, not guarding a failure: the scoping claim it motivates is asserted
//      directly below from the CSS bytes, and its consequence is measured by the browser
//      proof. Reading a component's source to check a comment is still true is not a
//      guarantee worth a source read.
//
// What remains here is package bytes and CSS, which is what an audited reader is for.

const WEB_ROOT = resolve(__dirname, "..", "..");

/** The one specifier. Written out here so a rename cannot silently satisfy this file. */
const STYLESHEET_SPECIFIER = "@copilotkit/react-core/v2/styles.css";
const PACKAGE_NAME = "@copilotkit/react-core";

const globalsSource = readFileSync(join(WEB_ROOT, "app", "globals.css"), "utf8");

/**
 * The installed stylesheet, resolved the way a bundler resolves it.
 *
 * Through the package's own `exports` map rather than by guessing `dist/v2/index.css`:
 * the point of asserting against the INSTALLED bytes is that the export we import is
 * the file we inspect, so a release that re-pointed the export would be caught here
 * instead of leaving this file auditing an orphan.
 */
function readInstalledStylesheet(): { path: string; css: string } {
  const require = createRequire(join(WEB_ROOT, "package.json"));
  const packageJsonPath = require.resolve(`${PACKAGE_NAME}/package.json`);
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const entry = manifest.exports?.["./v2/styles.css"];
  expect(
    typeof entry,
    `${PACKAGE_NAME} must still export "./v2/styles.css"; the import in app/layout.tsx depends on it`,
  ).toBe("string");
  const path = join(dirname(packageJsonPath), entry as string);
  expect(
    existsSync(path),
    `${STYLESHEET_SPECIFIER} resolves to ${path}, which does not exist`,
  ).toBe(true);
  return { path, css: readFileSync(path, "utf8") };
}

const stylesheet = readInstalledStylesheet();
const stylesheetRoot = postcss.parse(stylesheet.css, { from: stylesheet.path });

/** Keyframe steps are rules with selectors like `0%`; they are not page selectors. */
function isKeyframeStep(rule: Rule): boolean {
  // Walked structurally rather than through postcss's `parent` union, which widens to
  // `Document` and does not narrow usefully. The shape checked is the only one that
  // matters: an enclosing at-rule whose name ends in `keyframes`.
  let ancestor: unknown = rule.parent;
  while (ancestor && typeof ancestor === "object") {
    const node = ancestor as { type?: string; name?: string; parent?: unknown };
    if (node.type === "atrule" && (node.name ?? "").endsWith("keyframes")) return true;
    ancestor = node.parent;
  }
  return false;
}

/** Declarations that paint, as opposed to declaring a variable for something else to. */
function paintingDeclarations(rule: Rule): string[] {
  const painting: string[] = [];
  rule.each((node) => {
    if (node.type === "decl" && !node.prop.startsWith("--")) painting.push(node.prop);
  });
  return painting;
}

describe("the installed stylesheet carries the scoped chat layout", () => {
  it("defines rules under the [data-copilotkit] scope", () => {
    let scoped = 0;
    stylesheetRoot.walkRules((rule) => {
      if (rule.selector.includes("[data-copilotkit]")) scoped += 1;
    });
    expect(scoped).toBeGreaterThan(20);
  });

  it("defines the exact layout utilities whose absence broke the panel", () => {
    // Each of these is a class the library's own markup carries and the shipped panel
    // rendered without. Named individually rather than counted, because "the sheet is
    // big" is not the property that matters: `overflow-y-auto` is the transcript's
    // scroll bound, `absolute` pins the composer inside the panel, and
    // `grid-cols-[auto_minmax(0,1fr)_auto]` is the single composer row.
    const required = [
      "cpk\\:overflow-y-auto",
      "cpk\\:absolute",
      "cpk\\:grid-cols-\\[auto_minmax\\(0\\,1fr\\)_auto\\]",
      "cpk\\:flex-col",
      "cpk\\:items-end",
      "cpk\\:bg-muted",
      "cpk\\:rounded-full",
      "cpk\\:max-w-\\[80\\%\\]",
    ];
    const selectors: string[] = [];
    stylesheetRoot.walkRules((rule) => {
      selectors.push(rule.selector);
    });
    const joined = selectors.join("\n");
    const missing = required.filter((needle) => !joined.includes(needle));
    expect(missing, "the installed stylesheet no longer defines these layout classes").toEqual([]);
  });

  it("cannot paint outside the assistant subtree", () => {
    // THE SCOPING CLAIM, PROVEN FROM THE BYTES. `assistant-surface.tsx` has always
    // asserted this in a comment; the sheet is now imported at the ROOT of the app, so
    // it has to be an assertion. Any rule that paints must be reachable only through
    // the scope attribute or through a `cpk`-prefixed class the app never authors;
    // rules that declare nothing but custom properties cannot paint by themselves.
    const unscoped: string[] = [];
    stylesheetRoot.walkRules((rule) => {
      if (isKeyframeStep(rule)) return;
      if (paintingDeclarations(rule).length === 0) return;
      for (const selector of rule.selectors) {
        const reachableOnlyInsideAssistant =
          selector.includes("[data-copilotkit") ||
          selector.includes("[data-copilot-") ||
          selector.includes("[data-sidebar-chat") ||
          selector.includes(".cpk");
        if (!reachableOnlyInsideAssistant) unscoped.push(selector);
      }
    });
    expect(
      [...new Set(unscoped)],
      "these selectors paint and are not confined to the assistant subtree",
    ).toEqual([]);
  });
});

describe("globals.css answers every token the package declares", () => {
  /** Every custom property the package declares on the bare `[data-copilotkit]` scope. */
  const packageTokens = new Set<string>();
  stylesheetRoot.walkRules((rule) => {
    if (rule.selectors.some((selector) => selector.trim() === "[data-copilotkit]")) {
      rule.each((node) => {
        if (node.type === "decl" && node.prop.startsWith("--")) packageTokens.add(node.prop);
      });
    }
  });

  const globalsRoot = postcss.parse(globalsSource, { from: "app/globals.css" });
  let mapping: Rule | null = null;
  globalsRoot.walkRules((rule) => {
    const selectors = rule.selectors.map((selector) => selector.trim());
    if (selectors.includes("html [data-copilotkit]")) mapping = rule;
  });

  it("reads a non-empty token set from the package, so the check is not vacuous", () => {
    expect(packageTokens.size).toBeGreaterThan(20);
  });

  it("declares the mapping at a specificity that outranks the package's own", () => {
    expect(mapping, "app/globals.css must carry an `html [data-copilotkit]` mapping").not.toBe(
      null,
    );
    // The package declares its dark pair as `.dark [data-copilotkit]` at (0,2,0), which
    // outranks a bare `[data-copilotkit]`. Both halves of the mapping are needed or
    // dark mode silently keeps the library's near-black surfaces.
    expect(mapping!.selectors.map((selector) => selector.trim())).toEqual(
      expect.arrayContaining(["html [data-copilotkit]", "html.dark [data-copilotkit]"]),
    );
  });

  it("maps every package-declared token onto a runtime token", () => {
    const mapped = new Map<string, string>();
    mapping!.each((node) => {
      if (node.type === "decl" && node.prop.startsWith("--")) mapped.set(node.prop, node.value);
    });

    const unmapped = [...packageTokens].filter((token) => !mapped.has(token)).sort();
    expect(
      unmapped,
      "the package declares these on [data-copilotkit] and globals.css does not answer them, " +
        "so they keep the library's pure-white / near-black defaults inside the dock",
    ).toEqual([]);

    // And nothing in the mapping is a literal: a hex or an oklch() here would be a
    // second value layer for the assistant, which is what DESIGN.md forbids.
    const literals = [...mapped.entries()]
      .filter(([, value]) => !/^var\(--[a-z0-9-]+\)$/i.test(value.trim()))
      .map(([property, value]) => `${property}: ${value}`);
    expect(literals, "every mapped value must be a var() reference to a runtime token").toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The ownership boundary.
  //
  // `data-slot="button"` is NOT a CopilotKit-only marker: this app's own Button
  // stamps the identical attribute, and the scope wrapper encloses the whole panel.
  // Keyed on the attribute alone, the control overrides repainted every app-owned
  // control beneath the wrapper -- the primary proposal Apply became a ghost and the
  // `outline` variants lost their heavier `--rule` edge. The browser proof measures
  // the consequence; this pins the SHAPE of the selector, so the broad form cannot
  // come back without failing here first.
  // -------------------------------------------------------------------------

  it("scopes every control override to a CopilotKit-owned root", () => {
    // `copilot-chat` is `CopilotChatView`'s root and `copilot-message-list` is
    // `CopilotChatMessageView`'s. The app passes neither of them children, so nothing
    // app-owned can be inside either; every app-owned surface in the panel is a
    // sibling. Both are required -- a live thread renders the chat view, a read-only
    // thread renders the message view alone.
    const ROOTS = ['[data-testid="copilot-chat"]', '[data-testid="copilot-message-list"]'];
    const unscoped: string[] = [];
    let checked = 0;
    globalsRoot.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (!selector.includes("data-slot")) continue;
        checked += 1;
        const flattened = selector.replace(/\s+/g, " ");
        if (!ROOTS.every((root) => flattened.includes(root))) unscoped.push(flattened);
      }
    });
    // Non-vacuity: if the rules were renamed away from `data-slot` this would silently
    // check nothing at all.
    expect(checked, "no control override was found to check").toBeGreaterThan(3);
    expect(
      unscoped,
      "these control overrides are not confined to a CopilotKit-owned root, so they " +
        "also repaint app-owned Buttons beneath the assistant wrapper",
    ).toEqual([]);
  });

  it("keeps the send/Stop rule inside the same root, at a specificity that still wins", () => {
    // The send rule has to sit under the same root as the ghost rules: scoping the
    // ghost rules raised them to (0,3,2), so a send rule left at (0,2,2) would have
    // LOST its `--brand` fill to the ghost treatment. Same specificity plus a later
    // position is what keeps send primary.
    const sendSelectors: string[] = [];
    globalsRoot.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (selector.includes("copilot-send-button")) {
          sendSelectors.push(selector.replace(/\s+/g, " "));
        }
      }
    });
    expect(sendSelectors.length).toBeGreaterThan(0);
    for (const selector of sendSelectors) {
      expect(selector).toContain('[data-testid="copilot-chat"]');
    }
  });

  it("points the library's font names at this system's stacks", () => {
    const mapped = new Map<string, string>();
    mapping!.each((node) => {
      if (node.type === "decl" && node.prop.startsWith("--")) mapped.set(node.prop, node.value);
    });
    // All four. `--cpk-font-*` are read directly by the mono utilities;
    // `--cpk-default-*-font-family` are what the package's own reset reads, and they
    // are substituted at `:root` -- so mapping only the first pair changed nothing and
    // the whole dock rendered in `ui-sans-serif`.
    expect(mapped.get("--cpk-font-sans")).toBe("var(--ff-body)");
    expect(mapped.get("--cpk-font-mono")).toBe("var(--ff-mono)");
    expect(mapped.get("--cpk-default-font-family")).toBe("var(--ff-body)");
    expect(mapped.get("--cpk-default-mono-font-family")).toBe("var(--ff-mono)");
  });
});
