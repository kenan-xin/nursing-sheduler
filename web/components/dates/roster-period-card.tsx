"use client";

// Roster-period card (T10; spec 02 FR-DC-01..12/20/21/29/30/37..40 / acceptance
// rows 2 & 3), re-skinned for v2 "Mint Canvas, Warm Ink" (R2a) against
// docs/design_prototype/source/ScreenDates.dc.html. ONE card consolidating the
// whole roster-period surface the prototype teaches at ScreenDates lines 22-79:
// the two date inputs, the live DURATION + month, the span-dependent Date-IDs
// explainer (format badge / example / note), and the Singapore holiday import
// switch + compact holiday list.
//
// Surfaces (DESIGN.md §4): the card is a resting L1 `surface` on the page plane;
// the Date-IDs explainer is an inset `well` inside it; the holiday list's heading
// is a full-bleed `band` (square, flat) inside a control-radius box that clips it.
// Fields, the switch and the format chip are the shared v2 primitives, so their
// radius, focus treatment and coarse-pointer sizing are decided once.
//
// The card owns an isolated `{start,end}` draft seeded from the committed range and
// re-seeded whenever the committed range changes underneath it (undo/redo, external
// cascade). A change that produces a COMPLETE, valid range commits immediately as
// ONE tracked mutation (the range cascade + optional holiday overwrite); an
// incomplete edit is held locally so a half-typed range never runs the destructive
// cascade. The holiday dataset is bundled offline (ENGLISH-ONLY, no network), so the
// switch is gated only by the supported-window check (spec 02 FR-DC-29/30).

import { useEffect, useId, useMemo, useState } from "react";
import {
  getDateIdForRange,
  getHolidaysInRange,
  getSupportLabel,
  hasCompleteRange,
  isRangeSupported,
  rangeDayCount,
  type DateRange,
} from "@/lib/dates";
import { FaHashtag } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { Switch } from "@/components/ui/switch";
import { rangeSpanLabel } from "./range-span-label";

export interface RosterPeriodCardProps {
  /** The committed roster range (`""` endpoints when unset). */
  range: DateRange;
  /**
   * Whether the loaded scenario ACTUALLY carries the imported Singapore holiday
   * groups (WORKDAY / NON-WORKDAY / PH). Seeds the import switch's initial state so
   * a loaded scenario without those groups never shows the switch ON / a false
   * "N marked" (spec 02 FR-DC-40).
   */
  importedHolidaysPresent: boolean;
  /** Commit a confirmed range + the effective import flag (one tracked mutation). */
  onCommit: (range: DateRange, importHolidays: boolean) => void;
}

const HOLIDAY_DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** A holiday's day label, e.g. `Fri, 1 May`. */
function holidayDayLabel(iso: string): string {
  return HOLIDAY_DAY.format(new Date(`${iso}T00:00:00Z`));
}

/** The span-dependent Date-IDs explainer copy (prototype ScreenDates 418-428). */
function dateIdInfo(range: DateRange): { format: string; example: string; note: string } {
  if (!hasCompleteRange(range)) {
    return {
      format: "DD (2-digit day)",
      example: "01, … 28",
      note: "All dates fall in one month.",
    };
  }
  const example = `${getDateIdForRange(range.start, range)}, … ${getDateIdForRange(range.end, range)}`;
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  const sameMonth = sameYear && range.start.slice(5, 7) === range.end.slice(5, 7);
  if (sameMonth) {
    return {
      format: "DD (2-digit day)",
      example,
      note: "Dates stay within one month, so each ID is the day of month.",
    };
  }
  if (sameYear) {
    return {
      format: "MM-DD",
      example,
      note: "The range spans months in one year, so IDs include the month.",
    };
  }
  return {
    format: "YYYY-MM-DD",
    example,
    note: "The range crosses a year boundary, so IDs are the full ISO date.",
  };
}

