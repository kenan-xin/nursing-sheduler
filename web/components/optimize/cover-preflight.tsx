"use client";

// d582 — Optimize preflight for temporary cover. A cover that no longer resolves
// lowers nothing (`coverStatuses`); it is listed here as a non-blocking warning so the
// run is never silently different from what the Staff screen shows.

import { useMemo } from "react";
import { GuardedLink } from "@/components/shell/guarded-link";
import { coverStatuses, type CoverFlag } from "@/lib/scenario/temporary-cover";
import { useScenarioStore } from "@/lib/store";
import { Callout } from "./callout";

const REASON: Record<CoverFlag, string> = {
  "out-of-period": "the date is outside the schedule period",
  "unknown-shift": "the shift type no longer exists",
  "unknown-group": "a staff group she is in no longer exists",
  "no-card": "no staffing rule counts her on that shift",
};

export function CoverPreflight() {
  const scenario = useScenarioStore((state) => state);
  const flagged = useMemo(
    () => coverStatuses(scenario).filter((status) => status.flag !== null),
    [scenario],
  );
  if (flagged.length === 0) return null;
  return (
    <Callout
      tone="warn"
      placement="page"
      data-testid="optimize-cover-preflight"
      title="Some temporary cover lowers no staffing need"
    >
      <ul className="list-disc space-y-1 pl-5">
        {flagged.map(({ index, flag }) => {
          const cover = scenario.temporaryCover[index];
          const label = `${cover.name}, ${cover.shiftType} on ${cover.date}`;
          return (
            <li key={index}>
              {/* The name is a single-line slot (truncate + full value on `title`);
                  the reason is prose and must wrap. `flex-wrap` lets the two take
                  separate lines rather than compete for one, and the reason is a
                  shrinkable `min-w-0` item — `shrink-0` pinned it to its max-content
                  width, which painted the callout past a 320px container. */}
              <span className="flex min-w-0 flex-wrap gap-1">
                <span className="truncate" title={label}>
                  {label}
                </span>
                <span className="min-w-0">: {REASON[flag!]}.</span>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2">
        Optimize still runs without them. Fix them on{" "}
        <GuardedLink
          href="/people"
          className="inline-flex items-center font-semibold text-brandink underline underline-offset-2 pointer-coarse:min-h-touch hover:no-underline"
        >
          Staff
        </GuardedLink>
        .
      </p>
    </Callout>
  );
}
