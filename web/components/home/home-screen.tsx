"use client";

// Home / dashboard (T08, BLOCKER 2). The landing surface at `/`. It is a genuine
// two-mode experience, not a copy switch: GUIDED renders a roster-oriented
// header, a primary generate action, the five-tile stat strip, an "N of 6 steps
// ready" progress meter and six status-aware workflow cards; ADVANCED replaces
// the body with an explanatory band and a direct editor grid. Both are driven by
// real scenario-store selectors and route through the guarded navigation gate, so
// an in-progress dirty scenario is protected even from the Home CTAs.

import { useAppMode } from "@/lib/mode/use-mode";
import { useGuardedNavigation } from "@/components/shell/use-guarded-navigation";
import { useScenarioSummary } from "./scenario-summary";
import { HomeStatStrip, type HomeStat } from "./home-stat-strip";
import { HomeGuided } from "./home-guided";
import { HomeAdvanced } from "./home-advanced";
import { FaWandMagicSparkles } from "@/components/icons";

export function HomeScreen() {
  const mode = useAppMode();
  const summary = useScenarioSummary();
  const { navigate } = useGuardedNavigation();

  const guided = mode === "guided";
  const rosterTitle = summary.rosterMonthLabel
    ? `Build the ${summary.rosterMonthLabel} Roster`
    : "Build Your Roster";

  const stats: HomeStat[] = [
    { value: String(summary.peopleCount), label: "Nurses" },
    { value: String(summary.seniorsCount), label: "Seniors" },
    { value: String(summary.shiftTypesCount), label: "Shift Types" },
    { value: String(summary.durationDays), label: "Roster Days" },
    { value: String(summary.rulesTotal), label: "Rules" },
  ];

  return (
    <div
      data-testid="home-screen"
      data-mode={mode}
      className="mx-auto flex w-full max-w-[1240px] animate-fade flex-col gap-6 px-5 py-6 pb-16"
    >
      {/* Header — shown in both modes */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label uppercase tracking-[0.03em] text-brandink">
            ● Ward Scheduling
          </div>
          <h1 className="mb-2 font-heading text-display font-extrabold leading-tight tracking-tight">
            {rosterTitle}
          </h1>
          <p className="max-w-[56ch] text-body text-ink2">
            Follow the steps to set up your ward, then generate a fair roster that respects every
            rule. You can jump to any step at any time.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate("/optimize-and-export")}
          data-testid="home-generate"
          className="inline-flex h-11 items-center gap-2.5 bg-brand px-5 font-heading text-body font-bold text-onbrand outline-none transition-[filter] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-brand"
        >
          <FaWandMagicSparkles className="size-4" />
          Generate roster
        </button>
      </div>

      {/* Stat strip — shown in both modes */}
      <HomeStatStrip stats={stats} />

      {/* Mode-specific body */}
      {guided ? (
        <HomeGuided summary={summary} onNavigate={navigate} />
      ) : (
        <HomeAdvanced onNavigate={navigate} />
      )}
    </div>
  );
}
