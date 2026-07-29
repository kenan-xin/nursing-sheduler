// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CardEditorForm, CardEditorHeader, CardListItem } from "./card-editor-shell";

// R4 fixup (ii7.14.1) — the three shared-shell heading recipes.
//
// The first cold review found all three still carrying v1 typography: 800 weight,
// -0.02em/-0.01em tracking, and a 1.05 display line. DESIGN.md §3 names one
// ladder for the heading faces, and the Negative-Tracking Rule fixes a SINGLE
// -0.015em for every heading-weight face — so three different tracking values
// across three heading sites was three separate violations of one rule, not a
// matter of taste.
//
// This guard is deliberately two-sided. Asserting only the new classes would pass
// a site that had ALSO kept `font-extrabold` (class order is not exclusivity, and
// `font-bold font-extrabold` resolves to whichever CSS wins, not to what the test
// read). So each site asserts the canonical trio is present AND that every retired
// v1 token is absent.

afterEach(() => cleanup());

/** The v1 recipes this fixup retires. None may return to the three sites below. */
const RETIRED = [
  "font-extrabold",
  "tracking-[-0.02em]",
  "tracking-[-0.01em]",
  "leading-[1.05]",
] as const;

function expectNoV1Typography(el: Element, where: string) {
  const classes = Array.from(el.classList);
  for (const retired of RETIRED) {
    expect(classes, `${where} reintroduced the retired v1 recipe "${retired}"`).not.toContain(
      retired,
    );
  }
}

const HEADER_PROPS = {
  eyebrow: "CONSTRAINT · TEST",
  title: "Staffing Requirements",
  subtitle: "A subtitle.",
  addLabel: "Add Requirement",
  formOpen: false,
  onAdd: () => {},
};

describe("card editor shell — v2 typography ladder (DESIGN.md §3)", () => {
  it("renders the page h1 as Display: 700 / 1.15 / -0.015em", () => {
    render(<CardEditorHeader {...HEADER_PROPS} />);
    const h1 = screen.getByRole("heading", { level: 1 });

    const classes = Array.from(h1.classList);
    expect(classes).toContain("font-heading");
    expect(classes).toContain("text-display");
    expect(classes).toContain("font-bold"); // 700 — v1 shipped 800
    expect(classes).toContain("leading-[1.15]"); // v1 shipped 1.05
    expect(classes).toContain("tracking-[-0.015em]");
    expectNoV1Typography(h1, "page h1");

    // The size utility is part of the contract this fixup must NOT change.
    expect(classes).toContain("text-display");
    expect(h1.textContent).toBe("Staffing Requirements");
  });

  it("renders the open-form heading as Headline: 600 / 1.2 / -0.015em", () => {
    render(
      <CardEditorForm
        heading="Add new covering"
        submitLabel="Add"
        onSubmit={() => {}}
        onCancel={() => {}}
      >
        <p>body</p>
      </CardEditorForm>,
    );
    const heading = screen.getByText("Add new covering");

    const classes = Array.from(heading.classList);
    expect(classes).toContain("font-heading");
    expect(classes).toContain("text-cardhead");
    expect(classes).toContain("font-semibold"); // 600 — v1 shipped 800
    // Explicit, because `--text-cardhead` is a size-only token: without it this
    // element inherits the body's 1.5 rather than the headline's 1.2.
    expect(classes).toContain("leading-[1.2]");
    expect(classes).toContain("tracking-[-0.015em]");
    // The brand-ink treatment of the form header is NOT part of this fixup.
    expect(classes).toContain("text-brandink");
    expectNoV1Typography(heading, "open-form heading");
  });

  it("renders the saved-card title as Title: 600 / 1.25 / -0.015em", () => {
    render(
      <ul>
        <CardListItem
          index={0}
          title="Untitled covering"
          fields={[{ label: "Dates", value: "(all)" }]}
          actions={<button type="button">Edit</button>}
        />
      </ul>,
    );
    const title = screen.getByText("Untitled covering");

    const classes = Array.from(title.classList);
    expect(classes).toContain("font-heading");
    expect(classes).toContain("text-title");
    expect(classes).toContain("font-semibold"); // 600 — v1 shipped 800
    expect(classes).toContain("leading-[1.25]"); // v1 shipped 1.15
    expect(classes).toContain("tracking-[-0.015em]"); // v1 shipped -0.01em
    expectNoV1Typography(title, "saved-card title");
  });

  it("gives the three heading sites ONE tracking value, not three", () => {
    // The rule this fixup exists to restore: every heading-weight face carries the
    // same -0.015em. Before, the h1 ran -0.02em, the form header -0.02em and the
    // card title -0.01em — so the same design token was spelled three ways and two
    // of them were the retired v1 value.
    render(<CardEditorHeader {...HEADER_PROPS} />);
    const h1 = screen.getByRole("heading", { level: 1 });
    cleanup();

    render(
      // The heading text is deliberately distinct from `submitLabel`: a heading of
      // "Add" also matches the footer's Add button, and `getByText` would then
      // resolve ambiguously rather than to the element under test.
      <CardEditorForm
        heading="Edit succession"
        submitLabel="Update"
        onSubmit={() => {}}
        onCancel={() => {}}
      >
        <p>body</p>
      </CardEditorForm>,
    );
    const formHeading = screen.getByText("Edit succession");
    cleanup();

    render(
      <ul>
        <CardListItem index={0} title="Card" fields={[]} actions={null} />
      </ul>,
    );
    const cardTitle = screen.getByText("Card");

    const tracking = (el: Element) =>
      Array.from(el.classList).filter((c) => c.startsWith("tracking-"));

    expect(tracking(h1)).toEqual(["tracking-[-0.015em]"]);
    expect(tracking(formHeading)).toEqual(["tracking-[-0.015em]"]);
    expect(tracking(cardTitle)).toEqual(["tracking-[-0.015em]"]);
  });

  it("steps weight DOWN from the page heading to the card title", () => {
    // Hierarchy is the reason the review flagged this: with every site at 800 the
    // card title competed with the page h1. Display is the only 700 of the three.
    render(<CardEditorHeader {...HEADER_PROPS} />);
    expect(Array.from(screen.getByRole("heading", { level: 1 }).classList)).toContain("font-bold");
    cleanup();

    render(
      <ul>
        <CardListItem index={0} title="Card" fields={[]} actions={null} />
      </ul>,
    );
    const cardTitle = screen.getByText("Card");
    expect(Array.from(cardTitle.classList)).toContain("font-semibold");
    expect(Array.from(cardTitle.classList)).not.toContain("font-bold");
  });
});
