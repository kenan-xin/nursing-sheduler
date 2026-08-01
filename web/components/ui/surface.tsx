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

const surfaceRecipe = cva("", {
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
     * RECESSED-ROW EMPHASIS — the edge treatment of a `--panel` row nested
     * inside an L1 card. One axis, so "both edges at once" is structurally
     * unrepresentable rather than merely discouraged, and `SurfaceVariantProps`
     * below admits it only on a `well`.
     *
     * Why an emphasis axis rather than more roles:
     *
     *   • `hairline` — both prototypes author `border:1px solid var(--line2)`
     *     on the group rows, while this app's other wells are deliberately
     *     borderless (R2a's `date-id-explainer` says so in as many words, and
     *     the segmented ToggleGroup track would grow an edge it never had).
     *     Folding the border into the `well` ROLE would have re-skinned all
     *     ~15 of those consumers.
     *
     *   • `drop-candidate` — the `drop-target` ROLE restates `--panel-alt` plus
     *     an outer `--sh-2`, which is right for an L1 card (the card editor's
     *     drop zone) and wrong for a well: DESIGN.md §4 rule 1 fixes the
     *     direction of light, so lifting a recessed row inverts it. Changing
     *     only the EDGE lets the row keep its own inset cast.
     *
     * `drop-candidate` is deliberately DASHED: §6 reserves a solid `--brand`
     * edge for selection, and a row under the pointer is neither the current
     * selection nor the open editor. The canonical sources agree on the rest —
     * their own drop candidate keeps `background:var(--panel)` and swaps only
     * the border colour.
     */
    emphasis: {
      hairline: "border border-line2",
      "drop-candidate": "border border-dashed border-brand",
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

type SurfaceRecipeProps = VariantProps<typeof surfaceRecipe>;

export type SurfaceRole = NonNullable<SurfaceRecipeProps["role"]>;
export type SurfaceGeometry = NonNullable<SurfaceRecipeProps["geometry"]>;
export type SurfaceEmphasis = NonNullable<SurfaceRecipeProps["emphasis"]>;

/**
 * THE PUBLIC RECIPE CONTRACT.
 *
 * `emphasis` describes the edge of a RECESSED ROW, so it is legal only on a
 * `well`. Expressing that as a discriminated union rather than as an optional
 * axis makes the illegal tuples unrepresentable at the type boundary instead of
 * merely unused by today's callers:
 *
 *   surfaceVariants({ role: "page",    emphasis: "hairline" })       ✗ rejected
 *   surfaceVariants({ role: "raised",  emphasis: "drop-candidate" }) ✗ rejected
 *   surfaceVariants({ role: "surface", emphasis: "hairline" })       ✗ rejected
 *   surfaceVariants({ role: "well",    emphasis: "hairline" })       ✓
 *   surfaceVariants({ role: "well",    emphasis: "drop-candidate" }) ✓
 *
 * "Both edges at once" needs no rule: `emphasis` is a single axis, so it cannot
 * be spelled. That is why this replaced the earlier pair of independent
 * `edge`/`drop` axes, whose legal use depended on a caller convention and on
 * tailwind-merge resolving two competing borders.
 *
 * `surface-contract.test.ts` re-checks the same tuple rule over the real
 * program, so a caller that reaches the recipe through `as any` or an untyped
 * boundary is still caught.
 */
export type SurfaceVariantProps =
  | (Omit<SurfaceRecipeProps, "emphasis"> & { emphasis?: never })
  | (Omit<SurfaceRecipeProps, "emphasis" | "role"> & {
      role: "well";
      emphasis: SurfaceEmphasis;
    });

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
// `emphasis?: never` on the three non-well members is load-bearing, not noise:
// it states that those levels HAVE no recessed edge (so `<Surface level="page"
// emphasis="hairline">` is a type error) while still declaring the property on
// every member, which lets the component destructure it straight off its props
// instead of casting the union apart. That matters beyond tidiness — the
// fail-closed analyzer in `surface-contract.test.ts` only accepts a `className`
// it can prove is a component prop, and a cast breaks that proof.
export type SurfaceVisualProps =
  | { level: "page"; geometry: "square"; emphasis?: never }
  | { level: "surface"; geometry: "card" | "square"; emphasis?: never }
  | { level: "raised"; geometry: "card"; emphasis?: never }
  | {
      level: "well";
      geometry: "control" | "chip" | "square";
      /** Recessed-row edge. Only a `well` has one — see `SurfaceVariantProps`. */
      emphasis?: SurfaceEmphasis;
    };

export type SurfaceProps = SurfaceVisualProps & React.HTMLAttributes<HTMLDivElement>;

/**
 * The ordinary-container adapter over the recipe. `level` maps onto the
 * same-named recipe role; the full native `<div>` attribute and ref contract is
 * preserved so a caller never needs a wrapper just to attach a handler, an id,
 * or a ref.
 */

export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { level, geometry, emphasis, className, ...domProps },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="surface"
      data-level={level}
      data-geometry={geometry}
      data-emphasis={emphasis}
      className={cn(
        emphasis
          ? surfaceVariants({ role: "well", geometry, emphasis })
          : surfaceVariants({ role: level, geometry }),
        className,
      )}
      {...domProps}
    />
  );
});

/**
 * The public recipe. Thin typed wrapper over the CVA instance: the runtime is
 * unchanged, and the wrapper exists so the (role, emphasis) tuple rule above is
 * enforced by the compiler at every call site.
 */
export function surfaceVariants(props?: SurfaceVariantProps): string {
  return surfaceRecipe(props as SurfaceRecipeProps);
}
