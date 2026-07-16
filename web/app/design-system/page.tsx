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
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton, SkeletonCard, SkeletonText } from "@/components/ui/skeleton";
import { ThemeToggle, DensityControl, AccentControl } from "@/components/theme/theme-toggle";
import { AppVersion } from "@/components/app-version";
import { FaPlus, FaTrash, FaCircleCheck } from "@/components/icons";

// Living style reference. Exercises the ported token system end-to-end: palette
// (light + dark via the toggle), the fluid type scale, the spacing scale, the
// restyled shadcn/Base UI components, skeleton primitives, and the theme +
// density controls. Each section carries a data-testid so the acceptance
// Playwright/vitest checks can target it.

const COLOR_TOKENS = [
  "ink",
  "ink2",
  "ink3",
  "faint",
  "bg",
  "surface",
  "panel",
  "panel-alt",
  "sidebar",
  "chrome",
  "line",
  "line2",
  "brand",
  "brandink",
  "brandtint",
  "success",
  "successtint",
  "warn",
  "warntint",
  "error",
  "errortint",
] as const;

const TYPE_STEPS = [
  { name: "display", cls: "text-display font-heading font-bold" },
  { name: "cardhead", cls: "text-cardhead font-heading font-semibold" },
  { name: "title", cls: "text-title font-heading font-semibold" },
  { name: "body", cls: "text-body" },
  { name: "meta", cls: "text-meta text-ink2" },
  { name: "label", cls: "text-label uppercase tracking-[0.03em] text-ink3" },
] as const;

const SPACE_STEPS = [
  { name: "1", cssVar: "--space-1" },
  { name: "2", cssVar: "--space-2" },
  { name: "3", cssVar: "--space-3" },
  { name: "4", cssVar: "--space-4" },
  { name: "5", cssVar: "--space-5" },
  { name: "6", cssVar: "--space-6" },
  { name: "8", cssVar: "--space-8" },
  { name: "12", cssVar: "--space-12" },
] as const;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={id} className="flex flex-col gap-4">
      <h2 className="font-heading text-h3 font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

export default function StyleReferencePage() {
  const [switchOn, setSwitchOn] = useState(true);
  const [loading, setLoading] = useState(true);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-display font-extrabold tracking-tight">Design system</h1>
          <p className="text-meta text-ink2">
            Nurse scheduler tokens — ported from the design prototype.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-testid="controls">
          <AccentControl />
          <DensityControl />
          <ThemeToggle />
        </div>
      </header>

      <Separator />

      <Section id="palette" title="Palette">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {COLOR_TOKENS.map((token) => (
            <div key={token} className="flex flex-col gap-1" data-testid={`swatch-${token}`}>
              <div
                className="h-14 w-full border border-line"
                style={{ background: `var(--${token})` }}
              />
              <span className="font-mono text-label text-ink2">--{token}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="typography" title="Type scale">
        <div className="flex flex-col gap-3 border border-line bg-surface p-5">
          {TYPE_STEPS.map((step) => (
            <div
              key={step.name}
              className="flex items-baseline gap-4"
              data-testid={`type-${step.name}`}
            >
              <span className="w-24 shrink-0 font-mono text-label text-ink3">{step.name}</span>
              <span className={step.cls}>The quick brown fox</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="spacing" title="Spacing scale">
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
            </div>
          ))}
        </div>
      </Section>

      <Section id="components" title="Components">
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
      </Section>

      <Section id="skeletons" title="Skeletons">
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

      <Separator />

      <footer className="flex items-center justify-between text-meta text-ink3">
        <span>Nurse Scheduler</span>
        <AppVersion />
      </footer>
    </main>
  );
}
