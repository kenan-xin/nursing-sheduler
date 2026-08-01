// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, buttonVariants } from "./button";
import { Card, CardContent, CardTitle, SelectedCard } from "./card";
import { Badge } from "./badge";
import { Input } from "./input";
import { Select } from "./select";
import { Switch } from "./switch";
import { Label } from "./label";
import { Separator } from "./separator";
import { InfoTip } from "./info-tip";
import { Surface, surfaceVariants, type SurfaceRole } from "./surface";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "./alert-dialog";

// The v2 primitive contract. These are class/behaviour assertions rather than
// pixel assertions: the emitted CSS for each token is proved in
// app/tailwind-contract.test.ts, and the rendered computed values in
// e2e/design-system.spec.ts. What is pinned here is which ROLE each primitive
// reaches for — the decision a future edit would silently change.

afterEach(() => {
  cleanup();
});

function classesOf(element: Element | null): string {
  return element?.getAttribute("class") ?? "";
}

describe("Button — merged onto the Base UI primitive", () => {
  it("renders a native button and defaults type to button, not submit", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("data-slot", "button");
  });

  it("lets a caller opt into submit", () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "submit");
  });

  it("composes through Base UI `render` — not a Radix asChild wrapper", () => {
    render(
      <Button render={<a href="/dates" />} nativeButton={false}>
        Dates
      </Button>,
    );
    // Base UI keeps the button SEMANTICS on the rendered element (role="button" +
    // tabindex) while the element itself is the caller's anchor — that is the
    // `render` contract, and the reason `nativeButton={false}` exists.
    const link = screen.getByRole("button", { name: "Dates" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/dates");
    // The variant classes land on the rendered element itself; there is no extra
    // wrapper element between the caller's node and the styling.
    expect(classesOf(link)).toContain("rounded-pill");
    // `type` is meaningless on an anchor, so it must not be stamped on.
    expect(link).not.toHaveAttribute("type");
  });

  it.each([
    ["default", ["bg-brand", "text-onbrand", "shadow-1", "active:shadow-none"]],
    ["secondary", ["bg-surface", "border-line", "shadow-1", "hover:shadow-2"]],
    ["outline", ["bg-surface", "border-rule", "shadow-1"]],
    [
      "ghost",
      [
        "bg-surface",
        "border-line",
        "shadow-1",
        "hover:bg-panel-alt",
        "hover:shadow-2",
        "active:shadow-none",
      ],
    ],
    ["destructive", ["bg-fill-error", "text-on-error", "shadow-1"]],
    ["destructive-outline", ["border-error", "text-errorink", "hover:bg-errortint"]],
    ["link", ["text-brandink", "hover:underline"]],
  ] as const)("variant %s carries its v2 treatment", (variant, expected) => {
    render(<Button variant={variant}>x</Button>);
    const classes = classesOf(screen.getByRole("button"));
    for (const token of expected) expect(classes, `${variant} → ${token}`).toContain(token);
  });

  it("makes secondary AND ghost canonical L1 controls", () => {
    // DESIGN.md §4 rule 4 and §5 name the two together: a transparent button on
    // the recessed page does not read as pressable, so ghost is not chromeless.
    // They stay separate PUBLIC names; `outline` remains the distinct heavier edge.
    const secondary = buttonVariants({ variant: "secondary" });
    const ghost = buttonVariants({ variant: "ghost" });
    for (const token of ["bg-surface", "border-line", "shadow-1", "hover:shadow-2"]) {
      expect(ghost, token).toContain(token);
      expect(secondary, token).toContain(token);
    }
    expect(buttonVariants({ variant: "outline" })).toContain("border-rule");
  });

  it("is a pill in every variant", () => {
    for (const variant of [
      "default",
      "secondary",
      "outline",
      "ghost",
      "destructive",
      "destructive-outline",
      "link",
    ] as const) {
      expect(buttonVariants({ variant })).toContain("rounded-pill");
    }
  });

  it.each([
    ["sm", "h-control-sm"],
    ["default", "h-control"],
    ["lg", "h-control-lg"],
    ["icon", "size-control"],
  ] as const)("size %s uses the absolute %s token", (size, expected) => {
    render(<Button size={size}>x</Button>);
    expect(classesOf(screen.getByRole("button"))).toContain(expected);
  });

  it("reaches a real 44px target on a coarse pointer, on the control itself", () => {
    render(<Button size="sm">x</Button>);
    const classes = classesOf(screen.getByRole("button"));
    expect(classes).toContain("pointer-coarse:min-h-touch");
    expect(classes).toContain("pointer-coarse:min-w-touch");
  });

  it("reinforces the global focus outline rather than replacing it with a ring", () => {
    render(<Button>x</Button>);
    const classes = classesOf(screen.getByRole("button"));
    expect(classes).toContain("focus-visible:outline-brand");
    // `outline-none` would kill the global :focus-visible outline from globals.css.
    expect(classes).not.toContain("outline-none");
  });

  it("still forwards click, disabled and aria props", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} aria-label="Add row" data-testid="add">
        +
      </Button>,
    );
    await userEvent.click(screen.getByTestId("add"));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Add row")).toBeInTheDocument();
  });
});

