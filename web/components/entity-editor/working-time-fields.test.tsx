// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { surfaceVariants } from "@/components/ui/surface";
import { WorkingTimeFields } from "./working-time-fields";
import type { WorkingTimeValue } from "./core";

// Focused contract for the shift-type working-time sub-form. R2c is its sole
// visual owner (Shift Types is the only live UI consumer), and until now it had
// no focused suite at all — every claim about it was carried indirectly by
// `shift-type-grid.test.tsx`, which drives it through the card editor and
// therefore cannot distinguish a sub-form defect from a card defect.
//
// Two halves, deliberately:
//   • SEMANTICS — real native controls with accessible names, the 30-minute grid,
//     the write-back of the derived `durationMinutes`, and the validator's own
//     messages. These are behaviour and must not move under the re-skin.
//   • PRESENTATION — which contract authored each surface, the absolute control
//     height, the coarse-pointer floor and the status pairing. jsdom applies no
//     stylesheet, so RESOLVED geometry and tone are measured in
//     `e2e/shift-types.spec.ts` instead; this half proves authorship.

afterEach(() => {
  cleanup();
});

/** Controlled harness — the component always owns a derived value, never a draft. */
function Harness({ initial = {} }: { initial?: WorkingTimeValue }) {
  const [value, setValue] = React.useState<WorkingTimeValue>(initial);
  return (
    <>
      <WorkingTimeFields value={value} onChange={setValue} idPrefix="wt" />
      <output data-testid="emitted">{JSON.stringify(value)}</output>
    </>
  );
}

function emitted(): WorkingTimeValue {
  return JSON.parse(screen.getByTestId("emitted").textContent || "{}");
}

function roleClasses(...args: Parameters<typeof surfaceVariants>): string[] {
  return surfaceVariants(...args)
    .split(/\s+/)
    .filter(Boolean);
}

const start = () => screen.getByTestId("wt-start") as HTMLSelectElement;
const end = () => screen.getByTestId("wt-end") as HTMLSelectElement;
const restSelect = () => screen.getByTestId("wt-rest") as HTMLSelectElement;
const readout = () => screen.getByTestId("wt-duration");

describe("WorkingTimeFields — native field semantics", () => {
  it("exposes start, end and rest as real named <select> controls", () => {
    render(<Harness />);

    for (const [element, name] of [
      [start(), "Start time"],
      [end(), "End time"],
      [restSelect(), "Rest time"],
    ] as const) {
      expect(element.tagName).toBe("SELECT");
      expect(element).toHaveAttribute("aria-label", name);
      expect(element).not.toBeDisabled();
    }
    // The three are reachable by their accessible name, not only by testid — the
    // sub-form has no visible <label for>, so aria-label is load-bearing.
    expect(screen.getByLabelText("Start time")).toBe(start());
    expect(screen.getByLabelText("Rest time")).toBe(restSelect());
  });

  it("offers exactly the 48 half-hour clock slots plus an empty option", () => {
    render(<Harness />);

    const values = Array.from(start().options).map((option) => option.value);
    expect(values).toHaveLength(49);
    expect(values[0]).toBe("");
    expect(values[1]).toBe("00:00");
    expect(values.at(-1)).toBe("23:30");
    // Every non-empty option lands on the half hour — off-grid text is
    // unenterable by construction, which is why the grid rule needs no guard here.
    for (const value of values.slice(1)) expect(value).toMatch(/^\d{2}:(00|30)$/);
  });

  it("reads zero rest as 'None' and caps the options at the clock span minus 30", () => {
    render(<Harness initial={{ startTime: "08:00", endTime: "10:00", durationMinutes: 120 }} />);

    const options = Array.from(restSelect().options);
    expect(options[0]).toHaveTextContent("None");
    // A 2h span admits 0 / 30 / 60 / 90 — never a rest that consumes the shift.
    expect(options.map((option) => option.value)).toEqual(["0", "30", "60", "90"]);
    expect(options.map((option) => option.textContent)).toEqual(["None", "30m", "1h", "1h 30m"]);
  });

  it("is a read-only readout, not a control: no role, no tab stop, full sentence on title", () => {
    render(
      <Harness
        initial={{ startTime: "08:00", endTime: "17:00", restMinutes: 60, durationMinutes: 480 }}
      />,
    );

    const box = readout();
    expect(box.tagName).toBe("DIV");
    expect(box).not.toHaveAttribute("tabindex");
    expect(box).not.toHaveAttribute("role");
    expect(box).toHaveAttribute("aria-label", "Working duration (auto)");
    // The caption ellipsises at narrow widths, so the whole sentence must survive
    // on the box itself.
    expect(box).toHaveAttribute("title", "8h working = 9h on floor − 1h rest");
    expect(box).toHaveTextContent("8h");
    expect(box).toHaveTextContent("= 9h − 1h");
  });
});

