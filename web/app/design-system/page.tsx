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
  SelectedCard,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { InfoTip } from "@/components/ui/info-tip";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton, SkeletonCard, SkeletonText } from "@/components/ui/skeleton";
import { ThemeToggle, AccentControl } from "@/components/theme/theme-toggle";
import { AppVersion } from "@/components/app-version";
import { cn } from "@/lib/utils";
import { FaPlus, FaTrash, FaSpinner, FaPen, FaTriangleExclamation } from "@/components/icons";

// Living style reference for v2 "Mint Canvas, Warm Ink". It exercises the whole
// contract: the palette in light/dark across all four accents, the fluid type and
// spacing scales, the L0->L2 surface ladder, the radius roles, absolute control
// sizing with real coarse-pointer targets, both breakpoint ladders, the
// shadcn/Base UI primitives and overlay shells, and the skeleton primitives.
//
// This page is the guide, so it STATES the rules it embodies rather than only
// demonstrating them. The notes below are the non-obvious facts a reader would
// otherwise get wrong: `--error` vs `--fill-error`, why the accent pairs are
// declared twice, that radius is a role rather than a global step, and which of
// the two breakpoint ladders to reach for.

type ColorToken = { name: string; note?: string };

// Every `--color-*` design token from globals.css `@theme inline`, in declaration
// order. Keep this list complete — an omission here is how a dev ends up reaching
// for the wrong token (see the --fill-error note).
const COLOR_TOKENS: readonly ColorToken[] = [
  { name: "ink" },
  { name: "ink2" },
  { name: "ink3", note: "tertiary labels only — deliberately sub-AA" },
  { name: "faint", note: "placeholders only — deliberately sub-AA" },
  { name: "on-ink", note: "foreground on an --ink fill — inverts with it" },
  { name: "bg", note: "L0 — the recessed page plane" },
  { name: "surface", note: "L1 — cards, panes, sticky top bar" },
  { name: "surface2", note: "L2 — dialogs, drawers, popovers" },
  { name: "panel", note: "wells and header bands ONLY — never zebra" },
  { name: "panel-alt", note: "zebra + generic hover" },
  { name: "sidebar", note: "the navigation plane" },
  { name: "chrome", note: "aliases the live --brand (app-mark tile)" },
  { name: "line", note: "primary hairline" },
  { name: "line2", note: "lighter hairline / inner dividers" },
  { name: "rule", note: "emphasis rule — heavier than --line/--line2" },
  { name: "scrim", note: "theme-specific modal scrim — never a raw black alpha" },
  { name: "brand", note: "the live accent — resolved in CSS from data-accent" },
  { name: "brandink", note: "derived — light: 82% brand on black; dark: 60% on white" },
  { name: "brandtint", note: "derived — light: 10% brand on --surface; dark: 26%" },
  { name: "onbrand", note: "foreground on brand fills" },
  { name: "success" },
  { name: "successtint" },
  { name: "successink", note: "pairs with --successtint — 5.48:1 light" },
  { name: "warn" },
  { name: "warntint" },
  { name: "warnink", note: "pairs with --warntint — 4.88:1 light, the tightest pair" },
  { name: "error", note: "STATUS ONLY — pairs with its own tint and ink" },
  { name: "errortint" },
  { name: "errorink", note: "pairs with --errortint — 5.60:1 light" },
  { name: "fill-error", note: "destructive ACTION fills — always with --on-error" },
  { name: "on-error" },
  { name: "fill-warn", note: "exceptional warning ACTIONS only" },
  { name: "on-warn" },
];

// The four accents (adoption record D4). Each row is the CHOICE, not a resolved
// colour: `data-accent` on <html> selects the pair and CSS resolves it per theme,
// so nothing here — and nothing in the store — ever writes a hex.
const ACCENTS = ["teal", "sage", "rose", "plum"] as const;

// All ten design-named `text-*` steps. `h2`/`h3` are aliases of `display`/`title`
// (--t-h2 -> --fs-xl, --t-h3 -> --fs-lg), which is why the alias note matters: two
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