describe("Card — composed from the surface recipe", () => {
  it("is an L1 surface on the card radius", () => {
    render(<Card data-testid="card">body</Card>);
    const classes = classesOf(screen.getByTestId("card"));
    expect(classes).toContain("bg-surface");
    expect(classes).toContain("border-line");
    expect(classes).toContain("shadow-1");
    expect(classes).toContain("rounded-card");
  });

  it("a selected card swaps the hairline for a brand border and lifts to sh-2", () => {
    render(<SelectedCard data-testid="card">body</SelectedCard>);
    const classes = classesOf(screen.getByTestId("card"));
    expect(classes).toContain("border-brand");
    expect(classes).toContain("shadow-2");
    expect(classes).not.toContain("shadow-1");
  });

  it("keeps its public composition and slots", () => {
    render(
      <Card>
        <CardTitle>Ward</CardTitle>
        <CardContent>content</CardContent>
      </Card>,
    );
    expect(document.querySelector("[data-slot='card-title']")).not.toBeNull();
    expect(document.querySelector("[data-slot='card-content']")).not.toBeNull();
  });
});

describe("Badge — tint paired with its own semantic ink and border", () => {
  it.each([
    ["brand", ["bg-brandtint", "text-brandink", "border-brand"]],
    ["success", ["bg-successtint", "text-successink", "border-success"]],
    ["warn", ["bg-warntint", "text-warnink", "border-warn"]],
    ["error", ["bg-errortint", "text-errorink", "border-error"]],
    ["neutral", ["bg-panel", "text-ink2", "border-line"]],
  ] as const)("variant %s pairs tint + ink + border", (variant, expected) => {
    render(<Badge variant={variant}>x</Badge>);
    const classes = classesOf(document.querySelector("[data-slot='badge']"));
    for (const token of expected) expect(classes, `${variant} → ${token}`).toContain(token);
  });

  it("is a chip, and uppercase with the label tracking by default", () => {
    render(<Badge>Saved</Badge>);
    const classes = classesOf(document.querySelector("[data-slot='badge']"));
    expect(classes).toContain("rounded-chip");
    expect(classes).toContain("uppercase");
    expect(classes).toContain("tracking-[0.03em]");
  });

  it("renders authored data verbatim through the casing variant", () => {
    render(<Badge casing="normal">Aisha Rahman</Badge>);
    const classes = classesOf(document.querySelector("[data-slot='badge']"));
    expect(classes).toContain("normal-case");
    expect(classes).not.toContain("uppercase");
  });
});

describe("Input / Select — control geometry and real touch height", () => {
  it("the input is a 36px control on the control radius, 44px on coarse", () => {
    render(<Input aria-label="Ward" />);
    const classes = classesOf(screen.getByLabelText("Ward"));
    expect(classes).toContain("h-control");
    expect(classes).toContain("rounded-control");
    expect(classes).toContain("pointer-coarse:min-h-touch");
    expect(classes).toContain("placeholder:text-faint");
  });

  it("the input's focus treatment reinforces the global outline", () => {
    render(<Input aria-label="Ward" />);
    const classes = classesOf(screen.getByLabelText("Ward"));
    expect(classes).toContain("focus-visible:border-brand");
    expect(classes).not.toContain("outline-none");
  });

  it("the native select takes the same control geometry and touch height", () => {
    render(
      <Select aria-label="Shift">
        <option value="a">A</option>
      </Select>,
    );
    const classes = classesOf(screen.getByLabelText("Shift"));
    expect(classes).toContain("h-control");
    expect(classes).toContain("rounded-control");
    expect(classes).toContain("pointer-coarse:min-h-touch");
  });
});

