"use client";

// Home / first-run screen (T08, ticket item 7). The landing entry point of the
// shell at `/`. It orients a new user and routes them into the workflow's first
// step through the guarded navigation gate (so an in-progress dirty scenario is
// protected even from the Home CTAs). Copy adapts to the active Guided/Advanced
// lens without touching the scenario store.

import { useAppMode } from "@/lib/mode/use-mode";
import { useGuardedNavigation } from "@/components/shell/use-guarded-navigation";
import { Button } from "@/components/ui/button";
import { FaCalendarDays, FaUsers, FaBolt } from "@/components/icons";

export default function HomePage() {
  const mode = useAppMode();
  const { navigate } = useGuardedNavigation();

  return (
    <div
      data-testid="home-screen"
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-12"
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-display font-extrabold tracking-tight">Nurse Scheduler</h1>
        <p className="text-body text-ink2">
          {mode === "guided"
            ? "Build a schedule step by step — set your dates, add people and shift types, define the rules, then generate."
            : "Full control over the scheduling model. Jump to any section from the navigation."}
        </p>
      </header>

      <section className="flex flex-col gap-3" data-testid="home-getting-started">
        <h2 className="text-label uppercase tracking-[0.03em] text-ink3">Get started</h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate("/dates")} data-testid="home-cta-dates">
            <FaCalendarDays />
            Set the date range
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/people")}
            data-testid="home-cta-people"
          >
            <FaUsers />
            Add people
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/optimize-and-export")}
            data-testid="home-cta-generate"
          >
            <FaBolt />
            Optimize &amp; export
          </Button>
        </div>
      </section>

      <p className="text-meta text-ink3">
        Your work is saved to this browser automatically and restored when you return.
      </p>
    </div>
  );
}
