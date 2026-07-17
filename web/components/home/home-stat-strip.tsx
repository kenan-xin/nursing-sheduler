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
      className="grid grid-cols-2 gap-px border border-line bg-line2 sm:grid-cols-5"
    >
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col gap-1.5 bg-surface p-4">
          <div className="font-heading text-cardhead font-extrabold leading-none tracking-tight">
            {stat.value}
          </div>
          <div className="text-label uppercase tracking-[0.03em] text-ink3">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}