describe("Switch — the coarse-pointer target is the real control", () => {
  it("grows the Base UI root to 44px and centres the small track inside it", () => {
    render(<Switch aria-label="Anonymize" />);
    const root = screen.getByRole("switch");
    expect(classesOf(root)).toContain("pointer-coarse:size-touch");
    const track = root.querySelector("[data-slot='switch-track']");
    expect(track).not.toBeNull();
    expect(classesOf(track)).toContain("rounded-pill");
  });

  it("drives the track visual off Base UI's own state attributes", async () => {
    render(<Switch aria-label="Anonymize" />);
    const root = screen.getByRole("switch");
    expect(root).toHaveAttribute("data-unchecked");
    await userEvent.click(root);
    expect(root).toHaveAttribute("data-checked");
    const track = root.querySelector("[data-slot='switch-track']");
    expect(classesOf(track)).toContain("group-data-[checked]/switch:bg-brand");
  });

  it("puts the thumb elevation on a canonical token", () => {
    render(<Switch aria-label="Anonymize" />);
    const thumb = document.querySelector("[data-slot='switch-thumb']");
    expect(classesOf(thumb)).toContain("shadow-1");
  });
});

describe("Label / Separator", () => {
  it("the label is an uppercase eyebrow at +0.03em", () => {
    render(<Label htmlFor="x">Ward name</Label>);
    const classes = classesOf(screen.getByText("Ward name"));
    expect(classes).toContain("uppercase");
    expect(classes).toContain("tracking-[0.03em]");
    expect(classes).toContain("text-ink3");
  });

  it("the separator is a square hairline whose axis follows its orientation", () => {
    const { rerender } = render(<Separator data-testid="sep" />);
    let classes = classesOf(screen.getByTestId("sep"));
    expect(classes).toContain("bg-line2");
    expect(classes).toContain("rounded-none");
    expect(classes).toContain("h-px");

    rerender(<Separator data-testid="sep" orientation="vertical" />);
    classes = classesOf(screen.getByTestId("sep"));
    expect(classes).toContain("w-px");
    // Base UI publishes orientation as a VALUE, so the styling must not depend on
    // a bare `data-vertical` attribute that is never emitted.
    expect(screen.getByTestId("sep")).toHaveAttribute("data-orientation", "vertical");
  });
});

describe("InfoTip", () => {
  it("reveals an ink bubble on focus and exposes it as a tooltip", async () => {
    render(<InfoTip label="Workday" text="Mondays to Fridays." />);
    const trigger = screen.getByRole("button");
    expect(classesOf(trigger)).toContain("pointer-coarse:size-touch");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    trigger.focus();
    const bubble = await screen.findByRole("tooltip");
    const classes = classesOf(bubble);
    expect(classes).toContain("bg-ink");
    expect(classes).toContain("text-on-ink");
    expect(classes).toContain("rounded-chip");
    expect(classes).toContain("shadow-2");
  });

  it("carries the help text as the trigger's accessible name", () => {
    render(<InfoTip label="Workday" text="Mondays to Fridays." />);
    expect(
      screen.getByRole("button", { name: "Workday: Mondays to Fridays." }),
    ).toBeInTheDocument();
  });
});

describe("ToggleGroup — Base UI shell for F3/route consumption", () => {
  function Group() {
    const [value, setValue] = React.useState<string[]>(["grid"]);
    return (
      <ToggleGroup segmented value={value} onValueChange={setValue} aria-label="View">
        <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
        <ToggleGroupItem value="list">List</ToggleGroupItem>
      </ToggleGroup>
    );
  }

  it("marks the pressed item with Base UI's state attribute and the selection tint", async () => {
    render(<Group />);
    const grid = screen.getByRole("button", { name: "Grid" });
    const list = screen.getByRole("button", { name: "List" });
    expect(grid).toHaveAttribute("data-pressed");
    expect(list).not.toHaveAttribute("data-pressed");
    expect(classesOf(grid)).toContain("data-[pressed]:bg-brandtint");
    expect(classesOf(grid)).toContain("data-[pressed]:text-brandink");

    await userEvent.click(list);
    expect(list).toHaveAttribute("data-pressed");
    expect(grid).not.toHaveAttribute("data-pressed");
  });

  it("renders the segmented group as an inset well pill with 44px items", () => {
    render(<Group />);
    const group = document.querySelector("[data-slot='toggle-group']");
    expect(classesOf(group)).toContain("bg-panel");
    expect(classesOf(group)).toContain("rounded-pill");
    expect(classesOf(screen.getByRole("button", { name: "Grid" }))).toContain(
      "pointer-coarse:min-h-touch",
    );
  });
});

