"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { InfoTip } from "@/components/ui/info-tip";
import { Skeleton, SkeletonCard, SkeletonText } from "@/components/ui/skeleton";
import { ThemeToggle, AccentControl } from "@/components/theme/theme-toggle";
import { AppVersion } from "@/components/app-version";
import { FaPlus, FaTrash, FaCircleCheck, FaSpinner, FaPen } from "@/components/icons";

// Living style reference. Exercises the ported token system end-to-end: palette
// (light + dark via the toggle), the fluid type scale, the spacing scale, shadows,
// motion, both breakpoint ladders, the restyled shadcn/Base UI components,
// skeleton primitives, and the theme + accent controls. Each section carries a
// data-testid so the acceptance Playwright/vitest checks can target it.
//
// This page is the guide, so it states the rules it embodies rather than only
// demonstrating them: the notes below are the non-obvious facts a reader would
// otherwise get wrong (--error vs --error-strong, --on-ink not inverting, the
// baked 0.9 spacing baseline, and which breakpoint ladder to reach for).

type ColorToken = { name: string; note?: string };

// Every `--color-*` design token from globals.css `@theme inline`, in declaration
// order. `sidebar` comes from the shadcn alias block but is a real shell surface,
// so it stays. Keep this list complete — an omission here is how a dev ends up
// reaching for the wrong token (see the --error-strong note).
const COLOR_TOKENS: readonly ColorToken[] = [
  { name: "ink" },
  { name: "ink2" },
  { name: "ink3", note: "tertiary labels only — deliberately sub-AA" },
  { name: "faint", note: "placeholders only — deliberately sub-AA" },
  { name: "on-ink", note: "stays light in BOTH themes — does not invert with --ink" },
  { name: "bg" },
  { name: "surface" },
  { name: "panel" },
  { name: "panel-alt" },
  { name: "sidebar" },
  { name: "chrome", note: "dark in both themes" },
  { name: "line" },
  { name: "line2" },
  { name: "rule", note: "hard divider — heavier than --line/--line2" },
  { name: "brand", note: "= --accent-color" },
  { name: "brandink", note: "color-mix — light: as-is, dark: 60% on white" },
  { name: "brandtint", note: "color-mix — light: 9% on white, dark: 26% on --bg" },
  { name: "onbrand", note: "foreground on brand fills" },
  { name: "success" },
  { name: "successtint" },
  { name: "warn" },
  { name: "warntint" },
  { name: "error", note: "STATUS ONLY — white on this is 4.44:1" },
  { name: "errortint" },
  { name: "error-strong", note: "destructive ACTION fills — white ≈5.44:1, clears AA" },
];

// All ten design-named `text-*` steps. `h2`/`h3` are aliases of `display`/`title`
// (--t-h2 → --fs-xl, --t-h3 → --fs-lg), which is why the alias note matters: two
// names, one size. Each row's note records current usage so a dead token is
// visible as dead rather than looking like a choice.
const TYPE_STEPS = [
  { name: "display", cls: "text-display font-heading font-bold", note: "base-h × 0.9" },
  { name: "h2", cls: "text-h2 font-heading font-bold", note: "alias of display — unused today" },
  { name: "cardhead", cls: "text-cardhead font-heading font-semibold", note: "card titles" },
  { name: "title", cls: "text-title font-heading font-semibold", note: "base-h × 0.6 × 0.9" },
  { name: "h3", cls: "text-h3 font-heading font-semibold", note: "alias of title" },
  { name: "body", cls: "text-body", note: "base-b × 0.9 — the body default" },
  { name: "meta", cls: "text-meta text-ink2", note: "secondary / descriptions" },
  {
    name: "label",
    cls: "text-label uppercase tracking-[0.03em] text-ink3",
    note: "eyebrow — +.03em tracking",
  },
  {
    name: "label-md",
    cls: "text-label-md uppercase tracking-[0.03em] text-ink3",
    note: "base-l × 1.13 × 0.9",
  },
  {
    name: "label-lg",
    cls: "text-label-lg uppercase tracking-[0.03em] text-ink3",
    note: "base-l × 1.27 × 0.9",
  },
] as const;

