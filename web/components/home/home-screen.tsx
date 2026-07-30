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
import { Button } from "@/components/ui/button";
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
    { value: String(summary.shiftTypesCount), label: "Shifts" },
    { value: String(summary.durationDays), label: "Roster Days" },
    { value: String(summary.rulesTotal), label: "Rules" },
  ];

  return (
    <div
      data-testid="home-screen"
      data-mode={mode}
      className="flex animate-fade flex-col gap-6 bg-bg"
    >
      {/* Header — shown in both modes */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          {/* Eyebrow — text only, no leader dot (DESIGN.md §5: no decorative
              ornament on labels). The COPY is product content and stays as
              shipped; only the ● ornament is retired. The prototype's own
              "ROSTER SETUP" wording is an example, and the deviation matrix puts
              product contracts above prototype examples. */}
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Ward Scheduling
          </div>
          {/* Explicit -0.015em: globals.css still carries v1's -0.02em on h1–h6
              (G1 owns that cleanup) and Tailwind's `tracking-tight` is -0.025em,
              so neither default lands on the v2 value. */}
          <h1 className="mb-2 font-heading text-display font-bold leading-tight tracking-[-0.015em]">
            {rosterTitle}
          </h1>
          <p className="max-w-[56ch] text-body text-ink2">
            Follow the steps to set up your ward, then generate a fair roster that respects every
            rule. You can jump to any step at any time.
          </p>
        </div>
        {/* The shared Button recipe, not a hand-authored equivalent: `lg` is the
            absolute 44px control token the prototype's primary action uses, and
            the variant carries the pill, --sh-1, active-flatten, focus outline
            and coarse-pointer floor as one contract. Only the prototype's 700
            weight is added on top. */}
        <Button
          size="lg"
          onClick={() => navigate("/optimize-and-export")}
          data-testid="home-generate"
          className="font-bold"
        >
          <FaWandMagicSparkles />
          Generate roster
        </Button>
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