describe("Dialog / AlertDialog shells", () => {
  it("the dialog is an L2 raised card behind the semantic scrim", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>Pick a new name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const popup = document.querySelector("[data-slot='dialog-content']");
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("shadow-3");
    expect(classesOf(popup)).toContain("rounded-card");
    // The scrim is the theme token — never a raw translucent black.
    expect(classesOf(overlay)).toContain("bg-scrim");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("keeps Base UI close-on-Escape behaviour", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalled();
  });

  it("the alert dialog composes its cancel through Base UI `render`", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <AlertDialog open onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogTitle>Start over?</AlertDialogTitle>
          <AlertDialogDescription>Cannot be undone.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onConfirm}>
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const popup = document.querySelector("[data-slot='alert-dialog-content']");
    expect(classesOf(popup)).toContain("bg-surface2");
    expect(classesOf(popup)).toContain("rounded-card");

    const cancel = screen.getByRole("button", { name: "Cancel" });
    // One element: the Button's variant classes are ON the Base UI Close, not on a
    // wrapper around it.
    expect(cancel).toHaveAttribute("data-slot", "alert-dialog-cancel");
    expect(classesOf(cancel)).toContain("rounded-pill");

    await userEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe("Surface / surfaceVariants — the single visual authority", () => {
  it.each([
    ["page", ["bg-bg"]],
    ["surface", ["bg-surface", "border-line", "shadow-1"]],
    ["selected", ["bg-surface", "border-brand", "shadow-2"]],
    ["raised", ["bg-surface2", "border-line", "shadow-3"]],
    ["well", ["bg-panel", "shadow-well"]],
    ["band", ["bg-panel"]],
    ["zebra", ["bg-panel-alt"]],
    ["sticky", ["bg-surface", "border-b", "shadow-1"]],
  ] as const)("role %s emits its ladder treatment", (role, expected) => {
    const classes = surfaceVariants({ role });
    for (const token of expected) expect(classes, `${role} → ${token}`).toContain(token);
  });

  it("gives a drop candidate its own role, never the selection language", () => {
    const drop = surfaceVariants({ role: "drop-target" });
    const selected = surfaceVariants({ role: "selected" });
    expect(drop).not.toBe(selected);
    // A dashed brand edge over the hover tone reads as "release here".
    expect(drop).toContain("border-dashed");
    expect(drop).toContain("border-brand");
    expect(drop).toContain("bg-panel-alt");
    // DESIGN.md §6 reserves brandtint + a solid brand border for "current".
    expect(drop).not.toContain("bg-brandtint");
    expect(selected).not.toContain("border-dashed");
    expect(selected).toContain("bg-surface");
  });

  it("owns motion and drag affordances, so a consumer never authors them", () => {
    // A surface consumer's className is layout-only, so animation, cursor and
    // opacity have exactly one legitimate home: the recipe.
    const overlay = surfaceVariants({ role: "raised", motion: "overlay" });
    expect(overlay).toContain("duration-fast");
    expect(overlay).toContain("data-[open]:animate-in");
    expect(overlay).toContain("data-[closed]:animate-out");
    expect(surfaceVariants({ role: "surface", interaction: "grabbable" })).toContain("cursor-grab");
    const dragging = surfaceVariants({ role: "surface", interaction: "dragging" });
    expect(dragging).toContain("cursor-grabbing");
    expect(dragging).toContain("opacity-50");
  });

  // ii7.8.5.1 — the two ADDITIVE axes that let a recessed row carry the
  // canonical hairline and a drop edge without inheriting a card's elevation.
  it("adds the canonical --line2 hairline through `edge`, and only on request", () => {
    expect(surfaceVariants({ role: "well", geometry: "control", edge: "hairline" })).toContain(
      "border-line2",
    );
    // Opt-in: the bare role is byte-identical to what it produced before the
    // axis existed, so no existing `well` consumer moves.
    expect(surfaceVariants({ role: "well", geometry: "control" })).not.toContain("border");
  });

  it("gives a drop candidate an EDGE, never an elevation, so each role keeps its own light", () => {
    const wellDrop = surfaceVariants({ role: "well", geometry: "control", drop: "candidate" });
    expect(wellDrop).toContain("border-dashed");
    expect(wellDrop).toContain("border-brand");
    // The whole point: a recessed row stays recessed while it is a drop target.
    expect(wellDrop).toContain("shadow-well");
    expect(wellDrop).not.toContain("shadow-2");
    expect(wellDrop).not.toContain("bg-panel-alt");
    // A card-tier drop zone composed the same way keeps ITS outer elevation.
    const cardDrop = surfaceVariants({ role: "surface", geometry: "card", drop: "candidate" });
    expect(cardDrop).toContain("shadow-1");
    expect(cardDrop).not.toContain("shadow-well");
    // Dashed, because a solid brand edge is the selection language (§6).
    expect(wellDrop).not.toContain("bg-brandtint");
  });

  it("leaves every pre-existing role byte-identical — the new axes are additive", () => {
    // Frozen expectations captured from the recipe BEFORE the two axes landed.
    // If a future edit reaches into a role to add an edge, this fails.
    const FROZEN: Record<SurfaceRole, string> = {
      page: "bg-bg",
      surface: "border border-line bg-surface shadow-1",
      selected: "border border-brand bg-surface shadow-2",
      "drop-target": "border border-dashed border-brand bg-panel-alt shadow-2",
      raised: "border border-line bg-surface2 shadow-3",
      drawer: "border-r border-line bg-sidebar shadow-side",
      well: "bg-panel shadow-well",
      band: "bg-panel",
      zebra: "bg-panel-alt",
      sticky: "border-b border-line bg-surface shadow-1",
    };
    for (const role of Object.keys(FROZEN) as SurfaceRole[]) {
      expect(surfaceVariants({ role }), role).toBe(FROZEN[role]);
    }
  });

  it("keeps the direction of light fixed — wells inset, raised surfaces outer", () => {
    expect(surfaceVariants({ role: "well" })).not.toContain("shadow-3");
    expect(surfaceVariants({ role: "raised" })).not.toContain("shadow-well");
    // Full-bleed bands are flat: tone only, no elevation at all.
    expect(surfaceVariants({ role: "band" })).not.toContain("shadow");
    expect(surfaceVariants({ role: "zebra" })).not.toContain("shadow");
  });

  it.each([
    ["card", "rounded-card"],
    ["control", "rounded-control"],
    ["chip", "rounded-chip"],
    ["pill", "rounded-pill"],
    ["square", "rounded-none"],
  ] as const)("geometry %s emits %s", (geometry, expected) => {
    expect(surfaceVariants({ role: "surface", geometry })).toContain(expected);
  });

  it("maps a Surface level onto the same-named role and forwards div props + ref", () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <Surface
        ref={ref}
        level="well"
        geometry="control"
        id="note"
        title="Everyone"
        data-testid="well"
        className="flex flex-col gap-2 p-3"
      >
        note
      </Surface>,
    );
    const element = screen.getByTestId("well");
    expect(ref.current).toBe(element);
    expect(element.tagName).toBe("DIV");
    expect(element).toHaveAttribute("id", "note");
    expect(element).toHaveAttribute("title", "Everyone");
    expect(element).toHaveAttribute("data-level", "well");
    expect(element).toHaveAttribute("data-geometry", "control");
    const classes = classesOf(element);
    expect(classes).toContain("bg-panel");
    expect(classes).toContain("shadow-well");
    expect(classes).toContain("rounded-control");
    expect(classes).toContain("p-3");
  });
});