// The 4px grid is baked at 0.9 (density was removed as a product knob — see
// globals.css). `resolved` is the literal each token computes to, because the bar
// alone reads as a 4px grid and the numbers are the part a reader gets wrong.
const SPACE_STEPS = [
  { name: "1", cssVar: "--space-1", grid: "4px", resolved: "3.6px" },
  { name: "2", cssVar: "--space-2", grid: "8px", resolved: "7.2px" },
  { name: "3", cssVar: "--space-3", grid: "12px", resolved: "10.8px" },
  { name: "4", cssVar: "--space-4", grid: "16px", resolved: "14.4px" },
  { name: "5", cssVar: "--space-5", grid: "20px", resolved: "18px" },
  { name: "6", cssVar: "--space-6", grid: "24px", resolved: "21.6px" },
  { name: "8", cssVar: "--space-8", grid: "32px", resolved: "28.8px" },
  { name: "12", cssVar: "--space-12", grid: "48px", resolved: "43.2px" },
] as const;

// `use` records where each token is ACTUALLY reached for, not what its name
// suggests — the two diverge for shadow-toast, and a guide that repeats the name
// instead of the usage is how the divergence survives.
const SHADOWS = [
  { name: "shadow-toast", cls: "shadow-toast", use: "no production surface" },
  { name: "shadow-dialog", cls: "shadow-dialog", use: "modals, tooltips" },
  { name: "shadow-side", cls: "shadow-side", use: "side drawers, mobile nav, toasts" },
] as const;

// The two ladders are disjoint on purpose and easy to conflate. Snapping a layout
// grid to the nearest TYPE step once drifted layouts 40–124px and shipped three
// cards where the design shows two — reach for LAYOUT when porting a `.ns-*` rule.
const TYPE_LADDER = ["480", "768", "1024", "1280", "1440", "1920"] as const;

