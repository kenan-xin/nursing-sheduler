// @vitest-environment jsdom
//
// The /design-system guide is DOCUMENTATION, and its content is the contract: it is the one
// page that states the rules the rest of the app embodies, so a reader who follows it must
// not be following v1.
//
// custom-AST ticket 3 moved these claims off a `readFileSync` of `app/design-system/page.tsx`
// and `toContain` over its JSX. That scan asked what the SOURCE spells; every claim here is
// about what the page SAYS, which is a rendered-content question and belongs to Testing
// Library. It is also stronger in a specific way: the old checks matched JSX fragments
// (`&lt;main&gt;`, a `{" "}` interpolation inside a sentence), so re-wrapping a paragraph
// could silently satisfy or silently break one without changing a word the reader sees.
//
// The one claim that did NOT move here is "authors no colour literal": that is authored
// provenance, not content, and a hand-typed swatch renders identically to a tokened one.
// It is the `authored-color-literal(-tsx)` ast-grep rule, which now covers this page along
// with every other file under `app/**` and `components/**`.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ThemeProvider } from "@/components/theme/theme-provider";
import DesignSystemPage from "./design-system/page";

const V2_ACCENTS = ["teal", "sage", "rose", "plum"];

// The guide embeds the real theme/accent controls, which are provider consumers -- the
// same provider the app's own layout mounts. Nothing here drives them; they are present
// because the page under test is the page, not a trimmed copy of it.
function renderGuide() {
  return render(
    <ThemeProvider>
      <DesignSystemPage />
    </ThemeProvider>,
  );
}

function guideText(): string {
  renderGuide();
  // Whitespace is normalised because the source's line wrapping is not part of the
  // contract: a sentence the reader sees as one line may be three in JSX.
  return (document.body.textContent ?? "").replace(/\s+/g, " ");
}

afterEach(() => {
  cleanup();
});

describe("the design-system guide publishes the v2 contract, not v1's", () => {
  it("offers exactly the four v2 accents, in order, and no retired one", () => {
    renderGuide();
    const rendered = [...document.querySelectorAll("[data-testid^='accent-card-']")].map((card) =>
      (card.getAttribute("data-testid") ?? "").replace("accent-card-", ""),
    );
    // Order matters: the guide is the reference for the control's own order.
    expect(rendered).toEqual(V2_ACCENTS);
  });

  it("publishes the accent derivation formulas and the order they must be declared in", () => {
    const text = guideText();
    expect(text).toContain("var(--brand) 82%, black");
    expect(text).toContain("var(--brand) 10%, var(--surface)");
    expect(text).toContain("var(--brand) 60%, white");
    expect(text).toContain("var(--brand) 26%, var(--surface)");
    // And it must explain the ORDER, which is the part a reader gets wrong.
    expect(text).toContain("static pair FIRST");
  });

  it("names no retired accent and no retired token", () => {
    const text = guideText();
    // `rose` is a live v2 accent, so the retired set is checked as accent NAMES in the
    // guide's own vocabulary rather than as bare substrings.
    for (const retired of ["magenta", "--accent-color", "--error-strong"]) {
      expect(text, retired).not.toContain(retired);
    }
    expect(text).not.toMatch(/plus blue, magenta and slate|blue, magenta, slate/);
  });

  it("describes radius as a ROLE, not as 0 everywhere", () => {
    const text = guideText();
    expect(text).toContain("A semantic role, not a global step");
    expect(text).not.toContain("0 everywhere");
    expect(text).not.toContain("every control in <main> must compute 0px");
  });

  it("describes the v2 toast, with the retired stripe called out as retired", () => {
    const text = guideText();
    expect(text).toContain("are both retired");
    // The v1 sentence, as the reader would have seen it.
    expect(text).not.toMatch(/a 3px --success left rule/);
  });

  it("documents the surface ladder and the className boundary it enforces", () => {
    const text = guideText();
    expect(text).toContain("surfaceVariants");
    expect(text).toContain("layout only");
    expect(text).toContain("surface-consumer-classname");
  });
});
