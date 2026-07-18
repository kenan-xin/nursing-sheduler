"use client";

// Current shift requests table (spec 04 FR-SR-39; prototype
// ScreenRequests.dc.html:131-168) — purely presentational. The orchestrator
// precomputes the rows and hands them in pre-formatted (person/date/shift/weight
// labels and tone/caption), and this component owns only:
//   1. a local search box (case-insensitive substring over person + date + shift
//      + weight + caption), and
//   2. the three render states — empty, no-match, has-items — verbatim from the
//      prototype. No data derivation, no store access.

import { useMemo, useState } from "react";
import { FaLayerGroup, FaMagnifyingGlass, FaUsers, FaXmark } from "@/components/icons";
import { Input } from "@/components/ui/input";

export type CurrentRequestWeightTone = "positive" | "negative" | "neutral" | "pin";

export interface CurrentRequestRow {
  key: string;
  person: string;
  personIsGroup: boolean;
  dateLabel: string;
  dateIsGroup: boolean;
  shiftLabel: string;
  weightLabel: string;
  weightTone: CurrentRequestWeightTone;
  caption: string;
}

export interface CurrentRequestsTableProps {
  rows: CurrentRequestRow[];
}

const WEIGHT_TONE_CLASS: Record<CurrentRequestWeightTone, string> = {
  positive: "text-success",
  negative: "text-error",
  pin: "text-brandink",
  neutral: "text-ink",
};

function rowHaystack(row: CurrentRequestRow): string {
  return `${row.person} ${row.dateLabel} ${row.shiftLabel} ${row.weightLabel} ${row.caption}`;
}

export function CurrentRequestsTable({ rows }: CurrentRequestsTableProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => rowHaystack(row).toLocaleLowerCase().includes(needle));
  }, [rows, query]);

  if (rows.length === 0) {
    return (
      <section className="border border-line bg-surface" data-testid="current-requests-table">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-[18px] py-3.5">
          <h2 className="font-heading text-cardhead font-extrabold tracking-tight">
            Current shift requests
          </h2>
          <span
            className="font-mono text-label font-semibold text-ink3"
            data-testid="requests-count"
          >
            0
          </span>
        </header>
        <p
          className="px-[18px] py-[22px] text-center text-meta text-ink3"
          data-testid="requests-empty"
        >
          No shift requests defined yet. Click on any cell in the matrix above to add preferences.
        </p>
      </section>
    );
  }

  const trimmed = query.trim();

  return (
    <section className="border border-line bg-surface" data-testid="current-requests-table">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line2 px-[18px] py-3.5">
        <h2 className="font-heading text-cardhead font-extrabold tracking-tight">
          Current shift requests
        </h2>
        <div className="flex items-center gap-2.5">
          <div className="relative inline-flex items-center">
            <FaMagnifyingGlass className="pointer-events-none absolute left-2.5 size-3 text-ink3" />
            <Input
              type="search"
              placeholder="Search person, date, shift…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="requests-search"
              className="h-[34px] w-[230px] max-w-[52vw] pl-8 pr-7 text-meta font-medium"
            />
            {trimmed ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 inline-flex size-5 items-center justify-center bg-transparent text-ink3"
              >
                <FaXmark className="size-3" />
              </button>
            ) : null}
          </div>
          <span
            className="font-mono text-label font-semibold text-ink3"
            data-testid="requests-count"
          >
            {rows.length}
          </span>
        </div>
      </header>

      {filtered.length === 0 ? (
        <p
          className="px-[18px] py-[22px] text-center text-meta text-ink3"
          data-testid="requests-no-match"
        >
          No requests match “{trimmed}”.
        </p>
      ) : (
        <div>
          <div
            className="grid gap-2.5 border-b border-line bg-panel px-3 py-2 font-ui text-label font-semibold uppercase tracking-[0.03em] text-ink3"
            style={{
              gridTemplateColumns:
                "minmax(120px,1.4fr) minmax(90px,1fr) 64px 76px minmax(90px,1fr)",
            }}
            data-testid="requests-header-row"
          >
            <span>Person</span>
            <span>Date</span>
            <span className="text-center">Shift</span>
            <span className="text-center">Weight</span>
            <span>Intent</span>
          </div>
          <div className="max-h-[340px] overflow-auto">
            {filtered.map((row) => (
              <div
                key={row.key}
                data-testid="requests-row"
                className="grid items-center gap-2.5 border-b border-line2 px-3 py-2 text-meta"
                style={{
                  gridTemplateColumns:
                    "minmax(120px,1.4fr) minmax(90px,1fr) 64px 76px minmax(90px,1fr)",
                }}
              >
                <span className="inline-flex items-center gap-1.5 overflow-hidden">
                  {row.personIsGroup ? (
                    <FaUsers className="size-2.5 shrink-0 text-brandink" />
                  ) : (
                    <FaUsers className="size-2.5 shrink-0 text-ink3" />
                  )}
                  <span className="truncate font-ui text-meta font-semibold text-ink">
                    {row.person}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-meta text-ink2">
                  {row.dateIsGroup ? (
                    <FaLayerGroup className="size-2.5 text-brandink" />
                  ) : (
                    <FaLayerGroup className="size-2.5 text-ink3" />
                  )}
                  {row.dateLabel}
                </span>
                <span className="text-center font-mono text-meta font-semibold text-ink">
                  {row.shiftLabel}
                </span>
                <span
                  className={`text-center font-mono text-meta font-semibold ${WEIGHT_TONE_CLASS[row.weightTone]}`}
                >
                  {row.weightLabel}
                </span>
                <span className="inline-flex items-center gap-1.5 text-meta text-ink2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 bg-current opacity-70"
                    style={{ color: "var(--ink3)" }}
                  />
                  <span>{row.caption}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
