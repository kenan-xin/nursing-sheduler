// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useScenarioStore, scenarioCommands } from "@/lib/store";
import { changeKeys } from "@/lib/change-highlight/keys";
import { clearChangeHighlight, showChangeHighlight } from "@/lib/change-highlight/store";
import { RulesScreen } from "./rules-screen";
import { drainScenarioCommands, resetScenarioForTest, undoDepth } from "@/lib/store/test-authority";

/**
 * Let a fired interaction's durable command settle. T03: a row's toggle, Adjust
 * blur and rename all issue a repository command, so the committed projection and
 * the re-render land a microtask after the event — draining inside `act` is the
 * deterministic seam, not a timeout.
 */
async function settle() {
  await act(async () => {
    await drainScenarioCommands();
  });
}

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/rules",
}));

beforeEach(async () => {
  pushMock.mockClear();
  await resetScenarioForTest();
});

afterEach(async () => {
  cleanup();
});

async function seedRequirement() {
  await scenarioCommands.mutate((state) => ({
    cardsByKind: {
      ...state.cardsByKind,
      requirements: [
        { uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1, description: "Day cap" },
      ],
    },
  }));
}

describe("RulesScreen — empty scenario", () => {
  it("always shows the built-in structural rule, locked and enabled", async () => {
    render(<RulesScreen />);
    expect(screen.getByText("At most one shift per day")).toBeInTheDocument();
    const row = screen.getByTestId(/rule-row-builtin/);
    expect(within(row).getByText(/built-in/i)).toBeInTheDocument();
  });

  it("shows the empty state when no advanced constraints exist", async () => {
    render(<RulesScreen />);
    expect(screen.getByTestId("rules-empty-state")).toBeInTheDocument();
  });
});

describe("RulesScreen — a linked (auto-derived) rule row", () => {
  beforeEach(async () => {
    await seedRequirement();
  });

  it("derives a row from the card with its own description as title", async () => {
    render(<RulesScreen />);
    expect(screen.getByText("Day cap")).toBeInTheDocument();
  });

  it("toggling the switch off writes the card's disabled marker", async () => {
    render(<RulesScreen />);
    const toggle = screen.getByTestId("rule-toggle-requirements:r1");
    fireEvent.click(toggle);
    await settle();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].disabled).toBe(true);
  });

  it("Adjust opens the quick-edit panel and commits a valid value on blur", async () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    fireEvent.change(input, { target: { value: "5" } });
    // Typing alone must not write the store — the commit happens on blur.
    await settle();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
    fireEvent.blur(input, { target: { value: "5" } });
    await settle();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(5);
  });

  it("commits a multi-digit Adjust value as exactly one undo entry (no per-keystroke commit)", async () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    const before = await undoDepth();
    // Type "15" over "2": intermediate "1" must never reach the store or history.
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "15" } });
    await settle();
    expect(await undoDepth()).toBe(before);
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
    fireEvent.blur(input, { target: { value: "15" } });
    await settle();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(15);
    expect(await undoDepth()).toBe(before + 1);
    // A single Undo returns to the pre-edit value (2), never an intermediate "1".
    await scenarioCommands.undo();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
  });

  it("shows a live error while typing an invalid value but does not commit until valid", async () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    const before = await undoDepth();
    fireEvent.change(input, { target: { value: "-1" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.blur(input, { target: { value: "-1" } });
    await settle();
    // An invalid draft never commits, on change or blur.
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
    expect(await undoDepth()).toBe(before);
  });

  it("Adjust shows a validation error for an invalid value and does not commit it", async () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const input = screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople");
    fireEvent.change(input, { target: { value: "-1" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await settle();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].requiredNumPeople).toBe(2);
  });

  it("records the toggle/adjust as tracked mutations (undo restores)", async () => {
    render(<RulesScreen />);
    const before = await undoDepth();
    fireEvent.click(screen.getByTestId("rule-toggle-requirements:r1"));
    await settle();
    expect(await undoDepth()).toBe(before + 1);
  });
});