// ---------------------------------------------------------------------------
// Source-level guards. Both of these are contract facts about the whole owned
// layer, so a per-component render assertion could not express them.
// ---------------------------------------------------------------------------

describe("the owned primitive layer as a whole", () => {
  const uiDir = __dirname;
  // Comments are stripped before scanning: these guards are about what the layer
  // AUTHORS, and a comment that names a retired utility in order to explain why it
  // was retired must not read as a violation of the thing it documents.
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");

  const sources = readdirSync(uiDir)
    .filter((name) => name.endsWith(".tsx") && !name.includes(".test."))
    .map((name) => ({
      name,
      text: stripComments(readFileSync(join(uiDir, name), "utf8")),
    }));

  it("scans the authored primitives", () => {
    expect(sources.length).toBeGreaterThanOrEqual(12);
  });

  it("uses no pseudo-element hitbox to fake a touch target", () => {
    // T8: the coarse-pointer minimum must be on the real control. An
    // `after:-inset-*` overlay (the shadcn preset's Switch) moves the pointer
    // target off the element that paints focus and overlaps its neighbours.
    const offenders = sources.filter(({ text }) =>
      /className[^\n]*\b(?:after|before):-?inset/.test(text),
    );
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  it("aliases every shadow utility to a canonical elevation token", () => {
    const CANONICAL = new Set(["1", "2", "3", "edge", "well", "dialog", "toast", "side", "none"]);
    const offenders: string[] = [];
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/(?:^|[\s"'`:])shadow-([\w[\]-]+)/g)) {
        if (!CANONICAL.has(match[1])) offenders.push(`${name}: shadow-${match[1]}`);
      }
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });
});
