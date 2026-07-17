"use client";

import { useTheme, type Accent, type Density } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FaSun, FaMoon } from "@/components/icons";

// Icon button that flips light/dark. Icon reflects the theme it switches TO.
// An optional `className` overrides the default 36px icon size — the SideNav
// footer passes `size-[34px]` to match the prototype's 34×34 theme control
// (SideNav.dc.html:54, audit MAJOR 5); tailwind-merge lets it win over `size-9`.
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

const DENSITIES: Density[] = ["compact", "comfortable", "spacious"];

// Segmented control for the density multiplier (Compact 0.9 / Comfortable 1.0 /
// Spacious 1.16) — drives both spacing and the fluid type scale.
export function DensityControl() {
  const { density, setDensity } = useTheme();
  return (
    <div className="inline-flex border border-line" role="group" aria-label="Density">
      {DENSITIES.map((d) => (
        <Button
          key={d}
          variant={density === d ? "default" : "ghost"}
          size="sm"
          onClick={() => setDensity(d)}
          aria-pressed={density === d}
          className="rounded-none capitalize"
        >
          {d}
        </Button>
      ))}
    </div>
  );
}

// Selectable accent (README line 116). Each swatch renders in the accent it
// selects; brand/brandink/brandtint re-derive from --accent-color via color-mix.
const ACCENTS: { value: Accent; hex: string }[] = [
  { value: "blue", hex: "#2360c4" },
  { value: "teal", hex: "#0e7490" },
  { value: "magenta", hex: "#b0357a" },
  { value: "slate", hex: "#3f4a63" },
];

export function AccentControl() {
  const { accent, setAccent } = useTheme();
  return (
    <div className="inline-flex gap-1" role="group" aria-label="Accent">
      {ACCENTS.map((a) => (
        <button
          key={a.value}
          type="button"
          onClick={() => setAccent(a.value)}
          aria-label={`${a.value} accent`}
          aria-pressed={accent === a.value}
          title={a.value}
          data-accent-swatch={a.value}
          className={cn(
            "size-6 rounded-none border outline-none focus-visible:ring-2 focus-visible:ring-brand",
            accent === a.value ? "border-ink" : "border-line",
          )}
          style={{ background: a.hex }}
        />
      ))}
    </div>
  );
}