describe("WorkingTimeFields — derivation write-back", () => {
  it("writes the derived paid minutes back on every clock edit", () => {
    render(<Harness />);

    fireEvent.change(start(), { target: { value: "08:00" } });
    expect(emitted().durationMinutes).toBeUndefined(); // a partial clock derives nothing

    fireEvent.change(end(), { target: { value: "16:00" } });
    expect(emitted()).toEqual({ startTime: "08:00", endTime: "16:00", durationMinutes: 480 });
    expect(readout()).toHaveTextContent("8h");
  });

  it("subtracts rest and canonically omits a zero rest", () => {
    render(<Harness initial={{ startTime: "08:00", endTime: "17:00", durationMinutes: 540 }} />);

    fireEvent.change(restSelect(), { target: { value: "30" } });
    expect(emitted()).toEqual({
      startTime: "08:00",
      endTime: "17:00",
      restMinutes: 30,
      durationMinutes: 510,
    });
    expect(readout()).toHaveTextContent("8.5h");

    fireEvent.change(restSelect(), { target: { value: "0" } });
    expect(emitted().restMinutes).toBeUndefined();
    expect(emitted().durationMinutes).toBe(540);
  });

  it("clears the clocks and the derived duration when both clocks are unset", () => {
    render(<Harness initial={{ startTime: "08:00", endTime: "16:00", durationMinutes: 480 }} />);

    fireEvent.change(start(), { target: { value: "" } });
    fireEvent.change(end(), { target: { value: "" } });
    expect(emitted()).toEqual({});
    expect(readout()).toHaveTextContent("—");
  });

  it("KEEPS an entered rest when the clocks are cleared — documented, not designed", () => {
    render(
      <Harness
        initial={{ startTime: "08:00", endTime: "16:00", restMinutes: 30, durationMinutes: 450 }}
      />,
    );

    fireEvent.change(start(), { target: { value: "" } });
    fireEvent.change(end(), { target: { value: "" } });

    // `deriveValue` drops a FALSY rest only, so a real rest survives a clock
    // clear and the select still offers it. The validator raises nothing for a
    // rest with no clocks, so this persists as `{ restMinutes: 30 }`.
    //
    // This is PRE-EXISTING behaviour that R2c (a presentation ticket) neither
    // introduced nor is authorised to change. It is pinned here so the re-skin
    // is provably behaviour-neutral and so a future behavioural fix has to face
    // this assertion deliberately rather than drift past it.
    expect(emitted()).toEqual({ restMinutes: 30 });
    expect(readout()).toHaveTextContent("—");
    expect(restSelect().value).toBe("30");
  });

  it("rolls an overnight span past midnight and marks it, once", () => {
    render(<Harness />);
    expect(screen.queryByText("+1 day")).toBeNull();

    fireEvent.change(start(), { target: { value: "19:00" } });
    fireEvent.change(end(), { target: { value: "07:00" } });

    expect(emitted().durationMinutes).toBe(720);
    const badges = screen.getAllByText("+1 day");
    expect(badges).toHaveLength(1);
    // The marker lives inside the clock row it qualifies, not beside the readout.
    expect(within(screen.getByTestId("wt-clocks")).getByText("+1 day")).toBe(badges[0]);
  });
});

