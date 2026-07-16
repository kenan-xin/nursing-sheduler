import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The design system (T03) defines custom font-size tokens on the `text-*`
// namespace (text-display / cardhead / title / body / meta / label / …). Out of
// the box, tailwind-merge cannot distinguish these from text-COLOR utilities
// (text-ink, text-onbrand, …): it treats every unknown `text-*` as a color, so
// when a size and a color both appear it drops one — which silently stripped
// button text colors. Registering the custom sizes as the `font-size` group lets
// size and color merge independently. Standard shadcn-on-custom-scale fix;
// backward-compatible with existing usage.
const twMerge = extendTailwindMerge({
  extend: {
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