// The radius ROLES. v2 rounds by semantic owner, not by a global step, and the
// generic shadcn `--radius*` scale stays pinned at 0 as the square fallback.
const RADIUS_ROLES = [
  { name: "rounded-card", cls: "rounded-card", px: "16px", use: "cards, panels, dialogs, panes" },
  { name: "rounded-control", cls: "rounded-control", px: "12px", use: "inputs, selects, wells" },
  { name: "rounded-chip", cls: "rounded-chip", px: "9px", use: "badges, tinted chips" },
  { name: "rounded-pill", cls: "rounded-pill", px: "999px", use: "buttons, nav items, switches" },
  { name: "rounded-none", cls: "rounded-none", px: "0px", use: "every data surface — see below" },
] as const;

// `use` records where each token is ACTUALLY reached for, not what its name
// suggests. Six tokens: five general-purpose levels plus one specialized
// directional side-overlay shadow.
const SHADOWS = [
  { name: "shadow-1", cls: "shadow-1", use: "resting L1 — cards, secondary buttons" },
  { name: "shadow-2", cls: "shadow-2", use: "hover / selected / lifted" },
  { name: "shadow-3", cls: "shadow-3", use: "modal layer — dialogs, toast" },
  { name: "shadow-edge", cls: "shadow-edge", use: "sticky-column scroll edge" },
  { name: "shadow-well", cls: "shadow-well", use: "inset planes (inset, never outer)" },
  { name: "shadow-side", cls: "shadow-side", use: "side drawers, mobile nav — specialized" },
] as const;

// The two ladders are disjoint on purpose and easy to conflate. Snapping a layout
// grid to the nearest TYPE step once drifted layouts 40–124px and shipped three
// cards where the design shows two — reach for LAYOUT when porting a `.ns-*` rule.
const TYPE_LADDER = ["480", "768", "1024", "1280", "1440", "1920"] as const;

