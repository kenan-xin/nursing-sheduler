"use client";

// Current people history summary (spec 04 FR-SR-40; prototype
// ScreenRequests.dc.html:170-193) — purely presentational. The orchestrator
// precomputes one entry per person with non-empty history, each carrying its
// H-n chip label and a kind (`leave` → brand tint, `off` → error tint,
// `worked` → neutral). No search box here (matching the prototype). No data
// derivation, no store access.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { surfaceVariants } from "@/components/ui/surface";

export type HistoryChipKind = "leave" | "off" | "worked";

export interface HistoryChip {
  hn: string;
  label: string;
  kind: HistoryChipKind;
}

export interface CurrentHistoryPerson {
  key: string;
  person: string;
  entries: HistoryChip[];
}

export interface CurrentHistoryTableProps {
  people: CurrentHistoryPerson[];
}

const CHIP_TONE_CLASS: Record<HistoryChipKind, string> = {
  // leave is the pin language (--brandtint + --brandink), not a status tint, so
  // the Redundant Signal Rule does not govern it; off IS a status tint, so it
  // carries its paired --errorink (never the base --error, which differs in dark
  // mode and would leave status colour-only).
  leave: "border-brand bg-brandtint text-brandink",
  off: "border-error bg-errortint text-errorink",
  worked: "border-line2 bg-panel text-ink2",
};

export function CurrentHistoryTable({ people }: CurrentHistoryTableProps) {
  const sectionClass = cn(surfaceVariants({ role: "surface", geometry: "card" }));

  if (people.length === 0) {
    return (
      <section className={sectionClass} data-testid="current-history-table">
        <header className="flex flex-wrap items-baseline justify-between gap-2.5 border-b border-line2 px-5 py-3.5">
          <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
            Current people history
          </h2>
          <span
            className="font-mono text-label font-semibold text-ink3"
            data-testid="history-count"
          >
            0
          </span>
        </header>
        <p className="px-5 py-6 text-center text-meta text-ink3" data-testid="history-empty">
          No history entries defined yet. Click on any history cell in the matrix above to add
          entries.
        </p>
      </section>
    );
  }

  return (
    <section className={sectionClass} data-testid="current-history-table">
      <header className="flex flex-wrap items-baseline justify-between gap-2.5 border-b border-line2 px-5 py-3.5">
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
          Current people history
        </h2>
        <span className="font-mono text-label font-semibold text-ink3" data-testid="history-count">
          {people.length}
        </span>
      </header>
      <div
        className="max-h-[300px] overflow-auto"
        tabIndex={0}
        aria-label="Current people history list"
      >
        {people.map(
          (person): ReactNode => (
            <div
              key={person.key}
              data-testid={`history-row-${person.key}`}
              className="grid items-center gap-3 rounded-none border-b border-line2 px-5 py-2.5"
              style={{ gridTemplateColumns: "minmax(120px,1fr) 3fr" }}
            >
              <span className="truncate font-ui text-meta font-semibold text-ink">
                {person.person}
              </span>
              <div className="flex flex-wrap items-center gap-1.5" data-testid="history-chips">
                {person.entries.map((chip) => (
                  <span
                    key={chip.hn}
                    data-testid={`history-chip-${person.key}-${chip.hn}`}
                    data-kind={chip.kind}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-chip border px-2 py-0.5 font-ui text-meta font-semibold",
                      CHIP_TONE_CLASS[chip.kind],
                    )}
                  >
                    <span className="font-mono text-label font-bold">{chip.hn}</span>
                    <span>{chip.label}</span>
                  </span>
                ))}
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
