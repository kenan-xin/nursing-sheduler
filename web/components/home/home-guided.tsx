"use client";

// Guided Home body (T08, BLOCKER 2). The "N of 6 steps ready" progress meter and
// the six numbered, status-aware workflow cards (ScreenHome.dc.html:33-63). Each
// card's status (done / current / to do), summary line, and CTA (Review /
// Continue / Set up) are derived from real state and route to the committed
// destinations (not the prototype's Staff/Shifts labels).
//
// Completion is honest (cold-review Major): the five SETUP steps are done from
// their real scenario data (Dates only for a VALID range); the sixth GENERATE
// step is done only from an actual optimize run success — never merely because
// the prerequisites are met. The run flow is T16, so until it lands the run stays
// `idle` and Generate is "current" (ready to run) when prerequisites are met, and
// "to do" otherwise — it can never show ✓ Done without a generated roster.

import { GUIDED_STEP_COUNT } from "@/components/shell/nav-config";
import { useHotStore } from "@/lib/store";
import type { ScenarioSummary, StepReadiness } from "./scenario-summary";
import { cn } from "@/lib/utils";
import {
  FaCalendarDays,
  FaUserNurse,
  FaLayerGroup,
  FaListCheck,
  FaTableCells,
  FaWandMagicSparkles,
  FaArrowRight,
  type IconType,
} from "@/components/icons";

type StepStatus = "done" | "current" | "todo";

interface StepDef {
  step: number;
  path: string;
  /** The setup prerequisite this step maps to; absent for the Generate step. */
  readyKey?: keyof StepReadiness;
  label: string;
  desc: string;
  icon: IconType;
  summary: (s: ScenarioSummary) => string;
}

const STEPS: StepDef[] = [
  {
    step: 1,
    path: "/dates",
    readyKey: "dates",
    label: "Set the dates",
    desc: "Pick the roster range and mark public holidays.",
    icon: FaCalendarDays,
    summary: (s) =>
      s.durationDays > 0
        ? `${s.rosterMonthLabel ?? "Range set"} · ${s.durationDays} days`
        : "No valid range yet",
  },
  {
    step: 2,
    path: "/people",
    readyKey: "people",
    label: "Add your people",
    desc: "List nurses and organise people groups.",
    icon: FaUserNurse,
    summary: (s) => `${s.peopleCount} people · ${s.staffGroupsCount} groups`,
  },
  {
    step: 3,
    path: "/shift-types",
    readyKey: "shiftTypes",
    label: "Define the shifts",
    desc: "Set up your daily shift types.",
    icon: FaLayerGroup,
    summary: (s) => `${s.shiftTypesCount} shift types`,
  },
  {
    step: 4,
    path: "/shift-type-requirements",
    readyKey: "rules",
    label: "Choose the rules",
    desc: "Set minimum staffing and skill mix per shift.",
    icon: FaListCheck,
    summary: (s) => `${s.rulesTotal} rules set`,
  },
  {
    step: 5,
    path: "/shift-requests",
    readyKey: "requests",
    label: "Requests & leave",
    desc: "Pin leave, off-days and shift preferences.",
    icon: FaTableCells,
    summary: (s) => `${s.shiftRequestsCount} requests entered`,
  },
  {
    step: 6,
    path: "/optimize-and-export",
    label: "Generate the roster",
    desc: "Build a fair roster that respects every rule.",
    icon: FaWandMagicSparkles,
    summary: (s) => (s.prerequisitesMet ? "Ready to generate" : "Ready when the steps are done"),
  },
];

const BADGE: Record<StepStatus, { label: string; className: string }> = {
  done: { label: "✓ Done", className: "bg-successtint text-success" },
  current: { label: "● Current", className: "bg-brandtint text-brandink" },
  todo: { label: "To do", className: "bg-panel text-ink3" },
};

const CTA_LABEL: Record<StepStatus, string> = {
  done: "Review",
  current: "Continue",
  todo: "Set up",
};

export function HomeGuided({
  summary,
  onNavigate,
}: {
  summary: ScenarioSummary;
  onNavigate: (path: string) => void;
}) {
  // Generate completion is a run fact, not a scenario fact: a roster exists only
  // after a successful optimize run. T16 owns that flow; until then it is `idle`.
  const generateComplete = useHotStore((s) => s.run.phase === "complete");

  const done = STEPS.map((s) => (s.readyKey ? summary.ready[s.readyKey] : generateComplete));
  const currentIndex = done.findIndex((d) => !d);
  const doneCount = done.filter(Boolean).length;
  const progressPct = Math.round((doneCount / GUIDED_STEP_COUNT) * 100);

  return (
    <div className="flex flex-col gap-4">
      {/* Progress meter */}
      <div className="flex items-center gap-3" data-testid="home-progress">
        <span className="text-label uppercase tracking-[0.03em] text-ink2">
          {doneCount} of {GUIDED_STEP_COUNT} steps ready
        </span>
        <span className="relative h-1 flex-1 bg-line2">
          <span
            className="absolute inset-y-0 left-0 bg-brand"
            style={{ width: `${progressPct}%` }}
          />
        </span>
      </div>

      {/* Workflow cards */}
      <div
        data-testid="home-wizard-grid"
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
      >
        {STEPS.map((step, i) => {
          const status: StepStatus = done[i] ? "done" : i === currentIndex ? "current" : "todo";
          const current = status === "current";
          const badge = BADGE[status];
          const Icon = step.icon;
          return (
            <div
              key={step.path}
              data-testid={`home-card-${step.path}`}
              data-status={status}
              className={cn(
                "flex flex-col border bg-surface p-4.5",
                current ? "border-brand" : "border-line",
              )}
            >
              <div className="mb-3.5 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-[34px] items-center justify-center bg-ink font-mono text-label-md font-bold text-on-ink">
                    {step.step}
                  </span>
                  <span className="flex size-[34px] items-center justify-center border border-line2 bg-panel text-ink2">
                    <Icon className="size-3.5" />
                  </span>
                </div>
                <span
                  className={cn(
                    "px-2 py-1 text-label uppercase tracking-[0.03em]",
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>
              </div>

              <div className="mb-1.5 font-heading text-title font-extrabold tracking-tight">
                {step.label}
              </div>
              <p className="mb-3.5 min-h-[2.7em] text-meta leading-relaxed text-ink2">
                {step.desc}
              </p>
              <div className="mb-4 inline-flex w-fit items-center gap-2 border border-line bg-surface px-2.5 py-1 text-meta text-ink2">
                <Icon className="size-3 text-ink3" />
                {step.summary(summary)}
              </div>

              <div className="mt-auto">
                <button
                  type="button"
                  onClick={() => onNavigate(step.path)}
                  data-testid={`home-cta-${step.path}`}
                  className={cn(
                    "inline-flex h-9 items-center gap-2 px-4 text-meta font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
                    current
                      ? "bg-brand text-onbrand hover:brightness-95"
                      : "border border-line bg-transparent text-ink hover:bg-panel",
                  )}
                >
                  {CTA_LABEL[status]}
                  <FaArrowRight className="size-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