const LAYOUT_LADDER = [
  { variant: "panes2:", px: "600px", from: ".ns-panes2 — two-pane transfer list" },
  { variant: "formgrid:", px: "720px", from: ".ns-formgrid — form two-up" },
  { variant: "wizgrid:", px: "760px", from: ".ns-wizgrid — wizard two-up" },
  { variant: "grid2:", px: "900px", from: ".ns-grid2 — Dates / Save-Load / Optimise" },
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
        <h2 className="font-heading text-h3 font-semibold tracking-[-0.015em]">{title}</h2>
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

/** A labelled specimen box. `frame` is the recipe/utility string under test. */
function Specimen({
  label,
  note,
  frameClassName,
  children,
}: {
  label: string;
  note?: string;
  frameClassName: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        data-testid={`specimen-${label}`}
        className={cn("flex h-20 items-center justify-center px-3 text-center", frameClassName)}
      >
        {children}
      </div>
      <span className="font-mono text-label text-ink2">{label}</span>
      {note ? <span className="text-label text-ink3">{note}</span> : null}
    </div>
  );
}

export default function StyleReferencePage() {
  const [switchOn, setSwitchOn] = useState(true);
  const [loading, setLoading] = useState(true);
  // Remounts the fade demo so a one-shot animation can be replayed on demand.
  const [fadeKey, setFadeKey] = useState(0);
  const [view, setView] = useState<string[]>(["grid"]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-display font-extrabold tracking-[-0.015em]">
            Design system
          </h1>
          <p className="text-meta text-ink2">
            Mint Canvas, Warm Ink — the v2 token and component contract.{" "}
            <span className="text-ink3">
              Value authority: <span className="font-mono">app/globals.css</span>. Visual canon:{" "}
              <span className="font-mono">DESIGN.md</span>.
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
        intro="Every design colour token, in declaration order. Flip the theme and accent above — all of these re-resolve, and none of them is written by JavaScript."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {COLOR_TOKENS.map((token) => (
            <div
              key={token.name}
              className="flex flex-col gap-1"
              data-testid={`swatch-${token.name}`}
            >
              {/* Legend swatches stay SQUARE (DESIGN.md §5) and reference the token
                  by name — there is no hex literal anywhere on this page. */}
              <div
                className="h-14 w-full rounded-none border border-line"
                style={{ background: `var(--${token.name})` }}
              />
              <span className="font-mono text-label text-ink2">--{token.name}</span>
              {token.note ? <span className="text-label text-ink3">{token.note}</span> : null}
            </div>
          ))}
        </div>
        <p className="border-l-2 border-error bg-panel px-4 py-3 text-meta text-ink2">
          <span className="font-semibold text-ink">Picking a red:</span>{" "}
          <span className="font-mono">--error</span> is the canonical status hue and is what the
          error badge and tint are built from. Destructive <em>action fills</em> use the paired{" "}
          <span className="font-mono">--fill-error</span> +{" "}
          <span className="font-mono">--on-error</span>, because the foreground flips per theme and
          must never be a hardcoded white. Success has no solid pair at all — it stays a quiet
          informational state and never competes with the accent.
        </p>
      </Section>

      <Section
        id="accent"
        title="Accent — four audited pairs, resolved in CSS"
        intro="data-accent on <html> holds the CHOICE. Each accent has an audited light AND dark --brand, so the choice survives a theme change without JavaScript ever writing a resolved colour."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 grid3:grid-cols-4">
          {ACCENTS.map((accent) => (
            <Surface
              key={accent}
              level="surface"
              geometry="card"
              data-testid={`accent-card-${accent}`}
              className="flex flex-col gap-2 p-4"
            >
              <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
                {accent}
              </span>
              {/* Previews the LIVE accent when selected; each card shows the same
                  three roles so the derivation is visible, not asserted. */}
              <div className="flex items-center gap-2">
                <span className="size-6 rounded-chip bg-brand" />
                <span className="size-6 rounded-chip bg-brandtint" />
                <span className="size-6 rounded-chip bg-brandink" />
              </div>
              <Button
                size="sm"
                onClick={() => {
                  document.documentElement.setAttribute("data-accent", accent);
                }}
              >
                Preview
              </Button>
            </Surface>
          ))}
        </div>

        <div
          className={cn(
            "flex flex-col gap-3 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
          <h3 className="font-heading text-title font-semibold">How the pair is derived</h3>
          <div className="flex flex-col gap-1.5 font-mono text-label text-ink2">
            <span>--brandink (light) = color-mix(in srgb, var(--brand) 82%, black)</span>
            <span>--brandtint (light) = color-mix(in srgb, var(--brand) 10%, var(--surface))</span>
            <span>--brandink (dark) = color-mix(in srgb, var(--brand) 60%, white)</span>
            <span>--brandtint (dark) = color-mix(in srgb, var(--brand) 26%, var(--surface))</span>
          </div>
          <p className="text-meta text-ink2">
            Both formulas are inside an{" "}
            <span className="font-mono">@supports (color: color-mix(in srgb, black, white))</span>{" "}
            guard. Every accent/theme selector therefore declares a{" "}
            <strong>static pair FIRST</strong> — the nearest 8-bit sRGB rendering of its own formula
            — and the guarded block later replaces it. Order is load-bearing: a fallback declared
            after the guard would win, and an engine without{" "}
            <span className="font-mono">color-mix()</span> would otherwise paint nothing.
          </p>
          <p className="text-meta text-ink3">
            <span className="font-mono">black</span> and <span className="font-mono">white</span>{" "}
            are derivation ENDPOINTS, not rendered colours — the No-Black Rule constrains resolved
            foreground/background paint, not a mix input. The tint mixes against{" "}
            <span className="font-mono">--surface</span>, so it re-tracks the surface ladder rather
            than drifting off a fixed white.
          </p>
        </div>
      </Section>

      <Section
        id="typography"
        title="Type scale"
        intro="Fluid — every step is derived from --base-h / --base-b / --base-l, which step up across the type ladder below. Headings carry -0.015em; uppercase labels carry +0.03em."
      >
        <div
          className={cn(
            "flex flex-col gap-3 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
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
        <div
          className={cn(
            "flex flex-col gap-2 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
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
          <span className="font-mono">--density</span> to turn. Radius, shadow and control size are
          absolute and deliberately do <em>not</em> ride this multiplier.
        </p>
      </Section>

      <Section
        id="surfaces"
        title="Surface ladder — tone first, shadow second"
        intro="Every surface belongs to a named level, and the level is expressed by tone before elevation. One CVA recipe (surfaceVariants) is the authority; <Surface> is the convenience adapter for ordinary container DOM."
      >
        <div
          className={cn(
            "grid gap-6 p-6 sm:grid-cols-2 grid3:grid-cols-3",
            surfaceVariants({ role: "page", geometry: "square" }),
          )}
        >
          <Specimen
            label="page"
            note="L0 · --bg · no border · no shadow · square"
            frameClassName={cn(surfaceVariants({ role: "page", geometry: "square" }))}
          >
            <span className="text-meta text-ink3">nothing floats free on it</span>
          </Specimen>
          <Specimen
            label="surface"
            note="L1 · --surface · --line · --sh-1"
            frameClassName={cn(surfaceVariants({ role: "surface", geometry: "card" }))}
          >
            <span className="text-meta text-ink2">cards, panes, top bar</span>
          </Specimen>
          <Specimen
            label="selected"
            note="L1 selected · --brand border · --sh-2"
            frameClassName={cn(surfaceVariants({ role: "selected", geometry: "card" }))}
          >
            <span className="text-meta text-ink2">active editor, current step</span>
          </Specimen>
          <Specimen
            label="raised"
            note="L2 · --surface2 · --sh-3"
            frameClassName={cn(surfaceVariants({ role: "raised", geometry: "card" }))}
          >
            <span className="text-meta text-ink2">dialogs, drawers, popovers</span>
          </Specimen>
          <Specimen
            label="well"
            note="inset island · --panel · --sh-well · never an OUTER shadow"
            frameClassName={cn(surfaceVariants({ role: "well", geometry: "control" }))}
          >
            <span className="text-meta text-ink2">summary chips, note strips</span>
          </Specimen>
          <Specimen
            label="band"
            note="full-bleed header band · --panel · flat · SQUARE"
            frameClassName={cn(surfaceVariants({ role: "band", geometry: "square" }))}
          >
            <span className="text-meta text-ink2">table header, pane count band</span>
          </Specimen>
          <Specimen
            label="zebra"
            note="--panel-alt · flat · SQUARE · never --panel"
            frameClassName={cn(surfaceVariants({ role: "zebra", geometry: "square" }))}
          >
            <span className="text-meta text-ink2">striping + generic hover</span>
          </Specimen>
          <Specimen
            label="drop-target"
            note="drag candidate · dashed --brand over --panel-alt · NOT selection"
            frameClassName={cn(surfaceVariants({ role: "drop-target", geometry: "card" }))}
          >
            <span className="text-meta text-ink2">release here</span>
          </Specimen>
          <Specimen
            label="sticky"
            note="single bottom edge · --sh-1 · SQUARE"
            frameClassName={cn(surfaceVariants({ role: "sticky", geometry: "square" }))}
          >
            <span className="text-meta text-ink2">sticky bars and sub-toolbars</span>
          </Specimen>
        </div>

        <div
          className={cn(
            "flex flex-col gap-3 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
          <h3 className="font-heading text-title font-semibold">The contract</h3>
          <p className="text-meta text-ink2">
            <span className="font-mono">
              &lt;Surface level="page|surface|raised|well" geometry="…"&gt;
            </span>{" "}
            is the ordinary-container adapter, and TypeScript admits only the legal tuples —{" "}
            <span className="font-mono">page</span> is always square,{" "}
            <span className="font-mono">raised</span> is always a card. Specialized owners (tables,
            sticky regions, editors, grids) call{" "}
            <span className="font-mono">surfaceVariants()</span> directly, so a role never costs a
            wrapper element.
          </p>
          <p className="text-meta text-ink2">
            Radius is deliberately <strong>not</strong> inferred from tone: a{" "}
            <span className="font-mono">--panel</span> band and a{" "}
            <span className="font-mono">--panel</span> chip are the same role with different
            geometry, and only the owner knows which. What the type system cannot prove is that a
            consumer's <span className="font-mono">className</span> stays layout-only, so an AST
            guard enforces that half.
          </p>
          <p className="text-meta text-ink3">
            Direction of light is fixed: a well never takes an outer shadow, a raised surface never
            takes an inset one, and two surfaces of the same tone are never stacked — nest a well
            instead.
          </p>
          <p className="text-meta text-ink3">
            <span className="font-mono">selected</span> and{" "}
            <span className="font-mono">drop-target</span> are deliberately different roles. A row
            under the pointer mid-drag is neither the current selection nor the active editor, so it
            takes a dashed <span className="font-mono">--brand</span> edge over the hover tone
            rather than borrowing the selection language, which stays reserved for “current”. Motion
            and drag affordances live in the recipe too, because a consumer&apos;s{" "}
            <span className="font-mono">className</span> is layout-only and could not carry them.
          </p>
        </div>
      </Section>

      <Section
        id="radius"
        title="Radius — a role, not a global step"
        intro="Rounding is warmth, not a theme. Four role tokens plus an explicit square, and the generic shadcn --radius* scale stays pinned at 0 as the compatibility fallback."
      >
        <div className="grid gap-4 sm:grid-cols-2 grid3:grid-cols-3">
          {RADIUS_ROLES.map((role) => (
            <div key={role.name} className="flex flex-col gap-1.5">
              <div
                data-testid={`radius-${role.name}`}
                className={cn(
                  "flex h-16 items-center justify-center border border-line bg-surface text-meta text-ink2",
                  role.cls,
                )}
              >
                {role.px}
              </div>
              <span className="font-mono text-label text-ink2">{role.name}</span>
              <span className="text-label text-ink3">{role.use}</span>
            </div>
          ))}
        </div>
        <p className="border-l-2 border-rule bg-panel px-4 py-3 text-meta text-ink2">
          <span className="font-semibold text-ink">Stay square, always:</span> tables and every
          cell, the coverage grid, legend swatches, and <em>every full-bleed bar or edge</em> — the
          sticky top bar, sticky sub-toolbars, and any container whose border is a single edge
          rather than a box. A rounded corner on a full-width bar leaves a visible sliver of page
          background in the corner. Do not round a data structure away: rounding a person × date
          grid breaks the column read.
        </p>
      </Section>

      <Section
        id="shadows"
        title="Elevation"
        intro="Five general-purpose levels plus one specialized directional side-overlay shadow. All are warm brown-tinted in light mode — never neutral grey or black — and all re-tint per theme."
      >
        <div
          className={cn(
            "grid gap-6 p-6 sm:grid-cols-2 grid3:grid-cols-3",
            surfaceVariants({ role: "page", geometry: "square" }),
          )}
        >
          {SHADOWS.map((shadow) => (
            <div key={shadow.name} className="flex flex-col gap-1.5">
              <div
                data-testid={`shadow-${shadow.name}`}
                className={cn(
                  "flex h-20 items-center justify-center rounded-card border border-line bg-surface px-3 text-center text-meta text-ink2",
                  shadow.cls,
                )}
              >
                {shadow.use}
              </div>
              <span className="font-mono text-label text-ink2">{shadow.name}</span>
            </div>
          ))}
        </div>
        <p className="text-meta text-ink3">
          <span className="font-mono">shadow-dialog</span> and{" "}
          <span className="font-mono">shadow-toast</span> are semantic aliases of the same{" "}
          <span className="font-mono">--sh-3</span> modal-layer value and carry no independent value
          of their own. <span className="font-mono">shadow-side</span> is the specialized
          directional runtime shadow for side drawers and mobile nav only — it is not a general
          surface elevation. Every shadow utility in the app must alias one of these six tokens; a
          hand-authored <span className="font-mono">shadow-[…]</span> is off-contract even when its
          value happens to match.
        </p>
      </Section>

      <Section
        id="motion"
        title="Motion"
        intro="Two durations, one easing curve, three named animations. All of it is suppressed under prefers-reduced-motion by a global rule."
      >
        <div
          className={cn(
            "flex flex-col gap-4 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-40 shrink-0 font-mono text-label text-ink3">duration + ease</span>
            <div className="h-10 w-28 rounded-control bg-panel transition-colors duration-fast hover:bg-brandtint" />
            <span className="font-mono text-label text-ink2">duration-fast · 0.15s</span>
            <div className="h-10 w-28 rounded-control bg-panel transition-colors duration-base hover:bg-brandtint" />
            <span className="font-mono text-label text-ink2">duration-base · 0.22s</span>
            <span className="font-mono text-label text-ink3">
              ease-standard · cubic-bezier(.4, 0, .2, 1)
            </span>
          </div>

          <Separator />

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="w-40 shrink-0 font-mono text-label text-ink3">animations</span>
            <div className="flex items-center gap-2">
              <div key={fadeKey} className="h-10 w-28 animate-fade rounded-control bg-brandtint" />
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
          <div
            className={cn(
              "flex flex-col gap-3 p-5",
              surfaceVariants({ role: "surface", geometry: "card" }),
            )}
          >
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
                  className="rounded-chip border border-line2 bg-panel px-2 py-1 font-mono text-label text-ink2"
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

          <div
            className={cn(
              "flex flex-col gap-3 p-5",
              surfaceVariants({ role: "surface", geometry: "card" }),
            )}
          >
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
        intro="shadcn base-nova / Base UI primitives on the v2 contract. Colour, elevation, radius and state live in variants and recipes — a caller's className is layout only."
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
            <Button variant="destructive-outline">
              <FaTrash /> Remove
            </Button>
            <Button variant="link">Link</Button>
          </div>
          <p className="text-meta text-ink3">
            Pill on every variant. Filled variants carry <span className="font-mono">--sh-1</span>{" "}
            and flatten on <span className="font-mono">:active</span>; secondary, ghost and outline
            are all L1 with a real <span className="font-mono">--surface</span> fill and a hairline,
            because a transparent button on the recessed page does not read as pressable. Secondary
            and ghost share that canonical treatment and differ only in intent; outline carries the
            heavier <span className="font-mono">--rule</span> edge.{" "}
            <span className="font-mono">destructive</span> is the paired solid fill;{" "}
            <span className="font-mono">destructive-outline</span> is the outlined form the system
            uses for reset and delete affordances — both exist so no call site has to hand-override
            a variant's colours.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">Badge</span>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="brand">Brand</Badge>
            <Badge variant="success">Saved</Badge>
            <Badge variant="warn">Caution</Badge>
            <Badge variant="error">Infeasible</Badge>
            <Badge variant="neutral">Neutral</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="outline" casing="normal">
              Aisha Rahman
            </Badge>
          </div>
          <p className="text-meta text-ink3">
            Chip radius. Each tint sits with its MATCHING semantic ink and a border in the base hue,
            so state never rests on colour contrast alone — and no decorative ornament: no check
            glyphs, no coloured leader dots. Text and the semantic pair carry the state. The{" "}
            <span className="font-mono">casing="normal"</span> variant exists for authored data
            (names), which must read exactly as typed.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
            ToggleGroup — Base UI, segmented
          </span>
          <ToggleGroup segmented value={view} onValueChange={setView} aria-label="View">
            <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
            <ToggleGroupItem value="list">List</ToggleGroupItem>
            <ToggleGroupItem value="table">Table</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-meta text-ink3">
            The group is a <span className="font-mono">well</span> pill and its items are pills
            inside it. Selection is <span className="font-mono">--brandtint</span> +{" "}
            <span className="font-mono">--brandink</span> — the system's selection language — never
            the generic hover/zebra <span className="font-mono">accent</span> tone.
          </p>
        </div>

        <div className="grid gap-4 grid2:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Ward setup</CardTitle>
              <CardDescription>An L1 card on the shared surface recipe.</CardDescription>
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

          <SelectedCard data-testid="selected-card">
            <CardHeader>
              <CardTitle>Selected card</CardTitle>
              <CardDescription>
                The same card with the <span className="font-mono">selected</span> role — the
                hairline becomes a --brand border and it lifts to --sh-2.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Surface level="well" geometry="control" className="flex flex-col gap-1 p-3">
                <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
                  nested well
                </span>
                <span className="text-meta text-ink2">
                  An L1 card inside an L1 card becomes a well instead — two surfaces of the same
                  tone are never stacked.
                </span>
              </Surface>
            </CardContent>
            <CardFooter>
              <Badge variant="brand">Current</Badge>
            </CardFooter>
          </SelectedCard>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
            Overlay shells — Base UI Dialog / AlertDialog
          </span>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setDialogOpen(true)} data-testid="open-dialog">
              Open dialog
            </Button>
            <Button
              variant="destructive-outline"
              onClick={() => setAlertOpen(true)}
              data-testid="open-alert-dialog"
            >
              Open alert dialog
            </Button>
          </div>
          <p className="text-meta text-ink3">
            Both are L2 <span className="font-mono">raised</span> surfaces on the card radius behind
            the theme-specific <span className="font-mono">bg-scrim</span> — raw{" "}
            <span className="font-mono">bg-black/*</span> and fixed near-black RGBA overlays are
            off-contract. F2 publishes these shells; the eight overlay owners migrate onto them in
            F3.
          </p>

          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename shift type</DialogTitle>
                <DialogDescription>
                  Base UI composition, `render` not `asChild`, and no wrapper-only trigger DOM.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dialog-name">Name</Label>
                <Input id="dialog-name" defaultValue="Early" />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={() => setDialogOpen(false)}>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogMedia tone="error">
                  <FaTriangleExclamation aria-hidden />
                </AlertDialogMedia>
                <AlertDialogTitle>Start over?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogBody>
                <AlertDialogDescription>
                  This clears the entire current schedule and starts a new, empty one. It cannot be
                  undone.
                </AlertDialogDescription>
              </AlertDialogBody>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => setAlertOpen(false)}>
                  Start over
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-label uppercase tracking-[0.03em] text-ink3">
            Separator
          </span>
          <div
            className={cn(
              "flex items-center gap-4 p-5",
              surfaceVariants({ role: "surface", geometry: "card" }),
            )}
          >
            <span className="text-meta text-ink2">horizontal</span>
            <Separator className="flex-1" />
            <span className="text-meta text-ink2">vertical</span>
            <Separator orientation="vertical" className="h-6" />
            <span className="font-mono text-label text-ink3">--line2 hairline · square</span>
          </div>
        </div>
      </Section>

      <Section
        id="targets"
        title="Control sizing and touch targets"
        intro="Control sizes are ABSOLUTE px. They do not derive from --spacing, so the 0.9 density baseline cannot shrink a hit target below the coarse-pointer minimum."
      >
        <div
          className={cn(
            "flex flex-col gap-4 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small · 32px</Button>
            <Button size="default">Default · 36px</Button>
            <Button size="lg">Large · 44px</Button>
            <Button size="icon" aria-label="Edit" title="Icon · 36px square">
              <FaPen />
            </Button>
            <span className="font-mono text-label text-ink3">
              --ctl-sm / --ctl / --ctl-lg / size-control
            </span>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-3">
            <Input className="w-48" placeholder="Input · 36px" aria-label="Sizing demo input" />
            <Select aria-label="Sizing demo select" defaultValue="a">
              <option value="a">Select · 36px</option>
            </Select>
            <Switch defaultChecked aria-label="Sizing demo switch" />
            <InfoTip
              label="Touch"
              text="Every real control grows to at least 44x44 on a coarse pointer."
            />
          </div>
          <p className="text-meta text-ink2">
            On a coarse pointer every one of these grows to at least{" "}
            <span className="font-mono">44 × 44</span> on the REAL control via{" "}
            <span className="font-mono">pointer-coarse:min-h-touch</span> /{" "}
            <span className="font-mono">min-w-touch</span> (and{" "}
            <span className="font-mono">pointer-coarse:size-touch</span> for the small
            switch/info-tip visuals, which centre inside the enlarged root). Overlapping
            pseudo-element hitboxes are forbidden: they move the pointer target off the element that
            paints focus, and they overlap neighbours.
          </p>
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
                <p className="truncate text-body text-ink2">
                  Occupies the same box as the skeleton.
                </p>
                <p className="truncate text-body text-ink2">Width and height both match.</p>
              </CardContent>
              <CardFooter>
                <Button size="sm">Action</Button>
              </CardFooter>
            </Card>
          )}
          <div
            className={cn(
              "flex flex-col gap-3 p-5",
              surfaceVariants({ role: "surface", geometry: "card" }),
            )}
          >
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
        <div
          className={cn(
            "flex flex-col gap-3 p-5",
            surfaceVariants({ role: "surface", geometry: "card" }),
          )}
        >
          <Rule term="Radius" guard="e2e — each role must compute its own px, data surfaces 0px">
            A semantic role, not a global step: cards 16, controls 12, chips 9, buttons and nav
            items pill. Tables, grid cells, legend swatches and every full-bleed bar or single-edge
            container stay square via an explicit <span className="font-mono">rounded-none</span>.
            The generic shadcn <span className="font-mono">--radius*</span> scale is pinned at{" "}
            <span className="font-mono">0px</span> as the square compatibility fallback, so an
            unmigrated component fails square rather than guessing a radius.
          </Rule>
          <Rule term="Surfaces" guard="vitest — surface-contract.test.ts (TypeScript AST)">
            One CVA recipe (<span className="font-mono">surfaceVariants</span>) owns tone, border
            and elevation for every level; <span className="font-mono">&lt;Surface&gt;</span> is the
            ordinary-container adapter and its level/geometry tuples are type-enforced. A consumer's{" "}
            <span className="font-mono">className</span> is layout only — colour, border, shadow,
            radius and arbitrary-property utilities there are rejected by the AST guard.
          </Rule>
          <Rule term="Elevation" guard="vitest — tailwind-contract.test.ts">
            Level is expressed by tone first, shadow second. Five general levels plus{" "}
            <span className="font-mono">shadow-side</span>; wells take the inset shadow and never an
            outer one. Every shadow utility must alias one of the six runtime tokens.
          </Rule>
          <Rule term="Touch targets" guard="e2e — 390×844 hasTouch context, 44px minimum">
            Real controls reach at least <span className="font-mono">44 × 44</span> under{" "}
            <span className="font-mono">(pointer: coarse)</span>, on the control itself. Absolute{" "}
            <span className="font-mono">--ctl-*</span> /{" "}
            <span className="font-mono">--touch-min</span> tokens mean the 0.9 density baseline
            cannot shrink one. Pseudo-element hitboxes are forbidden.
          </Rule>
          <Rule term="Fonts">
            Hanken Grotesk for body and UI (<span className="font-mono">font-sans</span>), Figtree
            for display and headings (<span className="font-mono">font-heading</span>), Spline Sans
            Mono for numerals and token names (<span className="font-mono">font-mono</span>). Wired
            via next/font in <span className="font-mono">app/layout.tsx</span>. Headings carry
            -0.015em; uppercase labels carry +0.03em.
          </Rule>
          <Rule term="Icons" guard="vitest — no source file may import lucide-react">
            react-icons Font Awesome 6, imported from the{" "}
            <span className="font-mono">@/components/icons</span> barrel. Add an icon by
            re-exporting it there. <span className="font-mono">lucide-react</span> is in the dep
            tree only because the manifest is frozen — do not import it, and rewrite any{" "}
            <span className="font-mono">shadcn add</span> output that does.
          </Rule>
          <Rule
            term="Accent"
            guard="vitest + e2e — four pairs, fallbacks before the @supports block"
          >
            Four accents — <span className="font-mono">teal</span>,{" "}
            <span className="font-mono">sage</span>, <span className="font-mono">rose</span>,{" "}
            <span className="font-mono">plum</span> — selected by{" "}
            <span className="font-mono">data-accent</span> on{" "}
            <span className="font-mono">&lt;html&gt;</span>. Each has an audited light AND dark{" "}
            <span className="font-mono">--brand</span>, so a theme change re-resolves the same
            choice with no scripted colour write. <span className="font-mono">--brandink</span> and{" "}
            <span className="font-mono">--brandtint</span> are never authored: they{" "}
            <span className="font-mono">color-mix</span> off{" "}
            <span className="font-mono">--brand</span> at 82%-on-black / 10%-on-surface in light and
            60%-on-white / 26%-on-surface in dark, with a static nearest-8-bit pair declared BEFORE
            the guarded block for engines without <span className="font-mono">color-mix()</span>. An
            unsupported stored accent renders teal and is left untouched in storage — there is no
            legacy mapping and no migration key.
          </Rule>
          <Rule term="Theme">
            Class-based — <span className="font-mono">.dark</span> on{" "}
            <span className="font-mono">&lt;html&gt;</span>, which is what the Tailwind{" "}
            <span className="font-mono">dark:</span> variant keys off. Persisted independently as{" "}
            <span className="font-mono">ns-theme</span> /{" "}
            <span className="font-mono">ns-accent</span> and applied before paint, so there is no
            hydration flash. Theme differences live in the tokens: a consumer never writes a{" "}
            <span className="font-mono">dark:</span> colour override.
          </Rule>
          <Rule term="Toast">
            One treatment, applied globally by <span className="font-mono">.ns-toast</span>:
            bottom-centre, an <span className="font-mono">--ink</span> fill with{" "}
            <span className="font-mono">--on-ink</span> text and leading ✓ mark, the card radius,
            and <span className="font-mono">--shadow-toast</span> (an alias of the{" "}
            <span className="font-mono">--sh-3</span> modal layer). Sonner renders it; call sites
            pass no styling. v1's green 3px left-edge rule and its square corner are both retired,
            along with the no-side-stripe exception that justified the rule.
          </Rule>
          <Rule term="Reduced motion" guard="e2e — skeleton animation must drop below 0.05s">
            A global <span className="font-mono">prefers-reduced-motion</span> rule collapses every
            animation, transition and smooth scroll. Motion tokens need no per-component guard.
          </Rule>
          <Rule term="Raw colours" guard="vitest — source guard over components/ui/**">
            None. Every fill, text and border resolves to a token — which is what lets the theme and
            accent axes work at all. Scrims use <span className="font-mono">bg-scrim</span>; pure
            black is never a resolved foreground or background, and appears only as an audited
            derivation endpoint or a dark-mode shadow tint.
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