describe("RulesScreen — a hard-weight (±Infinity) Adjust control", () => {
  async function seedSuccession(weight: number) {
    await scenarioCommands.mutate((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        successions: [
          { uid: "s1", person: ["P1"], pattern: ["N", "D"], weight, description: "No N→D" },
        ],
      },
    }));
  }

  it("renders a hard (-Infinity) weight legibly rather than as a blank box", async () => {
    await seedSuccession(-Infinity);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    const input = screen.getByTestId("rule-adjust-input-successions:s1-weight") as HTMLInputElement;
    expect(input.value).toBe("-Infinity");
    expect(input.value).not.toBe("");
  });

  it("keeps a hard weight on blur without downgrading it to a finite value", async () => {
    await seedSuccession(-Infinity);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    const input = screen.getByTestId("rule-adjust-input-successions:s1-weight");
    // Blur with the untouched draft — the hard weight must survive, not become 0/NaN.
    fireEvent.blur(input, { target: { value: (input as HTMLInputElement).value } });
    await settle();
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(-Infinity);
  });

  it("switches soft→hard and preserves the Infinity sign", async () => {
    await seedSuccession(-2);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    fireEvent.click(screen.getByTestId("rule-adjust-minus-inf-successions:s1-weight"));
    await settle();
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(-Infinity);
    fireEvent.click(screen.getByTestId("rule-adjust-plus-inf-successions:s1-weight"));
    await settle();
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(Infinity);
  });

  it("switches hard→soft by typing a finite weight, as one undo entry", async () => {
    await seedSuccession(Infinity);
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));
    const input = screen.getByTestId("rule-adjust-input-successions:s1-weight");
    const before = await undoDepth();
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.blur(input, { target: { value: "25" } });
    await settle();
    expect(useScenarioStore.getState().cardsByKind.successions[0].weight).toBe(25);
    expect(await undoDepth()).toBe(before + 1);
  });
});

describe("RulesScreen — categories", () => {
  it("renders the six plain-English headings in order when every kind is present", async () => {
    await scenarioCommands.mutate({
      cardsByKind: {
        requirements: [{ uid: "r1", shiftType: "D", requiredNumPeople: 2, weight: -1 }],
        successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -1 }],
        counts: [
          {
            uid: "c1",
            person: "ALL",
            countDates: "ALL",
            countShiftTypes: "N",
            expression: "x >= T",
            target: 3,
            weight: 1,
          },
        ],
        affinities: [
          {
            uid: "a1",
            people1: ["P1"],
            people2: ["P2"],
            shiftTypes: ["D"],
            date: "ALL",
            weight: 1,
          },
        ],
        coverings: [
          { uid: "v1", preceptors: ["P1"], preceptees: ["P2"], shiftTypes: ["D"], weight: -1 },
        ],
      },
    });
    render(<RulesScreen />);
    const headings = screen
      .getAllByTestId(/^rule-category-/)
      .map((el) => el.getAttribute("data-testid")!.replace("rule-category-", ""));
    expect(headings).toEqual([
      "Always on",
      "Staffing levels",
      "Shift sequences",
      "Hours & contracts",
      "Who works together",
      "Supervision",
    ]);
  });

  it("has no Customise library affordance left anywhere on the screen", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    expect(screen.queryByTestId("rules-admin-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rules-new-pin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rules-stale-pin-notice")).not.toBeInTheDocument();
    expect(screen.queryByText(/customise library/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bpin\b/i)).not.toBeInTheDocument();
  });
});

describe("RulesScreen — renaming a rule", () => {
  /** Open the rename input on `rowId`, type `title`, save, and let it settle. */
  async function renameRow(rowId: string, title: string) {
    fireEvent.click(screen.getByTestId(`rule-rename-${rowId}`));
    fireEvent.change(screen.getByTestId(`rule-rename-input-${rowId}`), {
      target: { value: title },
    });
    fireEvent.click(screen.getByTestId(`rule-rename-save-${rowId}`));
    await settle();
  }

  it("renames a card row by writing the source constraint's own description", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    await renameRow("requirements:r1", "Day shift cover");

    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe(
      "Day shift cover",
    );
    expect(screen.getByText("Day shift cover")).toBeInTheDocument();
  });

  it("renames the locked built-in row, which cannot be switched off but can be relabelled", async () => {
    render(<RulesScreen />);
    const rowId = "builtin:max-one-shift-per-day";
    expect(screen.getByTestId(`rule-toggle-${rowId}`)).toHaveAttribute("aria-disabled", "true");
    await renameRow(rowId, "One shift a day");

    expect(useScenarioStore.getState().maxOneShiftPerDay?.description).toBe("One shift a day");
    expect(screen.getByText("One shift a day")).toBeInTheDocument();
  });

  it("renames a read-only 'Set in Advanced only' row, whose shape it cannot affect", async () => {
    await scenarioCommands.mutate((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: [{ uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 }],
      },
    }));
    render(<RulesScreen />);
    await renameRow("requirements:r2", "Day and night cover");

    const card = useScenarioStore.getState().cardsByKind.requirements[0];
    expect(card.description).toBe("Day and night cover");
    // Renaming never converts the record into a Guided-editable shape.
    expect(screen.getByText(/adjust it in Advanced/i)).toBeInTheDocument();
    expect(screen.queryByTestId("rule-adjust-toggle-requirements:r2")).not.toBeInTheDocument();
  });

  it("an unchanged title writes nothing at all", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    const before = await undoDepth();
    const stateBefore = useScenarioStore.getState().cardsByKind;

    await renameRow("requirements:r1", "Day cap");

    expect(await undoDepth()).toBe(before);
    expect(useScenarioStore.getState().cardsByKind).toBe(stateBefore);
  });

  it("a rename is exactly one undo entry, and Undo restores the previous title", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    const before = await undoDepth();

    await renameRow("requirements:r1", "Day shift cover");

    expect(await undoDepth()).toBe(before + 1);
    await scenarioCommands.undo();
    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
  });

  it("cancelling leaves the title untouched", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-rename-requirements:r1"));
    fireEvent.change(screen.getByTestId("rule-rename-input-requirements:r1"), {
      target: { value: "Never saved" },
    });
    fireEvent.click(screen.getByTestId("rule-rename-cancel-requirements:r1"));
    await settle();

    expect(useScenarioStore.getState().cardsByKind.requirements[0].description).toBe("Day cap");
    expect(screen.getByText("Day cap")).toBeInTheDocument();
  });
});