describe("WorkingTimeFields — validation surface", () => {
  it("reports an equal start/end as an alert and blocks nothing silently", () => {
    render(<Harness />);

    fireEvent.change(start(), { target: { value: "09:00" } });
    fireEvent.change(end(), { target: { value: "09:00" } });

    const error = screen.getByTestId("wt-wt-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error).toHaveTextContent(/must differ/i);
  });

  it("reports a partial clock pair", () => {
    render(<Harness initial={{ startTime: "08:00" }} />);
    expect(screen.getByTestId("wt-wt-error")).toHaveTextContent(/provided together/i);
  });

  it("carries the message on the DEEPEST semantic tier, never plain --error", () => {
    render(<Harness initial={{ startTime: "08:00" }} />);

    const classes = screen.getByTestId("wt-wt-error").className.split(/\s+/);
    expect(classes).toContain("text-errorink");
    expect(classes).not.toContain("text-error");
  });
});

describe("WorkingTimeFields — v2 presentation authority", () => {
  it("authors the derived readout through the shared well role at the control radius", () => {
    render(<Harness initial={{ startTime: "08:00", endTime: "16:00", durationMinutes: 480 }} />);

    const box = readout();
    const classes = box.className.split(/\s+/);
    for (const token of roleClasses({ role: "well", geometry: "control" })) {
      expect(classes, `readout → ${token}`).toContain(token);
    }
    // Direction of light is fixed: a well takes the inset cast and NEVER an
    // outer elevation (DESIGN.md §4 rule 1).
    expect(box.className).not.toMatch(/\bshadow-[123]\b/);
    // Retired v1 authoring: a hand-drawn hairline box on `--panel` with no radius.
    expect(classes).not.toContain("border-line2");
    expect(classes).not.toContain("h-9");
  });

  it("holds the readout at the ABSOLUTE control height with a real coarse-pointer floor", () => {
    render(<Harness initial={{ startTime: "08:00", endTime: "16:00", durationMinutes: 480 }} />);

    // The box has no vertical padding, so its height IS this row's; the height
    // lives here because the recipe consumer's className is held to layout-only
    // utilities and `h-control` is not one of them.
    const row = readout().firstElementChild as HTMLElement;
    const classes = row.className.split(/\s+/);
    expect(classes).toContain("h-control");
    expect(classes).toContain("pointer-coarse:min-h-touch");
    // A density-derived height would silently drift off the 36px selects beside
    // it if the 0.9 baseline ever moved (DESIGN.md §1: control sizes are absolute).
    expect(classes.some((token) => /^h-\d/.test(token))).toBe(false);
  });

  it("grows the real controls to 44px on a coarse pointer, never a pseudo-element hitbox", () => {
    render(<Harness />);

    for (const control of [start(), end(), restSelect()]) {
      const classes = control.className.split(/\s+/);
      expect(classes).toContain("h-control");
      expect(classes).toContain("pointer-coarse:min-h-touch");
      // Focus REINFORCES the global outline rather than replacing it.
      expect(classes).toContain("focus-visible:border-brand");
      expect(classes).toContain("rounded-control");
    }
  });

  it("renders the overnight marker through the shared Badge on the chip radius", () => {
    render(<Harness initial={{ startTime: "19:00", endTime: "07:00", durationMinutes: 720 }} />);

    const badge = screen.getByText("+1 day");
    expect(badge).toHaveAttribute("data-slot", "badge");
    const classes = badge.className.split(/\s+/);
    expect(classes).toContain("rounded-chip");
    expect(classes).toContain("normal-case");
    // Retired v1 authoring: a bare hairline span with square corners.
    expect(classes).not.toContain("border-line2");
  });

  it("leaves no retired v1 presentation anywhere in the rendered sub-form", () => {
    render(
      <Harness
        initial={{ startTime: "19:00", endTime: "07:00", restMinutes: 60, durationMinutes: 660 }}
      />,
    );

    const html = document.body.innerHTML;
    for (const retired of ["h-9", "font-extrabold", "shadow-["]) {
      expect(html, `retired v1 presentation still rendered: ${retired}`).not.toContain(retired);
    }
    // `--faint` is legitimate behind the shared Input's `placeholder:` variant,
    // but no functional copy in this sub-form may sit on it.
    const bareFaint = Array.from(document.querySelectorAll("[class]"))
      .flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/))
      .filter((token) => token === "text-faint");
    expect(bareFaint).toEqual([]);
  });
});
