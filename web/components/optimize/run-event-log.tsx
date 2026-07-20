"use client";

// T16e — the optimization event log. Renders the bounded, wire-ordered run log
// (T16a `RunLogEntry[]`) as a collapsible list: a category badge, the stable
// label, a short detail, and the event's wall-clock time. Poll/cache snapshots
// deliberately produce no log entry, so this stays faithful to the real SSE wire.

import { useCallback, useEffect, useRef } from "react";
import type { RunLogEntry, RunLogKind } from "@/lib/optimize";
import { cn } from "@/lib/utils";

/** Distance from the bottom (px) still counted as "at the bottom" for auto-scroll. */
const NEAR_BOTTOM_PX = 24;

export interface RunEventLogProps {
  log: RunLogEntry[];
  active: boolean;
}

const KIND_STYLE: Record<RunLogKind, string> = {
  lifecycle: "border-line bg-panel text-ink2",
  state: "border-line bg-panel text-ink2",
  control: "border-line bg-panel text-ink2",
  result: "border-success bg-successtint text-ink",
  progress: "border-brand/40 bg-brandtint text-brandink",
  phase: "border-warn bg-warntint text-ink",
  recovery: "border-brand/40 bg-brandtint text-brandink",
  terminal: "border-warn bg-warntint text-ink",
  error: "border-error bg-errortint text-ink",
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
      className="border border-line bg-surface"
      open={active || count === 0}
      data-testid="optimize-event-log"
    >
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-body font-semibold">
        <span>Optimization Events</span>
        <span className="text-meta font-normal text-ink3">{count} events</span>
      </summary>
      <div
        ref={containerRef}
        onScroll={onScroll}
        data-testid="optimize-event-log-scroll"
        className="max-h-80 overflow-y-auto border-t border-line"
      >
        {count === 0 ? (
          <p className="px-4 py-3 text-meta text-ink3">
            {active ? "Waiting for optimization events…" : "No optimization events yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {log.map((entry) => (
              <li key={entry.seq} className="flex items-start gap-2.5 px-4 py-2">
                <span
                  className={cn(
                    "mt-0.5 shrink-0 border px-1.5 py-0.5 text-label font-semibold uppercase tracking-[0.03em]",
                    KIND_STYLE[entry.kind],
                  )}
                >
                  {entry.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-meta text-ink">{entry.label}</span>
                    <span className="shrink-0 text-label text-ink3">{formatTime(entry)}</span>
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