describe("RulesScreen — unsupported (advanced-shaped) records", () => {
  it("shows a locked read-only fallback instead of hiding or flattening the record", async () => {
    await scenarioCommands.mutate((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: [{ uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 }],
      },
    }));
    render(<RulesScreen />);
    expect(screen.getByTestId("rule-row-requirements:r2")).toBeInTheDocument();
    expect(screen.queryByTestId("rule-adjust-toggle-requirements:r2")).not.toBeInTheDocument();
    expect(screen.getByText(/adjust it in Advanced/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R3 — the v2 presentation contract.
//
// The browser matrix judges /rules in light and dark at both pointer densities,
// but it judges RESOLVED paint: a surface that forgot its role reads as "nothing
// to report" to an analytic scanner rather than as a failure, and a control that
// lost its coarse-pointer floor is only visible in the touch project. The classes
// that make those claims true are authored here, so they are pinned here — along
// with the v1 presentation this ticket removes, which is invisible unless a test
// names it.
// ---------------------------------------------------------------------------

describe("RulesScreen — v2 surface ladder", () => {
  it("paints the screen root as the L0 page plane through the shared recipe", async () => {
    render(<RulesScreen />);
    const root = screen.getByTestId("screen");
    // F4's R3 row declares this element `role: page`, which resolves to --bg with
    // no elevation. A transparent root computes rgba(0, 0, 0, 0) and the runtime
    // scanner cannot judge that as the page tone.
    expect(root.getAttribute("data-slot")).toBe("surface");
    expect(root.getAttribute("data-level")).toBe("page");
    expect(classesOf(root)).toContain("bg-bg");
    expect(classesOf(root)).not.toMatch(/\bshadow-[123]\b/);
  });

  it("rests the on-count summary on L1 at the control radius, not as a well", async () => {
    render(<RulesScreen />);
    const chip = screen.getByText(/OF \d+ RULES ON/).parentElement!;
    // DESIGN.md §4 puts wells INSIDE an L1 card; this island sits on the page.
    expect(classesOf(chip)).toContain("bg-surface");
    expect(classesOf(chip)).toContain("border-line");
    expect(classesOf(chip)).toContain("shadow-1");
    expect(classesOf(chip)).toContain("rounded-control");
    expect(classesOf(chip)).not.toContain("shadow-well");
  });

  it("gives the advanced-records strip the inset well role, never an outer shadow", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    const strip = screen.getByTestId("rules-open-advanced-banner").parentElement!;
    expect(strip.getAttribute("data-level")).toBe("well");
    expect(classesOf(strip)).toContain("bg-panel");
    expect(classesOf(strip)).toContain("shadow-well");
    // Direction of light is fixed (DESIGN.md §4 rule 1).
    expect(classesOf(strip)).not.toMatch(/\bshadow-[123]\b/);
  });

  it("makes each category list one resting L1 card that clips its square rows", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    const list = classesOf(screen.getByTestId("rule-category-Staffing levels"));
    expect(list).toContain("rounded-card");
    expect(list).toContain("bg-surface");
    expect(list).toContain("border-line");
    expect(list).toContain("shadow-1");
    // Without the clip, the first row's square top edge cuts the card's corners.
    expect(list).toContain("overflow-hidden");
  });

  it("rounds the empty state as a card while keeping dashed as the zero-data edge", async () => {
    render(<RulesScreen />);
    const empty = classesOf(screen.getByTestId("rules-empty-state"));
    expect(empty).toContain("rounded-card");
    expect(empty).toContain("border-dashed");
    expect(empty).toContain("bg-surface");
    // v1's off-token 1.5px edge is retired with the rest of the flat system.
    expect(empty).not.toContain("border-[1.5px]");
  });

  it("tracks R3-owned headings at the v2 -0.015em rather than a globals default", async () => {
    render(<RulesScreen />);
    const heading = classesOf(screen.getByRole("heading", { level: 1 }));
    expect(heading).toContain("tracking-[-0.015em]");
    expect(heading).not.toContain("tracking-[-0.02em]");
    expect(heading).not.toContain("font-extrabold");
  });
});

describe("RulesScreen — rule-row state and status pairs", () => {
  async function seedDisabledRequirement() {
    await scenarioCommands.mutate((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: [
          {
            uid: "r1",
            shiftType: "D",
            requiredNumPeople: 2,
            weight: -1,
            description: "Day cap",
            disabled: true,
          },
        ],
      },
    }));
  }

  it("keeps a row's divider a square single edge, never a rounded box", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    const row = classesOf(screen.getByTestId("rule-row-requirements:r1"));
    expect(row).toContain("border-t");
    expect(row).toContain("border-line2");
    expect(row).toContain("first:border-t-0");
    expect(row).not.toMatch(/\brounded-(card|control|chip|pill)\b/);
  });

  it("recedes a switched-off row in TONE instead of fading it with opacity", async () => {
    await seedDisabledRequirement();
    render(<RulesScreen />);
    const row = screen.getByTestId("rule-row-requirements:r1");
    expect(row.getAttribute("data-disabled")).toBe("true");
    expect(classesOf(row)).toContain("bg-panel");
    // v1 used `opacity-60`, which dims the row's text with its box and costs
    // every label in it the contrast it just cleared.
    expect(classesOf(row)).not.toMatch(/\bopacity-\d+\b/);
  });

  it("leaves an enabled row on the card's own L1 plane", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    expect(classesOf(screen.getByTestId("rule-row-requirements:r1"))).not.toContain("bg-panel");
  });

  it("pairs the ON/OFF chip on chip geometry with a neutral hairline, not the selection language", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    const on = classesOf(within(screen.getByTestId("rule-row-requirements:r1")).getByText("ON"));
    expect(on).toContain("rounded-chip");
    expect(on).toContain("border-line");
    expect(on).toContain("bg-brandtint");
    expect(on).toContain("text-brandink");
    // DESIGN.md §6 reserves --brandtint WITH a --brand border for selection; an
    // enabled rule is the ordinary state, not "this is the one".
    expect(on).not.toContain("border-brand");

    cleanup();
    await seedDisabledRequirement();
    render(<RulesScreen />);
    const off = classesOf(within(screen.getByTestId("rule-row-requirements:r1")).getByText("OFF"));
    expect(off).toContain("rounded-chip");
    // The hairline is what keeps OFF legible once the row itself is --panel.
    expect(off).toContain("border-line");
    expect(off).toContain("bg-panel");
    expect(off).toContain("text-ink2");
  });

  it("marks a built-in through the shared Badge recipe and drops the padlock ornament", async () => {
    render(<RulesScreen />);
    const row = screen.getByTestId("rule-row-builtin:max-one-shift-per-day");
    const badge = within(row).getByText("Built-in");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.getAttribute("data-variant")).toBe("neutral");
    expect(classesOf(badge)).toContain("rounded-chip");
    expect(classesOf(badge)).toContain("uppercase");
    // `locked` is true exactly when a row is a built-in, so v1's unlabelled
    // padlock beside the title duplicated this badge with a glyph that had no
    // accessible name (DESIGN.md §5 retires ornament on status).
    expect(within(row).queryByTitle("Always on")).not.toBeInTheDocument();
  });
});

