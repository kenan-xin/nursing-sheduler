"use client";

import { useTheme, type Accent } from "@/components/theme/theme-provider";
import { ACCENTS } from "@/components/theme/theme-store";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FaSun, FaMoon } from "@/components/icons";

// Icon button that flips light/dark. Icon reflects the theme it switches TO.
// An optional `className` overrides the default 36px icon size — the SideNav
// footer passes `size-[34px]` to match the prototype's 34×34 theme control
// (SideNav.dc.html:54, audit MAJOR 5). The size it overrides is `size-control`
// (the `icon` variant's absolute token), not Tailwind's stock `size-9`; the
// override only actually wins because `lib/utils.ts` registers the control sizes
// on tailwind-merge's spacing scale.
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={className}
    >
      {theme === "dark" ? <FaSun /> : <FaMoon />}
    </Button>
  );
}

// The four v2 accents (adoption record D4), rendered through the shared Base UI
// ToggleGroup shell that F2 publishes — no Radix `type`/`asChild`, no
// wrapper-only trigger, and no caller-owned visual override.
//
// Three things are load-bearing:
//   • the ORDER and membership come from `ACCENTS` in the store, so this control
//     cannot drift from the allowlist the pre-paint script and CSS agree on;
//   • each swatch previews its accent through `data-accent-swatch`, resolved by
//     the single CSS authority in globals.css. No colour literal lives here —
//     the component states the CHOICE, never a paint;
//   • the live value is still resolved in CSS from `data-accent` on <html>, and
//     --brandink/--brandtint derive per theme, so nothing here ever writes a
//     resolved colour to the DOM.
export function AccentControl() {
  const { accent, setAccent } = useTheme();
  return (
    <ToggleGroup<Accent>
      aria-label="Accent"
      size="swatch"
      value={[accent]}
      onValueChange={(next) => {
        // Base UI single-select emits [] when the pressed item is pressed again.
        // Accent is a required axis with no "none" state, so an empty change can
        // never be applied as-is — that would silently unset the user's choice.
        //
        // It re-asserts the CURRENT accent rather than returning early, which
        // keeps re-clicking the active swatch a way to PIN it. That matters for
        // the default: teal is what an unset accent renders as, so without this a
        // user who deliberately picked teal would persist nothing and would be
        // moved off it if the default ever changed.
        setAccent(next.length > 0 ? next[0] : accent);
      }}
    >
      {ACCENTS.map((value) => (
        <ToggleGroupItem key={value} value={value} aria-label={`${value} accent`} title={value}>
          <span data-accent-swatch={value} aria-hidden className="size-4 rounded-chip" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
