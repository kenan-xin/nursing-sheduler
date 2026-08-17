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
     * rejected by the `surface-consumer-classname` ast-grep rule, so the only
     * legitimate home for them is here, where every overlay shares one motion
     * treatment.
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
 * `class?: never` removes the second CVA channel at the type boundary.
 * `class-variance-authority@0.7.1` ends in
 * `cx(base, variants, compound, props.class, props.className)`, so both
 * channels always contribute to the rendered classes in fixed order. The
 * recipe used to need an analyzer that inspected both; the type now makes the
 * `class` channel unspeltable, and the dev-mode runtime assertion in
 * `surfaceVariants` catches an `as any` cast on `emphasis` / `role` / a
 * `__proto__`-poisoned options bag from the other half.
 */
export type SurfaceVariantProps =
  | (Omit<SurfaceRecipeProps, "emphasis" | "class"> & {
      emphasis?: never;
      class?: never;
    })
  | (Omit<SurfaceRecipeProps, "emphasis" | "role" | "class"> & {
      role: "well";
      emphasis: SurfaceEmphasis;
      class?: never;
    });

/**
 * The legal level/geometry pairs for an ordinary container. TypeScript enforces
 * exactly this tuple union: `level="page"` can only be square (the app plane is
 * never a rounded box), `level="raised"` is always a card (dialogs and popovers
 * round), and a `well` picks control/chip/square by whether it is an inset
 * island or a full-bleed band.
 *
 * What the type system CANNOT prove is that `className` stays layout-only — any
 * class outside the layout/position/overflow/sizing vocabulary there would silently
 * defeat the recipe. The `surface-consumer-classname`, `surface-recipe-option-visual`
 * and `surface-recipe-combiner-visual` ast-grep rules are the residual authored-syntax
 * guard for that half; all three check the shared FAIL-CLOSED
 * `surface-legal-class-vocabulary` allowlist, so a token is refused because it is absent
 * from the legal vocabulary rather than because a denylist named it. The rendered
 * Playwright surface route/state matrix is the behavioural guard.
 */
// `emphasis?: never` on the three non-well members is load-bearing, not noise:
// it states that those levels HAVE no recessed edge (so `<Surface level="page"
// emphasis="hairline">` is a type error) while still declaring the property on
// every member, which lets the component destructure it straight off its props
// instead of casting the union apart. That matters beyond tidiness — the
// `surface-consumer-classname` ast-grep rule matches a JSX attribute by name,
// and a forwarded prop whose name the rule does not know about is a gap rather
// than a violation.
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
 *
 * The dev-mode assertion covers the half the type boundary cannot see. An
 * `as any` cast, an untyped re-export, or a JS-boundary call defeats
 * `SurfaceVariantProps`, but the runtime values still reach CVA — and CVA drops
 * an unknown variant value SILENTLY, so `emphasis: "bogus" as any` renders a
 * row with no edge while looking clean to a role-only check. The assertion
 * refuses that, the inherited-`__proto__` smuggling shape (whose keys a
 * syntactic walk cannot see but CVA resolves through the prototype chain), and
 * an `emphasis` whose role is not `well`. It is a no-op in production, so the
 * deployed recipe's runtime cost is unchanged.
 */
export function surfaceVariants(props?: SurfaceVariantProps): string {
  if (process.env.NODE_ENV !== "production") assertSurfaceOptions(props);
  return surfaceRecipe(props as SurfaceRecipeProps);
}

/**
 * The emphasis domain the runtime assertion enforces, typed EXHAUSTIVELY against the
 * public `SurfaceEmphasis` union rather than restated as a `Set<string>`.
 *
 * `Record<SurfaceEmphasis, true>` is the load-bearing part. The deleted analyzer proved
 * this domain by reading the live `cva` config and the exported union out of the program
 * and asserting all three sets were EQUAL, so an addition, a removal or a rename failed
 * loudly. A hand-written `Set<string>` recovers none of that: it accepts any string, so a
 * new `emphasis` variant added to the recipe would simply never be admitted here and the
 * assertion would reject a legal tuple at runtime instead of failing at build time.
 *
 * With the mapped type, the compiler does the equality check both ways: a variant added
 * to the recipe widens `SurfaceEmphasis` and makes this object missing a key, and a
 * variant removed makes it an excess property. `pnpm typecheck` is the gate.
 */
const SURFACE_EMPHASIS_DOMAIN: Readonly<Record<SurfaceEmphasis, true>> = {
  hairline: true,
  "drop-candidate": true,
};

function assertSurfaceOptions(raw: unknown): void {
  if (raw == null || typeof raw !== "object") return;
  const options = raw as Record<string, unknown>;
  // The `{ __proto__: { role, emphasis } }` shape: `Object.keys` sees nothing,
  // but CVA resolves the inherited fields through the prototype chain and emits
  // the forbidden tuple. Refuse the whole bag when its prototype is not the
  // standard `Object.prototype` -- the only way an object literal reaches this
  // branch is the `__proto__:` setter, and every other shape (`Object.create`,
  // `Object.setPrototypeOf`, a class instance) is refused rather than modelled.
  // `{ ["__proto__"]: X }` and the `{ __proto__ }` shorthand create ordinary
  // own properties and stay harmless.
  if (Object.getPrototypeOf(options) !== Object.prototype) {
    throw new Error(
      "surfaceVariants: an options object whose prototype is not Object.prototype is refused — its inherited keys are invisible to a syntactic walk but resolve through the prototype chain at runtime",
    );
  }
  const emphasis = options.emphasis;
  if (emphasis === undefined) return;
  // Every present emphasis must be a public SurfaceEmphasis. CVA drops an
  // unknown variant value SILENTLY, so an unprovable `any` and a bogus literal
  // both render a row with no edge while looking clean to a role-only check.
  if (
    typeof emphasis !== "string" ||
    !Object.prototype.hasOwnProperty.call(SURFACE_EMPHASIS_DOMAIN, emphasis)
  ) {
    throw new Error(
      `surfaceVariants: emphasis '${String(emphasis)}' is not a public SurfaceEmphasis; CVA would drop it silently and the row would render with no edge`,
    );
  }
  // `emphasis` describes the edge of a RECESSED ROW and is legal only on `well`.
  // An absent `role` defaults to the recipe's own default (`surface`), which is
  // not a well, so the implicit-default case fails closed too.
  const role = options.role ?? "surface";
  if (role !== "well") {
    throw new Error(
      `surfaceVariants: emphasis is the edge of a recessed row and is legal only on role="well", got role="${String(role)}"`,
    );
  }
}