describe("RulesScreen — the adjustment band", () => {
  beforeEach(async () => await seedRequirement());

  it("is a full-bleed square band on the --panel tone with a dashed top edge", async () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    const band = classesOf(screen.getByTestId("rule-adjust-panel-requirements:r1"));
    expect(band).toContain("bg-panel");
    expect(band).toContain("border-t");
    expect(band).toContain("border-dashed");
    // A full-bleed band is square by contract (DESIGN.md §4 rule 2); a radius
    // here would leave a sliver of the card's own plane in each corner.
    expect(band).toContain("rounded-none");
  });

  it("exposes the Adjust toggle as a real disclosure over the band", async () => {
    render(<RulesScreen />);
    const toggle = screen.getByTestId("rule-adjust-toggle-requirements:r1");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");

    fireEvent.click(toggle);
    const band = screen.getByTestId("rule-adjust-panel-requirements:r1");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.getAttribute("aria-controls")).toBe(band.id);
  });

  it("reports a validation error in the semantic ink tier, not the base hue", async () => {
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-requirements:r1"));
    fireEvent.change(screen.getByTestId("rule-adjust-input-requirements:r1-requiredNumPeople"), {
      target: { value: "-1" },
    });
    const alert = classesOf(screen.getByRole("alert"));
    // DESIGN.md §2 makes the ink tier the deepest treatment; error TEXT on a
    // --panel band needs it to clear AA.
    expect(alert).toContain("text-errorink");
    expect(alert).not.toMatch(/\btext-error\b/);
  });
});

