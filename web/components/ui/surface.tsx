import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The single surface authority (v2 technical plan T5, DESIGN.md §4).
//
// One CVA recipe owns tone + border + elevation for every level of the ladder,
// and a second `geometry` axis owns the selective rounding. Ordinary container
// DOM goes through the `Surface` adapter below; specialized owners (tables,
// sticky regions, editors, grids, chips) call `surfaceVariants()` directly so a
// role never costs an extra wrapper element.
//
// Two things are deliberately NOT inferred:
//   • radius is never inferred from tone — a `--panel` band and a `--panel` chip
//     are the same role with different geometry, and the owner is the only thing
//     that knows which (DESIGN.md §5: full-bleed bands stay square, inset
//     islands round);
//   • direction of light is fixed — `well` takes the inset shadow and never an
//     outer one; `raised` takes the outer shadow and never an inset one.
//
// `surfaceVariants` publishes the full role set including the specialized roles
// (`selected`, `band`, `zebra`, `sticky`) and the `pill` geometry. `Surface`
// deliberately exposes only the four ordinary-container levels, and only the
// level/geometry pairs that are legal — see `SurfaceVisualProps`.
// ---------------------------------------------------------------------------

const surfaceVariants = cva("", {
  variants: {
    role: {
      /** L0 app plane. Nothing floats free on it. */
      page: "bg-bg",
      /** L1 — cards, table containers, pane shells, the sticky top bar. */
      surface: "border border-line bg-surface shadow-1",
      /** L1 selected — current wizard step, active editor card. */
      selected: "border border-brand bg-surface shadow-2",
      /**
       * Transient drop candidate during a drag. Deliberately NOT `selected`: a
       * row under the pointer is neither the current selection nor the active
       * editor, and collapsing the two would make "current" unverifiable.
       *
       * It also must not borrow the selection LANGUAGE, which DESIGN.md §6
       * reserves `--brandtint` + a `--brand` border for. So the emphasis is a
       * DASHED brand edge over the hover tone: dashed reads as "release here"
       * rather than "this is the one", and every value is a canonical token —
       * no arbitrary inset shadow.
       */
      "drop-target": "border border-dashed border-brand bg-panel-alt shadow-2",
      /** L2 — dialogs, drawers, popovers. */
      raised: "border border-line bg-surface2 shadow-3",
      /**
       * The one directional overlay: a left-anchored navigation drawer. It is
       * NOT `raised` — a drawer is the sidebar plane pulled over the page, so it
       * keeps the `--sidebar` tone and a single trailing edge, and it takes the
       * specialized `--sh-side` cast (T7) rather than the general `--sh-3`.
       */
      drawer: "border-r border-line bg-sidebar shadow-side",
      /** Inset island — summary chips, note strips, locked rows. Inset only. */
      well: "bg-panel shadow-well",
      /** Full-bleed header band. Square by contract; never a well shadow. */
      band: "bg-panel",
      /** Zebra / hover band. `--panel` is reserved for bands and true insets. */
      zebra: "bg-panel-alt",
      /** Sticky full-width edge — a single border edge, so it stays square. */
      sticky: "border-b border-line bg-surface shadow-1",
    },
    geometry: {
      card: "rounded-card",
      control: "rounded-control",
      chip: "rounded-chip",
      pill: "rounded-pill",
      square: "rounded-none",
    },
    /**
     * An optional canonical hairline, composable with any role.
     *
     * Both prototypes author `border:1px solid var(--line2)` on the recessed
     * group rows inside the Staff/Shift groups card, while this app's other
     * wells are deliberately borderless — R2a's `date-id-explainer` says so in
     * as many words, and the segmented ToggleGroup track would grow an edge it
     * never had. Those are two genuinely different surfaces, so the hairline is
     * an ADDITIVE axis rather than a change to the `well` role itself: no
     * existing consumer passes `edge`, so no existing consumer moves.
     */
    edge: {
      hairline: "border border-line2",
    },
    /**
     * Transient drag-and-drop emphasis, composable with any role so the surface
     * keeps its OWN tone and its own direction of light.
     *
     * The `drop-target` ROLE restates `--panel-alt` plus an outer `--sh-2`.
     * That is right for an L1 card (the card editor's drop zone) and wrong for
     * a well: DESIGN.md §4 rule 1 fixes the direction of light, so lifting a
     * recessed row on an outer cast inverts it. This axis changes only the
     * EDGE, so a well stays inset and a card stays raised.
     *
     * It is deliberately DASHED. A solid brand edge is the selection /
     * active-editor language (§6 reserves `--brandtint` + `--brand` for
     * selection), and a row under the pointer is neither the current selection
     * nor the open editor. The canonical sources agree on everything else: the
     * prototypes' own drop candidate keeps `background:var(--panel)` and swaps
     * only the border to `var(--brand)`.
     */
    drop: {
      candidate: "border border-dashed border-brand",
    },
    /**
     * Entrance/exit treatment for surfaces that appear and disappear. This lives
     * in the recipe rather than at the call site because a consumer's
     * `className` is layout-only: animation and transition utilities are
     * rejected by `surface-contract.test.ts`, so the only legitimate home for
     * them is here, where every overlay shares one motion treatment.
     *
     * All of it collapses under `prefers-reduced-motion` via the global rule in
     * globals.css, so no consumer needs a per-component guard.
     */
    motion: {
      overlay: [
        "duration-fast",
        "data-[open]:animate-in data-[open]:fade-in-0",
        "data-[closed]:animate-out data-[closed]:fade-out-0",
      ].join(" "),
      /**
       * The side drawer slides rather than fades, driven by Base UI's own
       * `data-starting-style` / `data-ending-style` transition attributes.
       */
      side: [
        "transition-transform duration-base",
        "data-[starting-style]:-translate-x-full",
        "data-[ending-style]:-translate-x-full",
      ].join(" "),
    },
    /**
     * Pointer affordances for draggable surfaces. Same reasoning as `motion`:
     * `cursor-*` and `opacity-*` are not layout, so a reorderable list cannot
     * author them at the call site. `dragging` dims the source row while it is
     * being moved; the row it would land on takes `role="drop-target"`.
     */
    interaction: {
      grabbable: "cursor-grab",
      dragging: "cursor-grabbing opacity-50",
    },
    /**
     * Named width contracts. A consumer's className admits no arbitrary value,
     * so the one width the overlays need — "as wide as the viewport minus a
     * gutter, capped at the small breakpoint" — is expressed here once instead
     * of being spelled `max-w-[calc(100%-2rem)]` at each popup.
     */
    width: {
      overlay: "w-full max-w-[calc(100%-2rem)] sm:max-w-md",
      /** The mobile drawer's prototype metrics; the desktop rail stays 280px. */
      side: "w-[250px] max-w-[84vw]",
    },
  },
  defaultVariants: {
    role: "surface",
  },
});

