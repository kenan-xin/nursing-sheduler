import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only resolves a conflict between two classes it can CLASSIFY.
// A utility built on a custom theme value is invisible to it out of the box, so
// it keeps both classes and lets emitted CSS order decide the winner silently.
// This project has now been bitten by that twice — once on the custom type scale
// and once on the custom control sizes — and both registrations live below.

/**
 * The v2 control and touch sizes, as they are spelled in a utility.
 *
 * `globals.css` registers these in Tailwind's `--spacing-*` namespace
 * (`--spacing-control`, `--spacing-touch`, …), which makes them valid values for
 * EVERY spacing-derived utility — `h-control`, `size-control`, `min-h-touch`,
 * `w-control`, `p-control`, `gap-touch`, and so on. `lib/utils.test.ts` reads
 * the stylesheet and fails if this list and that namespace ever diverge.
 */
export const CONTROL_SPACING_TOKENS = ["control-sm", "control", "control-lg", "touch"] as const;

const twMerge = extendTailwindMerge({
  extend: {
    // Registered on the `spacing` THEME SCALE rather than patched into
    // individual class groups. tailwind-merge's `h`, `w`, `size`, `min-h`,
    // `min-w`, `max-*`, `p*`, `m*` and `gap*` groups all end in the same
    // `fromTheme('spacing')` getter, so one registration teaches every one of
    // them at once — which is what mirrors Tailwind's own namespace and leaves
    // no group still holding the trap.
    //
    // Without this, tailwind-merge could not classify `size-control` at all: it
    // kept BOTH that class and the caller's `size-[34px]`, and emitted CSS order
    // silently decided the winner. 33 call sites overrode a control size through
    // `className` and every one of them was being ignored — the sidebar footer
    // theme button rendered 36px against an explicit `size-[34px]`, which is the
    // only one any test caught. Same bug class as the `font-size` entry below,
    // which is why both live here.
    //
    // Note what this deliberately does NOT do: `min-h-*` and `min-w-*` are their
    // own groups, so a caller shrinking a control with `h-8` still keeps the
    // primitive's `pointer-coarse:min-h-touch`. The coarse-pointer minimum is
    // not something a call site can merge away.
    theme: {
      spacing: [...CONTROL_SPACING_TOKENS],
    },
    // The design system (T03) defines custom font-size tokens on the `text-*`
    // namespace (text-display / cardhead / title / body / meta / label / …).
    // Unclassified, tailwind-merge treats every unknown `text-*` as a COLOR, so
    // when a size and a color both appear it drops one — which silently stripped
    // button text colors. Registering the sizes as `font-size` lets size and
    // color merge independently.
    classGroups: {
      "font-size": [
        {
          text: [
            "display",
            "h2",
            "cardhead",
            "h3",
            "title",
            "body",
            "meta",
            "label",
            "label-md",
            "label-lg",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
