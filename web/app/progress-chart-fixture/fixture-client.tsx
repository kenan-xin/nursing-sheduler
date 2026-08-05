"use client";

// T16d — client body of the optimization progress chart TEST FIXTURE.
//
// This is a test harness, not a production screen. T16e owns the real Optimize
// & Export screen; this fixture exercises the chart in a real browser for
// responsive / accessibility / dark-mode coverage. The route is gated off in
// production by `page.tsx` (see `NS_ENABLE_DEV_FIXTURES`), so this body only
// ever renders under the Playwright/dev harness.

import { useState } from "react";
import { ProgressChart } from "@/components/optimize/progress-chart";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { surfaceVariants } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import type { RunProgressPoint } from "@/lib/optimize";
import { ThemeToggle, AccentControl } from "@/components/theme/theme-toggle";

type DatasetKey =
  | "empty"
  | "sparse"
  | "two-points"
  | "dense"
  | "no-comments"
  | "duplicate-times"
  | "long-running";

const DATASETS: Array<{ key: DatasetKey; label: string; points: RunProgressPoint[] }> = [
  { key: "empty", label: "Empty", points: [] },
  {
    key: "sparse",
    label: "Sparse (one point)",
    points: [
      {
        source: "solver",
        currentBestScore: 42,
        elapsedSeconds: 5,
        solutionIndex: 1,
        commentCount: 0,
      },
    ],
  },
  {
    key: "two-points",
    label: "Two points",
    points: [
      {
        source: "ortools/cp-sat:solution-callback",
        currentBestScore: 12,
        elapsedSeconds: 0.5,
        solutionIndex: 2,
        commentCount: 4,
      },
      {
        source: "ortools/cp-sat:solution-callback",
        currentBestScore: 9,
        elapsedSeconds: 1,
        solutionIndex: 3,
        commentCount: 2,
      },
    ],
  },
  {
    key: "dense",
    label: "Dense (32 points, dots hidden)",
    points: Array.from({ length: 32 }, (_, i) => ({
      source: "ortools/cp-sat:solution-callback",
      currentBestScore: 1000 - i,
      elapsedSeconds: i,
      solutionIndex: i,
      commentCount: 32 - i,
    })),
  },
  {
    key: "no-comments",
    label: "No comments",
    points: [
      {
        source: "solver",
        currentBestScore: 100,
        elapsedSeconds: 0,
        solutionIndex: null,
        commentCount: null,
      },
      {
        source: "solver",
        currentBestScore: 80,
        elapsedSeconds: 10,
        solutionIndex: null,
        commentCount: null,
      },
      {
        source: "solver",
        currentBestScore: 60,
        elapsedSeconds: 20,
        solutionIndex: null,
        commentCount: null,
      },
    ],
  },
  {
    key: "duplicate-times",
    label: "Duplicate times",
    points: [
      {
        source: "solver",
        currentBestScore: 10,
        elapsedSeconds: 60,
        solutionIndex: 0,
        commentCount: 0,
      },
      {
        source: "solver",
        currentBestScore: 8,
        elapsedSeconds: 60,
        solutionIndex: 1,
        commentCount: 1,
      },
      {
        source: "solver",
        currentBestScore: 5,
        elapsedSeconds: 60,
        solutionIndex: 2,
        commentCount: 2,
      },
    ],
  },
  {
    key: "long-running",
    label: "Long-running (200 points, 1h span)",
    points: Array.from({ length: 200 }, (_, i) => ({
      source: "solver",
      currentBestScore: 5000 - i * 12,
      elapsedSeconds: i * 18,
      solutionIndex: i,
      commentCount: Math.floor(i / 4),
    })),
  },
];

export default function ProgressChartFixtureClient() {
  const [datasetKey, setDatasetKey] = useState<DatasetKey>("two-points");
  const [isActive, setIsActive] = useState(false);

  const dataset = DATASETS.find((d) => d.key === datasetKey) ?? DATASETS[0];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 bg-bg px-5 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-display font-bold leading-[1.15] tracking-[-0.015em] text-ink">
            Optimisation progress chart fixture
          </h1>
          <p className="text-meta text-ink2">
            T16d browser fixture — responsive, dark-mode, and a11y coverage.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-testid="fixture-controls">
          <AccentControl />
          <ThemeToggle />
        </div>
      </header>

      {/* R6 v2 — both harness panes are L1 cards, and every control is a shared
          primitive: the dataset selector uses the Button variants (pill, real L1
          fill, 44px coarse floor) instead of a local 32px box borrowing the
          `--brandtint` selection language, and the live-axis toggle is the shared
          Switch, because a native checkbox is ~13px tall and can never satisfy the
          D10 coarse-pointer contract that F4's target battery measures. */}
      <section
        data-testid="fixture-dataset-controls"
        className={cn(
          surfaceVariants({ role: "surface", geometry: "card" }),
          "flex flex-wrap items-center gap-3 p-4",
        )}
      >
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
          Dataset
        </span>
        {DATASETS.map((d) => (
          <Button
            key={d.key}
            variant={datasetKey === d.key ? "default" : "secondary"}
            size="sm"
            aria-pressed={datasetKey === d.key}
            data-testid={`fixture-dataset-${d.key}`}
            onClick={() => setDatasetKey(d.key)}
          >
            {d.label}
          </Button>
        ))}
        <label
          htmlFor="fixture-active-toggle"
          className="ml-auto flex items-center gap-2 text-meta text-ink2"
        >
          <Switch
            id="fixture-active-toggle"
            checked={isActive}
            onCheckedChange={setIsActive}
            data-testid="fixture-active-toggle"
          />
          isActive (live x-axis extrapolation)
        </label>
      </section>

      <section
        data-testid="fixture-chart-host"
        className={cn(surfaceVariants({ role: "surface", geometry: "card" }), "p-4")}
      >
        <ProgressChart points={dataset.points} isActive={isActive} />
      </section>
    </main>
  );
}