export type SurfaceRole = NonNullable<VariantProps<typeof surfaceVariants>["role"]>;
export type SurfaceGeometry = NonNullable<VariantProps<typeof surfaceVariants>["geometry"]>;
export type SurfaceEdge = NonNullable<VariantProps<typeof surfaceVariants>["edge"]>;

/**
 * The legal level/geometry pairs for an ordinary container. TypeScript enforces
 * exactly this tuple union: `level="page"` can only be square (the app plane is
 * never a rounded box), `level="raised"` is always a card (dialogs and popovers
 * round), and a `well` picks control/chip/square by whether it is an inset
 * island or a full-bleed band.
 *
 * What the type system CANNOT prove is that `className` stays layout-only — a
 * `bg-*`/`border-*`/`shadow-*`/`rounded-*` utility there would silently defeat
 * the recipe. `surface-contract.test.ts` is the AST guard for that half.
 */
export type SurfaceVisualProps =
  | { level: "page"; geometry: "square" }
  | { level: "surface"; geometry: "card" | "square" }
  | { level: "raised"; geometry: "card" }
  | { level: "well"; geometry: "control" | "chip" | "square" };

export type SurfaceProps = SurfaceVisualProps & {
  /**
   * Optional canonical `--line2` hairline (see `surfaceVariants.edge`). Purely
   * additive: omitting it reproduces the previous output exactly, so this
   * widens the accepted props without changing any existing call site.
   */
  edge?: SurfaceEdge;
} & React.HTMLAttributes<HTMLDivElement>;

/**
 * The ordinary-container adapter over the recipe. `level` maps onto the
 * same-named recipe role; the full native `<div>` attribute and ref contract is
 * preserved so a caller never needs a wrapper just to attach a handler, an id,
 * or a ref.
 */
export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { level, geometry, edge, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="surface"
      data-level={level}
      data-geometry={geometry}
      data-edge={edge}
      className={cn(surfaceVariants({ role: level, geometry, edge }), className)}
      {...props}
    />
  );
});

export { surfaceVariants };
