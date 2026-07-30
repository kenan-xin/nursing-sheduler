"use client";

// Advanced Home body (T08, BLOCKER 2; mode-filtered by T08d). The
// warning/explanation band plus a responsive grid of direct editor entry
// points (ScreenHome.dc.html:65-81). The grid reuses `getNavGroupsForMode`
// (the same filtered registry the sidebar and route validity read), so it can
// never fall out of sync with what Advanced mode actually exposes — every
// Guided destination (incl. Rules) plus the raw Constraints group and Export
// Layout.

import { getNavGroupsForMode } from "@/components/shell/nav-config";

export function HomeAdvanced({ onNavigate }: { onNavigate: (path: string) => void }) {
  const editors = getNavGroupsForMode("advanced")
    .flatMap((group) => group.items)
    .filter((item) => item.path !== "/");

  return (
    <div className="flex flex-col gap-5" data-testid="home-advanced">
      <div className="flex items-start gap-2.5 rounded-card border border-line bg-warntint px-3.5 py-3">
        <span className="font-bold text-warnink">!</span>
        <p className="text-meta text-ink2">
          Advanced mode exposes every editor directly, matching the full data model. Jump to any
          area below.
        </p>
      </div>

      <div
        data-testid="home-advanced-grid"
        // `.ns-grid3` ladder, as on the Shifts grid: two-up at 640px (`sm`), three-up
        // at 1100px (`grid3:`).
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 grid3:grid-cols-3"
      >
        {editors.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.path}
              type="button"
              onClick={() => onNavigate(item.path)}
              data-testid={`home-adv-${item.path}`}
              className="flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-left shadow-1 outline-none transition-[border-color,box-shadow] hover:border-brandink hover:shadow-2 focus-visible:ring-2 focus-visible:ring-brand"
            >
              {/* `size-control`, not `size-9`: the control sizes are absolute px
                  and are deliberately NOT ridden by the 0.9 spacing baseline,
                  which would render this 32.4px instead of the prototype's 36. */}
              <span className="flex size-control shrink-0 items-center justify-center rounded-chip border border-line2 bg-panel text-ink2">
                <Icon className="size-4" />
              </span>
              <span className="flex flex-col gap-1">
                <span className="text-body font-bold">{item.label}</span>
                <span className="text-meta text-ink3">{item.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