const LAYOUT_LADDER = [
  { variant: "panes2:", px: "600px", from: ".ns-panes2 — two-pane transfer list" },
  { variant: "formgrid:", px: "720px", from: ".ns-formgrid — form two-up" },
  { variant: "wizgrid:", px: "760px", from: ".ns-wizgrid — wizard two-up" },
  { variant: "grid2:", px: "900px", from: ".ns-grid2 — Dates / Save-Load / Optimize" },
  { variant: "grid3:", px: "1100px", from: ".ns-grid3 — three-up card grid" },
  { variant: "wizgrid3:", px: "1200px", from: ".ns-wizgrid3 — wizard three-up" },
] as const;

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={id} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-h3 font-semibold tracking-tight">{title}</h2>
        {intro ? <p className="text-meta text-ink2">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

// Rule rows for the Conventions section: the term, the rule, and — where one
// exists — the guard that fails if the rule is broken.
function Rule({
  term,
  children,
  guard,
}: {
  term: string;
  children: React.ReactNode;
  guard?: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line2 pb-3 last:border-0 last:pb-0 sm:flex-row sm:gap-4">
      <span className="w-40 shrink-0 font-mono text-label uppercase tracking-[0.03em] text-ink3">
        {term}
      </span>
      <div className="flex flex-1 flex-col gap-1">
        <p className="text-body text-ink2">{children}</p>
        {guard ? <p className="font-mono text-label text-ink3">guard: {guard}</p> : null}
      </div>
    </div>
  );
}

export default function StyleReferencePage() {
  const [switchOn, setSwitchOn] = useState(true);
  const [loading, setLoading] = useState(true);
  // Remounts the fade demo so a one-shot animation can be replayed on demand.
  const [fadeKey, setFadeKey] = useState(0);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-display font-extrabold tracking-tight">Design system</h1>
          <p className="text-meta text-ink2">
            Nurse scheduler tokens — ported from the design prototype.{" "}
            <span className="text-ink3">
              Source of truth: <span className="font-mono">app/globals.css</span>.
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-testid="controls">
          <AccentControl />
          <ThemeToggle />
        </div>
      </header>

      <Separator />

      <Section
        id="palette"
        title="Palette"
        intro="Every design color token, in declaration order. Flip the theme and accent above — all of these re-resolve."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {COLOR_TOKENS.map((token) => (
            <div
              key={token.name}
              className="flex flex-col gap-1"
              data-testid={`swatch-${token.name}`}
            >
              <div
                className="h-14 w-full border border-line"
                style={{ background: `var(--${token.name})` }}
              />
              <span className="font-mono text-label text-ink2">--{token.name}</span>
              {token.note ? <span className="text-label text-ink3">{token.note}</span> : null}
            </div>
          ))}
        </div>
        <p className="border-l-2 border-error-strong bg-panel px-4 py-3 text-meta text-ink2">
          <span className="font-semibold text-ink">Picking a red:</span>{" "}
          <span className="font-mono">--error</span> is the canonical status hue and is what the
          error badge and tint are built from. Destructive <em>action fills</em> use{" "}
          <span className="font-mono">--error-strong</span> instead, because white on{" "}
          <span className="font-mono">--error</span> is only 4.44:1 and fails WCAG AA.
        </p>
      </Section>

      <Section
        id="typography"
        title="Type scale"
        intro="Fluid — every step is derived from --base-h / --base-b / --base-l, which step up across the type ladder below."
      >
        <div className="flex flex-col gap-3 border border-line bg-surface p-5">
          {TYPE_STEPS.map((step) => (
            <div
              key={step.name}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
              data-testid={`type-${step.name}`}
            >
              <span className="w-24 shrink-0 font-mono text-label text-ink3">{step.name}</span>
              <span className={step.cls}>The quick brown fox</span>
              <span className="text-label text-ink3">{step.note}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="spacing"
        title="Spacing scale"
        intro="A 4px grid baked at 0.9. The resolved value is what ships — --space-4 is 14.4px, not 16px — and Tailwind's --spacing base carries the same factor, so p-* / gap-* sit on this grid too."
      >
        <div className="flex flex-col gap-2 border border-line bg-surface p-5">
          {SPACE_STEPS.map((step) => (
            <div
              key={step.name}
              className="flex items-center gap-4"
              data-testid={`space-${step.name}`}
            >
              <span className="w-16 shrink-0 font-mono text-label text-ink3">
                space-{step.name}
              </span>
              <div className="h-4 bg-brand" style={{ width: `var(${step.cssVar})` }} />
              <span className="font-mono text-label text-ink2">
                {step.resolved}
                <span className="text-ink3"> · {step.grid} × 0.9</span>
              </span>
            </div>
          ))}
        </div>
        <p className="text-meta text-ink3">
          Density is not a knob. The control was unreachable in the product and was removed; 0.9 is
          baked in as a literal because it is what shipped, so there is no{" "}
          <span className="font-mono">--density</span> to turn.
        </p>
      </Section>

      <Section
        id="shadows"
        title="Shadows"
        intro="Three elevation tokens. Elevation is rare here — it marks surfaces that float above the page, and flat surfaces use a hairline border instead."
      >
        <div className="grid gap-6 bg-panel p-6 sm:grid-cols-3">
          {SHADOWS.map((shadow) => (
            <div key={shadow.name} className="flex flex-col gap-2">
              <div
                className={`flex h-20 items-center justify-center border border-line bg-surface px-3 text-center text-meta text-ink3 ${shadow.cls}`}
              >
                {shadow.use}
              </div>
              <span className="font-mono text-label text-ink2">{shadow.name}</span>
            </div>
          ))}
        </div>
        <p className="text-meta text-ink3">
          Two loose ends, recorded rather than smoothed over:{" "}
          <span className="font-mono">--shadow-toast</span> is declared, but the only thing that
          reaches for it is the demo above — no production surface uses it, and{" "}
          <span className="font-mono">.ns-toast</span> itself uses{" "}
          <span className="font-mono">--shadow-side</span>. And the{" "}
          <span className="font-mono">Switch</span> thumb carries Tailwind&apos;s default{" "}
          <span className="font-mono">shadow-sm</span>, the one shadow in the kit that is not a
          token.
        </p>
      </Section>

      <Section
        id="motion"
        title="Motion"
        intro="Two durations, one easing curve, three named animations. All of it is suppressed under prefers-reduced-motion by a global rule."
      >
        <div className="flex flex-col gap-4 border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-40 shrink-0 font-mono text-label text-ink3">duration + ease</span>
            <div className="h-10 w-28 bg-panel transition-colors duration-fast hover:bg-brandtint" />
            <span className="font-mono text-label text-ink2">duration-fast · 0.15s</span>
            <div className="h-10 w-28 bg-panel transition-colors duration-base hover:bg-brandtint" />
            <span className="font-mono text-label text-ink2">duration-base · 0.22s</span>
            <span className="font-mono text-label text-ink3">
              ease-standard · cubic-bezier(.4, 0, .2, 1)
            </span>
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="w-40 shrink-0 font-mono text-label text-ink3">animations</span>
            <div className="flex items-center gap-2">
              <div key={fadeKey} className="h-10 w-28 animate-fade bg-brandtint" />
              <Button size="sm" variant="outline" onClick={() => setFadeKey((k) => k + 1)}>
                Replay
              </Button>
              <span className="font-mono text-label text-ink2">animate-fade</span>
            </div>
            <div className="flex items-center gap-2 text-ink2">
              <FaSpinner className="animate-spin-slow" aria-hidden />
              <span className="font-mono text-label">animate-spin-slow</span>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-10 w-28" />
              <span className="font-mono text-label text-ink2">animate-shimmer</span>
            </div>
          </div>
        </div>
      </Section>

      <Section
        id="breakpoints"
        title="Breakpoints — two disjoint ladders"
        intro="These do not line up, and conflating them is a real failure mode: snapping layout grids to the nearest type step once drifted layouts 40–124px and shipped three cards where the design shows two."
      >
        <div className="grid gap-4 grid2:grid-cols-2">
          <div className="flex flex-col gap-3 border border-line bg-surface p-5">
            <div className="flex flex-col gap-1">
              <h3 className="font-heading text-title font-semibold">Type ladder</h3>
              <p className="text-meta text-ink2">
                Steps <span className="font-mono">--base-h / --base-b / --base-l</span> up. Use for
                everything that is not a ported <span className="font-mono">.ns-*</span> layout
                rule.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {TYPE_LADDER.map((px) => (
                <span
                  key={px}
                  className="border border-line2 bg-panel px-2 py-1 font-mono text-label text-ink2"
                >
                  {px}px
                </span>
              ))}
            </div>
            <p className="text-meta text-ink3">
              Plus <span className="font-mono">sm:</span> 640px and{" "}
              <span className="font-mono">nav:</span> 920px — the pivot where the{" "}
              <span className="font-mono">--sidebar-w</span> (280px) sidebar gives way to the mobile
              nav.
            </p>
          </div>

          <div className="flex flex-col gap-3 border border-line bg-surface p-5">
            <div className="flex flex-col gap-1">
              <h3 className="font-heading text-title font-semibold">Layout ladder</h3>
              <p className="text-meta text-ink2">
                One variant per prototype layout class, named for the rule it implements. Reach for
                these when porting a <span className="font-mono">.ns-*</span> grid.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              {LAYOUT_LADDER.map((bp) => (
                <div key={bp.variant} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="w-20 shrink-0 font-mono text-label text-ink">{bp.variant}</span>
                  <span className="w-16 shrink-0 font-mono text-label text-ink2">{bp.px}</span>
                  <span className="text-label text-ink3">{bp.from}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section
        id="components"
        title="Components"
        intro="Restyled shadcn / Base UI primitives. Square corners, token palette only, no hard-coded colors."
      >
        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
            Button — variants
          </span>
          <div className="flex flex-wrap gap-3">
            <Button>
              <FaPlus /> Primary
            </Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">
              <FaTrash /> Delete
            </Button>
            <Button variant="link">Link</Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
            Button — sizes
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small · h-8</Button>
            <Button size="default">Default · h-9</Button>
            <Button size="lg">Large · h-11</Button>
            <Button size="icon" aria-label="Edit" title="Icon · size-9">
              <FaPen />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">Badge</span>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="brand">Brand</Badge>
            <Badge variant="success">
              <FaCircleCheck /> Saved
            </Badge>
            <Badge variant="warn">Caution</Badge>
            <Badge variant="error">Infeasible</Badge>
            <Badge variant="neutral">Neutral</Badge>
            <Badge variant="outline">Outline</Badge>
          </div>
          <p className="text-meta text-ink3">
            Status badges carry the hue on the border and keep text at{" "}
            <span className="font-mono">--ink</span>, so meaning never rests on color contrast
            alone.
          </p>
        </div>

        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Ward setup</CardTitle>
            <CardDescription>A restyled card on the surface token.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ward-name">Ward name</Label>
              <Input id="ward-name" placeholder="e.g. Medical Ward 3B" />
            </div>
            <div className="flex flex-col gap-1.5">
              {/* InfoTip sits beside the Label, not inside it — a button nested in a
                  <label> would have the label's click target swallow it. */}
              <div className="flex items-center gap-1.5">
                <Label htmlFor="ward-shift">Default shift</Label>
                <InfoTip
                  label="Default shift"
                  text="The one native-select treatment for the app: the caret is ours, drawn in reserved padding a caller's className cannot collapse."
                />
              </div>
              <Select id="ward-shift" fullWidth defaultValue="day">
                <option value="day">Day</option>
                <option value="night">Night</option>
                <option value="late">Late</option>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={switchOn} onCheckedChange={setSwitchOn} id="anonymize" />
              <Label htmlFor="anonymize" className="normal-case tracking-normal text-ink2">
                Anonymize export
              </Label>
            </div>
          </CardContent>
          <CardFooter>
            <Button size="sm">Save</Button>
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
          </CardFooter>
        </Card>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
            Separator
          </span>
          <div className="flex items-center gap-4 border border-line bg-surface p-5">
            <span className="text-meta text-ink2">horizontal</span>
            <Separator className="flex-1" />
            <span className="text-meta text-ink2">vertical</span>
            <Separator orientation="vertical" className="h-6" />
            <span className="font-mono text-label text-ink3">--line2 hairline</span>
          </div>
        </div>
      </Section>

      <Section
        id="skeletons"
        title="Skeletons"
        intro="Shimmer from structure: each skeleton reproduces the box it stands in for, in both width and height, rather than dropping in a generic spinner."
      >
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => setLoading((v) => !v)}>
            Toggle loading
          </Button>
          <span className="text-meta text-ink2">shimmer-from-structure</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {loading ? (
            <SkeletonCard />
          ) : (
            // Structural twin of <SkeletonCard>: one title line, one description
            // line, two single-line body rows, a small footer button — so the
            // resolved box matches the skeleton box the acceptance test compares.
            <Card>
              <CardHeader>
                <CardTitle>Loaded card</CardTitle>
                <CardDescription>Content resolved.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <p className="text-body text-ink2 truncate">
                  Occupies the same box as the skeleton.
                </p>
                <p className="text-body text-ink2 truncate">Width and height both match.</p>
              </CardContent>
              <CardFooter>
                <Button size="sm">Action</Button>
              </CardFooter>
            </Card>
          )}
          <div className="flex flex-col gap-3 border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10" />
              <div className="flex-1">
                <SkeletonText lines={2} />
              </div>
            </div>
            <SkeletonText lines={3} />
          </div>
        </div>
      </Section>

      <Section
        id="conventions"
        title="Conventions"
        intro="Rules this page embodies. Most are test-enforced — the guard is named where one exists."
      >
        <div className="flex flex-col gap-3 border border-line bg-surface p-5">
          <Rule term="Radius" guard="e2e — every control in <main> must compute 0px">
            0 everywhere. Square corners are the design, not an oversight; every{" "}
            <span className="font-mono">--radius*</span> token resolves to{" "}
            <span className="font-mono">0px</span>.
          </Rule>
          <Rule term="Fonts">
            Hanken Grotesk for body and UI (<span className="font-mono">font-sans</span>), Figtree
            for display and headings (<span className="font-mono">font-heading</span>), Spline Sans
            Mono for numerals and token names (<span className="font-mono">font-mono</span>). Wired
            via next/font in <span className="font-mono">app/layout.tsx</span>.
          </Rule>
          <Rule term="Icons" guard="vitest — no source file may import lucide-react">
            react-icons Font Awesome 6, imported from the{" "}
            <span className="font-mono">@/components/icons</span> barrel. Add an icon by
            re-exporting it there. <span className="font-mono">lucide-react</span> is in the dep
            tree only because the manifest is frozen — do not import it.
          </Rule>
          <Rule term="Accent">
            Four selectable accents (blue, teal, magenta, slate) set via{" "}
            <span className="font-mono">data-accent</span> on{" "}
            <span className="font-mono">&lt;html&gt;</span>.{" "}
            <span className="font-mono">--brandink</span> and{" "}
            <span className="font-mono">--brandtint</span> are never authored — they{" "}
            <span className="font-mono">color-mix</span> off{" "}
            <span className="font-mono">--accent-color</span>, and mix differently per theme (light:
            accent as-is, 9% on white; dark: 60% on white, 26% on{" "}
            <span className="font-mono">--bg</span>).
          </Rule>
          <Rule term="Theme">
            Class-based — <span className="font-mono">.dark</span> on{" "}
            <span className="font-mono">&lt;html&gt;</span>, which is what the Tailwind{" "}
            <span className="font-mono">dark:</span> variant keys off. Persisted as{" "}
            <span className="font-mono">ns-theme</span> /{" "}
            <span className="font-mono">ns-accent</span> and applied before paint so there is no
            hydration flash.
          </Rule>
          <Rule term="Toast">
            One treatment, applied globally by <span className="font-mono">.ns-toast</span>:
            bottom-center, <span className="font-mono">--ink</span> surface with{" "}
            <span className="font-mono">--on-ink</span> text, a 3px{" "}
            <span className="font-mono">--success</span> left rule and a green checkmark. Sonner
            renders it; call sites pass no styling.
          </Rule>
          <Rule term="Reduced motion" guard="e2e — skeleton animation must drop below 0.05s">
            A global <span className="font-mono">prefers-reduced-motion</span> rule collapses every
            animation, transition and smooth scroll. Motion tokens need no per-component guard.
          </Rule>
          <Rule term="Raw colors" guard="vitest — source guard over components/ui/**">
            None. Every fill, text and border resolves to a token, which is what lets the theme and
            accent axes work at all.
          </Rule>
        </div>
      </Section>

      <Separator />

      <footer className="flex items-center justify-between text-meta text-ink3">
        <span>Nurse Scheduler</span>
        <AppVersion />
      </footer>
    </main>
  );
}