describe("RulesScreen — real controls at the coarse-pointer floor", () => {
  it("builds the ±∞ weight affordances from the shared Button contract", async () => {
    await scenarioCommands.mutate((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        successions: [{ uid: "s1", person: ["P1"], pattern: ["N", "D"], weight: -2 }],
      },
    }));
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-adjust-toggle-successions:s1"));

    for (const testId of [
      "rule-adjust-plus-inf-successions:s1-weight",
      "rule-adjust-minus-inf-successions:s1-weight",
    ]) {
      const button = screen.getByTestId(testId);
      expect(button.getAttribute("data-slot")).toBe("button");
      // `h-control-sm` is the absolute 32px token; v1's `h-9` resolves through
      // the 0.9 density baseline to 32.4px and carried no touch floor at all.
      expect(classesOf(button)).toContain("h-control-sm");
      expect(classesOf(button)).not.toContain("h-9");
      expect(classesOf(button)).toContain("pointer-coarse:min-h-touch");
      expect(classesOf(button)).toContain("pointer-coarse:min-w-touch");
    }
  });

  it("gives the inline text affordances the 44px floor without a pseudo-element hitbox", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    for (const testId of ["rule-rename-requirements:r1", "rule-open-advanced-requirements:r1"]) {
      const classes = classesOf(screen.getByTestId(testId));
      // T8: the real control grows; nothing simulates the target with `after:`.
      expect(classes).toContain("pointer-coarse:min-h-touch");
      expect(classes).toContain("pointer-coarse:min-w-touch");
      expect(classes).not.toMatch(/\bafter:/);
    }
  });

  it("leaves the rename field on its own absolute control height", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    fireEvent.click(screen.getByTestId("rule-rename-requirements:r1"));
    const input = screen.getByTestId("rule-rename-input-requirements:r1");
    // v1 forced `h-8`, which the repaired tailwind-merge now really applies as
    // 28.8px — under the 32px floor and off-token.
    expect(classesOf(input)).not.toMatch(/\bh-8\b/);
    expect(classesOf(input)).toContain("h-control");
    expect(classesOf(input)).toContain("pointer-coarse:min-h-touch");
  });

  it("hands an unsupported record off through a real control below its reason", async () => {
    await scenarioCommands.mutate((state) => ({
      cardsByKind: {
        ...state.cardsByKind,
        requirements: [{ uid: "r2", shiftType: ["D", "N"], requiredNumPeople: 1, weight: -1 }],
      },
    }));
    render(<RulesScreen />);
    const handoff = screen.getByTestId("rule-open-advanced-unsupported-requirements:r2");
    expect(handoff.getAttribute("data-slot")).toBe("button");
    expect(classesOf(handoff)).toContain("pointer-coarse:min-h-touch");

    // The note strip keeps a hairline: the row's own tone is --panel too once the
    // rule is switched off, so tone alone cannot define this box.
    const strip = classesOf(handoff.parentElement);
    expect(strip).toContain("rounded-control");
    expect(strip).toContain("border-line2");
    expect(strip).toContain("bg-panel");
  });
});

describe("RulesScreen — change highlight", () => {
  afterEach(() => clearChangeHighlight());
  it("RulesScreen outlines the rule row an Apply changed, never a built-in", async () => {
    await seedRequirement();
    render(<RulesScreen />);
    act(() => showChangeHighlight([changeKeys.rule("requirements", "r1")]));
    expect(screen.getByTestId("rule-row-requirements:r1")).toHaveAttribute(
      "data-change-highlight",
      "true",
    );
    expect(screen.getByTestId(/rule-row-builtin/)).not.toHaveAttribute("data-change-key");
  });
});
