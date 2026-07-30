"use client";

// Home stat strip (T08, BLOCKER 2). The five-tile ward summary shown in both
// modes (ScreenHome.dc.html:23-31), driven by real scenario selectors. The
// "SENIORS" tile is people-GROUP backed per DL10 — never a per-person role field.

export interface HomeStat {
  value: string;
  label: string;
}

export function HomeStatStrip({ stats }: { stats: HomeStat[] }) {
  return (
    <div
      data-testid="home-stat-strip"
      // The container IS the L1 card (ScreenHome.dc.html:24): --r-card radius,
      // --sh-1 elevation, and overflow:hidden so the 1px --line2 grid gaps clip
      // into the rounded corners. Cells stay square — the CSS rule
      // `.ns-stats[style]>*[style]{border-radius:0}` pins that in the prototype,
      // and a rounded cell would bite notches out of the dividers.
      //
      // Column ladder is 2→3→5 (prototype .ns-stats: 560px / 900px), NOT 2→5 —
      // the prior `sm:grid-cols-5` stranded the fifth stat full-width between
      // 640px and 899px. The 3-up step uses the prototype's exact 560px via an
      // arbitrary variant (no R1-owned breakpoint token exists); the 5-up step
      // reuses the layout-ladder `grid2` (900px).
      className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line2 shadow-1 min-[560px]:grid-cols-3 grid2:grid-cols-5"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col gap-1.5 bg-surface p-4">
          <div className="font-heading text-cardhead font-bold leading-none tracking-[-0.015em]">
            {stat.value}
          </div>
          <div className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  );
}
