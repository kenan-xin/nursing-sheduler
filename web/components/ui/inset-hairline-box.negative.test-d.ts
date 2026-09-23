// NEGATIVE TYPE FIXTURE for the inset-hairline boxes (custom-AST ticket 5).
//
// The deleted `inset-hairline-ownership.test.ts` analyzer proved, per governed
// node, that the effective `className` resolved to exactly the governed tuple
// and that the effective inline `style` was exactly the declared allowlist. It
// had to MODEL both channels — JSX source-order folding, spread attributes,
// const aliases, control flow — because both were spellable at the call site.
//
// They are no longer spellable. `className?: never` and `style?: never` make the
// two channels unrepresentable on both components, so the analyzer's hardest
// families (attribute-list folding, lexical binding, alias chains, per-path
// control flow) have no input to operate on. This file pins that property: if
// either channel is ever widened back to `string` / `CSSProperties`, the errors
// these directives expect disappear and the directives themselves become the
// errors.
//
// Checked by `tsc --noEmit`; `.test-d.ts` is not collected by vitest, so nothing
// executes. The runtime half — that a cast-away caller still cannot repaint the
// box, because the owner applies its own values AFTER the caller's spread — is
// `inset-hairline-box.test.tsx`.

import * as React from "react";
import type { InsetHairlineReadoutProps, InsetHairlineTileProps } from "./inset-hairline-box";

// ---------------------------------------------------------------------------
// The two refused channels.
// ---------------------------------------------------------------------------

// @ts-expect-error — a class channel on the tile. Even a LEGAL layout class is
// refused: the point is that the channel does not exist, not that its contents
// are policed.
const tileWithLayoutClass: InsetHairlineTileProps = { className: "flex" };
void tileWithLayoutClass;

// @ts-expect-error — the paint bypass the analyzer's class resolver existed for.
const tileWithVisualClass: InsetHairlineTileProps = { className: "bg-panel shadow-3" };
void tileWithVisualClass;

// @ts-expect-error — the inline-style bypass. React's `style` outranks every
// class, so this was the one escape no class-level check could see.
const tileWithStyle: InsetHairlineTileProps = { style: { backgroundColor: "red" } };
void tileWithStyle;

// @ts-expect-error — including an override of the dimension the box owns.
const tileWithDimension: InsetHairlineTileProps = { style: { width: 64 } };
void tileWithDimension;

// @ts-expect-error — the readout refuses the same two channels.
const readoutWithClass: InsetHairlineReadoutProps = { className: "bg-surface" };
void readoutWithClass;

// @ts-expect-error — and its own height is not the caller's to set.
const readoutWithStyle: InsetHairlineReadoutProps = { style: { height: 9 } };
void readoutWithStyle;

// ---------------------------------------------------------------------------
// The SPREAD case, which is why `never` rather than a plain `Omit`.
//
// An `Omit<HTMLAttributes, "className" | "style">` alone accepts a spread of a
// full `HTMLAttributes` bag: the extra properties are not excess-checked through
// a spread, so `<InsetHairlineTile {...divProps} />` would compile and the class
// would reach the element. Declaring the two properties as `never` makes the
// assignment itself fail, which is the shape the analyzer's JSX spread modelling
// used to cover.
// ---------------------------------------------------------------------------

declare const divProps: React.HTMLAttributes<HTMLDivElement>;

// @ts-expect-error — `className: string` is not assignable to `never`.
const tileFromSpread: InsetHairlineTileProps = { ...divProps };
void tileFromSpread;

// @ts-expect-error — same for the readout.
const readoutFromSpread: InsetHairlineReadoutProps = { ...divProps };
void readoutFromSpread;

// ---------------------------------------------------------------------------
// The POSITIVE controls.
//
// Without these, every directive above could be satisfied by a props type that
// admits nothing at all, and the fixture would pass while the components were
// unusable. Identity, labelling, title and handlers are still the call site's.
// ---------------------------------------------------------------------------

const tileLegal: InsetHairlineTileProps = {
  id: "tile-1",
  title: "a shift",
  "aria-label": "Day",
  onClick: () => {},
  children: null,
};
void tileLegal;

const readoutLegal: InsetHairlineReadoutProps = {
  title: "8h working",
  "aria-label": "Working duration (auto)",
  children: null,
};
void readoutLegal;
