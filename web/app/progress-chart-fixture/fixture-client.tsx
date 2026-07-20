"use client";

// T16d — client body of the optimization progress chart TEST FIXTURE.
//
// This is a test harness, not a production screen. T16e owns the real Optimize
// & Export screen; this fixture exercises the chart in a real browser for
// responsive / accessibility / dark-mode / density coverage. The route is gated
// off in production by `page.tsx` (see `NS_ENABLE_DEV_FIXTURES`), so this body
// only ever renders under the Playwright/dev harness.

import { useState } from "react";
import { ProgressChart } from "@/components/optimize/progress-chart";
import type { RunProgressPoint } from "@/lib/optimize";
import { ThemeToggle, DensityControl, AccentControl } from "@/components/theme/theme-toggle";

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
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-display font-extrabold tracking-tight">
            Optimization progress chart fixture
          </h1>
          <p className="text-meta text-ink2">
            T16d browser fixture — responsive, dark-mode, density, and a11y coverage.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3" data-testid="fixture-controls">
          <AccentControl />
          <DensityControl />
          <ThemeToggle />
        </div>
      </header>

      <section
        data-testid="fixture-dataset-controls"
        className="flex flex-wrap items-center gap-3 border border-line bg-surface p-4"
      >
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
          Dataset
        </span>
        {DATASETS.map((d) => (
          <button
            key={d.key}
            type="button"
            aria-pressed={datasetKey === d.key}
            data-testid={`fixture-dataset-${d.key}`}
            onClick={() => setDatasetKey(d.key)}
            className={
              "inline-flex h-8 items-center px-3 text-meta font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand " +
              (datasetKey === d.key
                ? "bg-brandtint text-brandink ring-1 ring-inset ring-brand/40"
                : "border border-line bg-surface text-ink2 hover:bg-panel hover:text-ink")
            }
          >
            {d.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-meta text-ink2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            data-testid="fixture-active-toggle"
          />
          isActive (live x-axis extrapolation)
        </label>
      </section>

      <section data-testid="fixture-chart-host" className="border border-line bg-surface p-4">
        <ProgressChart points={dataset.points} isActive={isActive} />
      </section>
    </main>
  );
}
