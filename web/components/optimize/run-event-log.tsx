"use client";

// T16e — the optimization event log. Renders the bounded, wire-ordered run log
// (T16a `RunLogEntry[]`) as a collapsible list: a category badge, the stable
// label, a short detail, and the event's wall-clock time. Poll/cache snapshots
// deliberately produce no log entry, so this stays faithful to the real SSE wire.
//
// B2-2 — naming reconciled to the prototype's "Event log" (ScreenGenerate.dc.html
// :190-193). Placement is a conscious deviation: the prototype seats the log in a
// column beside the progress chart, but the chart is owned by the guarded
// `run-status-panel.tsx` (B2-1, do-not-edit), so pulling it out to build that
// two-column row is out of scope here. The full-width collapsible (this file's
// existing structure) is kept instead — it already covers the same content with
// a working scroll/auto-follow behavior.

import { useCallback, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { surfaceVariants } from "@/components/ui/surface";
import type { RunLogEntry, RunLogKind } from "@/lib/optimize";
import { cn } from "@/lib/utils";

/** Distance from the bottom (px) still counted as "at the bottom" for auto-scroll. */
const NEAR_BOTTOM_PX = 24;

export interface RunEventLogProps {
  log: RunLogEntry[];
  active: boolean;
}

/**
 * Each log category maps onto a shared `Badge` variant rather than a local class
 * list. That closes two v1 defects at once: the status tints were painted with a
 * NEUTRAL `--ink` (a Redundant Signal Rule violation — the tint must pair with its
 * own semantic ink), and the brand rows carried an arbitrary `border-brand/40`
 * opacity instead of a token edge. The mapping matches the prototype's own
 * `badgeColor` table (ScreenGenerate.dc.html, renderVals): complete → success,
 * error → error, progress → brand, phase → warn, everything else → neutral.
 */
const KIND_VARIANT: Record<RunLogKind, "neutral" | "success" | "brand" | "warn" | "error"> = {
  lifecycle: "neutral",
  state: "neutral",
  control: "neutral",
  result: "success",
  progress: "brand",
  phase: "warn",
  recovery: "brand",
  terminal: "warn",
  error: "error",
};

function formatTime(entry: RunLogEntry): string {
  const ms =
    entry.eventTime ?? (entry.occurredAt !== null ? Date.parse(entry.occurredAt) : Number.NaN);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

export function RunEventLog({ log, active }: RunEventLogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Whether the viewer was at/near the bottom BEFORE the latest append. A user who
  // scrolls up is not yanked back; auto-scroll only follows a reader already at the
  // tail (old-app acceptance behavior).
  const nearBottomRef = useRef(true);
  const count = log.length;

  const isNearBottom = useCallback((el: HTMLDivElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) nearBottomRef.current = isNearBottom(el);
  }, [isNearBottom]);

  useEffect(() => {
    const el = containerRef.current;
    // Only follow the tail when the reader was already near the bottom.
    if (active && el && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, active]);

  return (
    <details
      className={cn(
        surfaceVariants({ role: "surface", geometry: "card" }),
        // DESIGN.md §4 rule 3 — the scroll region ends the card, so the card
        // clips to its own radius instead of letting rows hit a square edge.
        "overflow-hidden",
      )}
      open={active || count === 0}
      data-testid="optimize-event-log"
    >
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-5 py-4">
        <span className="font-heading text-cardhead font-semibold tracking-[-0.015em] text-ink">
          Event log
        </span>
        {/* A COUNT, so the numeral is mono (DESIGN.md §3) while the "events"
            noun beside it stays a prose label on the body face. The hook is on
            the value, not the line. Size, weight, tracking and ink are unchanged. */}
        <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
          <span data-testid="optimize-event-count" className="font-mono">
            {count}
          </span>{" "}
          events
        </span>
      </summary>
      <div
        ref={containerRef}
        onScroll={onScroll}
        data-testid="optimize-event-log-scroll"
        className="max-h-80 overflow-y-auto border-t border-line2"
      >
        {count === 0 ? (
          <p className="px-4 py-3 text-meta text-ink3">
            {active ? "Waiting for optimization events…" : "No optimization events yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line2">
            {log.map((entry) => (
              <li key={entry.seq} className="flex items-start gap-2.5 px-4 py-2">
                <Badge
                  variant={KIND_VARIANT[entry.kind]}
                  data-kind={entry.kind}
                  className="mt-0.5 min-w-[66px] shrink-0 justify-center"
                >
                  {entry.kind}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-meta text-ink">{entry.label}</span>
                    {/* A wall-clock time — "hours" in §3's data list, and it is
                        column-aligned down the log, which is exactly what the
                        mono face is reserved for. */}
                    <span
                      data-testid="optimize-event-time"
                      className="shrink-0 font-mono text-label text-ink3"
                    >
                      {formatTime(entry)}
                    </span>
                  </div>
                  {entry.detail !== null ? (
                    <p className="mt-0.5 break-words text-meta text-ink2">{entry.detail}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