export function RosterPeriodCard({
  range,
  importedHolidaysPresent,
  onCommit,
}: RosterPeriodCardProps) {
  const [draft, setDraft] = useState<DateRange>(range);
  // Honest initial state. A LOADED scenario (complete committed range at mount)
  // reflects whether the SG holiday groups are actually present, so it never shows
  // a false "N marked". A FRESH roster (no committed range yet) keeps auto-import
  // ON so a brand-new scenario imports SG holidays on its first commit.
  const [importHolidays, setImportHolidays] = useState(
    hasCompleteRange(range) ? importedHolidaysPresent : true,
  );
  const startId = useId();
  const endId = useId();

  // Re-seed the draft when the committed range changes underneath us (undo/redo,
  // external cascade). After a self-commit the prop equals the draft, so no clobber.
  useEffect(() => {
    setDraft({ start: range.start, end: range.end });
  }, [range.start, range.end]);

  const complete = hasCompleteRange(draft);
  // A no-commit draft is INVALID (not merely incomplete) when both endpoints are
  // present but out of order. `type="date"` inputs only emit valid ISO or "", so a
  // non-empty pair that isn't `complete` can only be `start > end`.
  const invalid = Boolean(draft.start && draft.end) && draft.start > draft.end;
  const supported = useMemo(
    () => Boolean(draft.start && draft.end) && isRangeSupported(draft),
    [draft],
  );
  const effectiveImport = importHolidays && supported;
  const holidays = useMemo(() => (complete ? getHolidaysInRange(draft) : []), [draft, complete]);
  const ids = useMemo(() => dateIdInfo(draft), [draft]);
  const duration = complete ? rangeDayCount(draft) : 0;
  const monthLabel = rangeSpanLabel(draft);

  /** Update one endpoint; commit immediately once the draft is a valid range. */
  const editEndpoint = (side: "start" | "end", value: string) => {
    const next = { ...draft, [side]: value };
    setDraft(next);
    if (hasCompleteRange(next)) onCommit(next, importHolidays && isRangeSupported(next));
  };

  const toggleImport = () => {
    const next = !importHolidays;
    setImportHolidays(next);
    if (complete) onCommit(draft, next && supported);
  };

  return (
    <section
      className={cn(surfaceVariants({ role: "surface", geometry: "card" }))}
      data-testid="roster-period-card"
    >
      <div className="border-b border-line2 px-[18px] py-4">
        {/* Headline: Figtree 600 / -0.015em (DESIGN.md §3). v1 ran 800 at the
            default tracking; v2 is two weight steps lighter. */}
        <h2 className="font-heading text-cardhead font-semibold tracking-[-0.015em]">
          Roster period
        </h2>
      </div>
      <div className="p-[18px]">
        <div className="flex flex-wrap gap-3.5">
          {/* The label is explicitly associated rather than relying on a wrapping
              <label>, so the field's accessible name survives the primitive swap. */}
          <div className="flex min-w-[140px] flex-1 flex-col gap-[7px]">
            <Label htmlFor={startId}>Start date</Label>
            <Input
              type="date"
              id={startId}
              data-testid="range-start"
              value={draft.start}
              onChange={(e) => editEndpoint("start", e.target.value)}
            />
          </div>
          <div className="flex min-w-[140px] flex-1 flex-col gap-[7px]">
            <Label htmlFor={endId}>End date</Label>
            <Input
              type="date"
              id={endId}
              data-testid="range-end"
              value={draft.end}
              onChange={(e) => editEndpoint("end", e.target.value)}
            />
          </div>
        </div>

        {/* `--rule` is the emphasis rule (DESIGN.md §2), the one place a 2px edge
            is intended — it separates the committed summary from the inputs. */}
        <div className="mt-4 flex items-center gap-2.5 border-t-2 border-rule pt-3.5">
          <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink3">
            Duration
          </span>
          <span
            className="font-heading text-title font-semibold tracking-[-0.015em]"
            data-testid="range-duration"
          >
            {invalid ? "—" : `${duration} day${duration === 1 ? "" : "s"}`}
          </span>
          <span className="text-meta text-ink3">· {monthLabel}</span>
        </div>

        {/* Semantic text on a plain surface takes the deepest `ink` tier, not the
            base tier, which DESIGN.md §2 scopes to text on its own tint. */}
        {invalid ? (
          <p className="mt-3 text-meta text-warnink" data-testid="range-invalid">
            End date must be on or after the start date.
          </p>
        ) : null}

        {/* An inset island inside the card, so it is the `well` level: `--panel`
            with the inset cast and no border of its own (DESIGN.md §4 rule 1). */}
        <Surface
          level="well"
          geometry="control"
          className="mt-3.5 px-3.5 py-3"
          data-testid="date-id-explainer"
        >
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <FaHashtag className="size-3 text-ink3" />
            <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
              Date IDs
            </span>
            {/* The format is authored-looking data (`MM-DD`), so the chip reads
                exactly as written rather than being uppercased. */}
            <Badge
              variant="brand"
              casing="normal"
              className="font-mono"
              data-testid="date-id-format"
            >
              {ids.format}
            </Badge>
          </div>
          <div className="mb-1 font-mono text-label-md text-ink">{ids.example}</div>
          <div className="text-meta text-ink3">
            {ids.note} These IDs are what rules, groups, and the YAML reference.
          </div>
        </Surface>

        <div className="mt-[18px] flex items-start justify-between gap-3">
          <div>
            <div className="text-body font-semibold">Import Singapore public holidays</div>
            <div className="mt-[3px] max-w-[38ch] text-meta text-ink2">
              Marks gazetted holidays as non-work days so the roster staffs them like weekends.
            </div>
          </div>
          {/* The shared Base UI Switch: the pressable root IS the 44x44 coarse
              target and the 36x20 track is its centred child, so nothing here
              simulates a touch target with an overlapping pseudo-element (T8). */}
          <Switch
            aria-label="Import Singapore public holidays"
            data-testid="import-toggle"
            checked={effectiveImport}
            disabled={!supported}
            onCheckedChange={toggleImport}
          />
        </div>

        {!supported ? (
          <p className="mt-3 text-meta text-warnink" data-testid="import-unsupported">
            Available only when the roster range stays within {getSupportLabel()}.
          </p>
        ) : effectiveImport ? (
          // A small bordered list, so the heading band it clips is FULL-BLEED and
          // square while the box itself takes the control radius (DESIGN.md §4
          // rule 2). `overflow-hidden` is what makes the band meet the corners.
          <div
            className="mt-4 overflow-hidden rounded-control border border-line2"
            data-testid="import-changes"
          >
            <div
              className={cn(
                "flex justify-between px-3 py-2.5",
                surfaceVariants({ role: "band", geometry: "square" }),
              )}
            >
              <span className="text-label font-semibold uppercase tracking-[0.03em] text-ink2">
                {monthLabel} holidays
              </span>
              <span
                className="text-label font-semibold uppercase tracking-[0.03em] text-ink2"
                data-testid="import-count"
              >
                {holidays.length} marked
              </span>
            </div>
            {holidays.map((entry) => (
              <div
                key={entry.date}
                className="flex items-center gap-2.5 border-t border-line2 px-3 py-2.5"
                data-testid={`holiday-${entry.date}`}
              >
                {/* A data mark, so it stays a square 8px block. */}
                <span className="size-2 flex-none bg-warn" aria-hidden />
                <span className="min-w-[96px] font-mono text-label text-ink2">
                  {holidayDayLabel(entry.date)}
                </span>
                <span className="text-meta">{entry.name}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Hidden marker asserting the import list never renders a bilingual column. */}
        <span className="sr-only" data-testid="import-english-only" aria-hidden>
          {effectiveImport ? "english-only" : ""}
        </span>
      </div>
    </section>
  );
}
