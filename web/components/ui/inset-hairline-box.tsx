import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { Surface } from "@/components/ui/surface";

// ---------------------------------------------------------------------------
// THE INSET-HAIRLINE BOXES — recipe ownership expressed as STRUCTURE.
//
// Two surfaces in the app share one visual contract: `--panel` behind a `--line2`
// hairline at the control radius, with the inset cast and NO outer elevation.
// That is exactly `surfaceVariants({ role: "well", geometry: "control",
// emphasis: "hairline" })`, and DESIGN.md §5 files both of them ("inner bordered
// boxes") under `--r-ctl`.
//
// WHY THIS FILE EXISTS. The recipe call and a raw reimplementation emit
// BYTE-IDENTICAL class lists, so no rendered assertion can tell them apart —
// which is how the authority was bypassed once while every raw-class assertion
// stayed green. The previous owner of that guarantee was a 2,002-line TypeScript
// Program analyzer that located each governed `<div>` by attribute, resolved its
// `className` through `cn` / const aliases / control flow, and proved the
// resulting tuple set was exactly the governed one.
//
// The analyzer is replaced by making the bypass UNAVAILABLE rather than detected:
//
//   • every governed inset-hairline node in the app IS one of these two
//     components — there is no third one, and a call site writes
//     `<InsetHairlineTile>` with no className expression to resolve, no alias to
//     follow and no branch to expand. (Other surfaces legitimately reach the
//     same tuple through the same authority — `synthetic-ALL` and the custom
//     group rows in `entity-editor/groups-section.tsx`, among others. This file
//     owns the governed nodes, not the tuple.);
//   • `className` and `style` are `never` on both prop types AND are applied
//     AFTER the caller's spread, so a caller cannot repaint the box at the type
//     boundary or at runtime. React's inline `style` outranks every class, and
//     here it has nowhere to be spelled;
//   • the paint comes from `<Surface>`, whose className attribute is held to the
//     fail-closed layout allowlist by ticket 4's `surface-consumer-classname`
//     ast-grep rule, so no token here can take a channel the recipe owns;
//   • this file may author no element other than `<Surface>`, by ANY spelling.
//     The `inset-hairline-box-authority` ast-grep rule is the residual
//     authored-source guard for the one bypass rendered output cannot attribute
//     — a hand-written `bg-panel shadow-well border-line2 rounded-control` div
//     spelled right here, in the owner itself. Its first draft covered JSX and
//     import sources only, and the ticket-5 cold review defeated it with
//     `React.createElement("div", …)`: a raw intrinsic element, byte-identical
//     markers and all, authored with no JSX node and no forbidden import.
//
//     THAT IS WHY THIS FILE NO LONGER IMPORTS THE REACT NAMESPACE. `import * as
//     React` handed the owner every element factory React publishes, behind a
//     binding the rule had no reason to refuse. Named imports make the reachable
//     React surface exactly `forwardRef` and the types below; the rule enforces
//     that as a fail-closed allowlist, refuses namespace and default imports
//     outright, and refuses any `createElement`/`cloneElement` call spelling as
//     defence in depth. The JSX transform is `react-jsx`, so no runtime React
//     binding is needed to author `<Surface>`.
//
// The behavioural half is `inset-hairline-box.test.tsx` (the emitted class list
// is CLOSED over the recipe's own output, asked of the recipe rather than
// restated) and the frozen `e2e/shift-types.spec.ts` matrix, which measures the
// resolved tone, radius, border colour and `--sh-well` cast in a real browser.
// ---------------------------------------------------------------------------

/**
 * The DOM contract shared by both boxes.
 *
 * `className` and `style` are declared `never` rather than merely omitted: a
 * caller spreading an `HTMLAttributes<HTMLDivElement>` bag gets a type
 * error on the property, instead of the bag being silently accepted because the
 * property was absent from the target type.
 */
type InsetHairlineDomProps = Omit<HTMLAttributes<HTMLDivElement>, "className" | "style"> & {
  /** The box owns its own paint. There is no caller-side class channel. */
  className?: never;
  /** The box owns its own dimension. Inline style outranks every class. */
  style?: never;
};

export type InsetHairlineTileProps = InsetHairlineDomProps;

/**
 * The 42px icon tile.
 *
 * 42 has no token and cannot be a `size-[42px]` utility beside the recipe: a
 * surface consumer's className admits no arbitrary value. So the one dimension
 * with no token is a style — set here, by the owner, where no caller can reach
 * it.
 */
export const InsetHairlineTile = forwardRef<HTMLDivElement, InsetHairlineTileProps>(
  function InsetHairlineTile({ children, ...domProps }, ref) {
    return (
      <Surface
        {...domProps}
        ref={ref}
        level="well"
        geometry="control"
        emphasis="hairline"
        data-slot="shift-tile"
        className="flex flex-none items-center justify-center"
        style={{ width: 42, height: 42 }}
      >
        {children}
      </Surface>
    );
  },
);

export type InsetHairlineReadoutProps = InsetHairlineDomProps;

/**
 * The control-height derived readout.
 *
 * `--ctl` is the absolute control token (D10's ratified 36px). The readout is not
 * a control, but it sits in a row with two selects and must hold their height or
 * the row steps — border-box puts the hairline inside the 36px, which is what
 * keeps it level with the Rest select beside it.
 */
export const InsetHairlineReadout = forwardRef<HTMLDivElement, InsetHairlineReadoutProps>(
  function InsetHairlineReadout({ children, ...domProps }, ref) {
    return (
      <Surface
        {...domProps}
        ref={ref}
        level="well"
        geometry="control"
        emphasis="hairline"
        data-slot="inset-hairline-readout"
        className="flex items-center gap-1.5 overflow-hidden px-2.5 pointer-coarse:min-h-touch"
        style={{ height: "var(--ctl)" }}
      >
        {children}
      </Surface>
    );
  },
);
