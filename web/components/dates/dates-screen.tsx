"use client";

// Dates screen orchestrator (T10; spec 02; audit MAJOR 1-6), re-skinned for v2
// "Mint Canvas, Warm Ink" (R2a) against
// docs/design_prototype/source/ScreenDates.dc.html. Reproduces the prototype
// ScreenDates layout: a STEP 1 hero with the "Continue to staff" CTA, a responsive
// two-column work area (Roster-period card | Calendar card), and the full-width
// Date-groups card beneath it.
//
// Surfaces, in ladder order (DESIGN.md §4): the screen root is the L0 page plane
// and every card on it is a resting L1 `surface`. Wells, bands and the selection
// language live inside those cards, in their own components.
//
// Every mutation is ONE tracked patch (one zundo entry): a range commit runs the
// pure range cascade (`applyRangeChange`, which wraps the T07 delete cascade for
// removed ids); group create/rename/set-members/delete route through the SHARED
// entity-editor core via the Dates descriptor (fs7) — a create composes
// `addGroup` + `setGroupMembers` into a single patch, a save composes an optional
// `renameGroup` (T07 cascade) with `setGroupMembers`. Reserved auto-derived ids are
// never editable/deletable (no affordance is rendered; the handlers guard anyway).

import { useMemo } from "react";
import { GuardedLink } from "@/components/shell/guarded-link";
import {
  addGroup,
  deleteGroup,
  renameGroup,
  setGroupMembers,
} from "@/components/entity-editor/core";
import { useScenarioStore } from "@/lib/store";
import {
  applyRangeChange,
  hasCompleteRange,
  isDerivedDateGroupId,
  isReservedDateGroupId,
  SINGAPORE_NONWORKDAY_GROUP_ID,
  SINGAPORE_PH_GROUP_ID,
  SINGAPORE_WORKDAY_GROUP_ID,
  type DateRange,
} from "@/lib/dates";
import { FaArrowRight } from "@/components/icons";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Surface, surfaceVariants } from "@/components/ui/surface";
import { datesDescriptor } from "./dates-descriptor";
import { RosterPeriodCard } from "./roster-period-card";
import { CalendarView } from "./calendar-view";
import { DateGroupsCard } from "./date-groups-card";

// The three editable groups the SG holiday import writes; their presence in a
// loaded scenario is what makes the roster card's import switch honest.
const SG_HOLIDAY_GROUP_IDS: ReadonlySet<string> = new Set([
  SINGAPORE_WORKDAY_GROUP_ID,
  SINGAPORE_NONWORKDAY_GROUP_ID,
  SINGAPORE_PH_GROUP_ID,
]);

export function DatesScreen() {
  const rangeStart = useScenarioStore((s) => s.rangeStart);
  const rangeEnd = useScenarioStore((s) => s.rangeEnd);
  const dateGroups = useScenarioStore((s) => s.dateGroups);

  const range: DateRange = { start: rangeStart, end: rangeEnd };
  const complete = hasCompleteRange(range);

  const editableGroups = useMemo(
    () => dateGroups.filter((group) => !isDerivedDateGroupId(group.id)),
    [dateGroups],
  );

  // Whether the loaded scenario actually carries the imported SG holiday groups, so
  // the roster card's import switch shows an honest initial state (no false import).
  const importedHolidaysPresent = useMemo(
    () => dateGroups.some((group) => SG_HOLIDAY_GROUP_IDS.has(group.id)),
    [dateGroups],
  );

  const handleCommit = (newRange: DateRange, importHolidays: boolean) => {
    useScenarioStore
      .getState()
      .mutateScenario((state) =>
        applyRangeChange(state, newRange, { importSingaporeHolidays: importHolidays }),
      );
  };

  const handleCreateGroup = (name: string, memberIds: string[]) => {
    // Reserved keyword OR concrete date-literal shape — never authorable (producer/T07).
    if (isReservedDateGroupId(name)) return;
    useScenarioStore
      .getState()
      .mutateScenario((state) =>
        setGroupMembers(
          addGroup(state, datesDescriptor, { id: name }),
          datesDescriptor,
          name,
          memberIds,
        ),
      );
  };

  const handleSaveGroup = (oldId: string, name: string, memberIds: string[]) => {
    if (isDerivedDateGroupId(oldId) || isReservedDateGroupId(name)) return;
    useScenarioStore.getState().mutateScenario((state) => {
      const renamed = name === oldId ? state : renameGroup(state, datesDescriptor, oldId, name);
      return setGroupMembers(renamed, datesDescriptor, name, memberIds);
    });
  };

  const handleDeleteGroup = (id: string) => {
    if (isDerivedDateGroupId(id)) return; // reserved ids are never deletable
    useScenarioStore.getState().mutateScenario((state) => deleteGroup(state, datesDescriptor, id));
  };

  return (
    <Surface
      level="page"
      geometry="square"
      data-testid="screen"
      data-screen="Dates"
      className="flex flex-col gap-5"
    >
      <header className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 1 · Dates
          </div>
          {/* Display: Figtree 700 / 1.15 / -0.015em (DESIGN.md §3). v1 ran 800 at
              1.05 and -0.02em; v2 is one weight step lighter with an opener line.
              Copy and wrapping are unchanged. */}
          <h1 className="mb-2 font-heading text-display font-bold leading-[1.15] tracking-[-0.015em]">
            Schedule Dates
          </h1>
          <p className="max-w-[56ch] text-ink2">
            Choose the month you are rostering. Days are generated automatically, and public
            holidays are marked for you.
          </p>
        </div>
        {/* Still a real `<a href>`, so copy-link and open-in-new-tab keep working
            and the shell's draft guard still stages on a plain click. It wears the
            shared Button recipe rather than a hand-rolled skin, so the pill,
            `--sh-1`, active-flatten, focus outline and 44px coarse floor all come
            from one contract. `lg` is the prototype's 44px primary action. */}
        <GuardedLink
          href="/people"
          className={cn(buttonVariants({ size: "lg" }), "font-bold")}
          data-testid="dates-continue"
        >
          Continue to staff <FaArrowRight />
        </GuardedLink>
      </header>

      {/* `.ns-grid2` — two-up at 900px with a 16px gap (ScreenDates.dc.html:20). This
          was the one layout rule already ported at its true value, as a hand-written
          class in calendar.css; it now shares the layout ladder with every other one
          rather than being a second mechanism for the same job. */}
      <div className="grid grid-cols-1 items-start gap-4 grid2:grid-cols-2">
        <RosterPeriodCard
          range={range}
          importedHolidaysPresent={importedHolidaysPresent}
          onCommit={handleCommit}
        />
        {complete ? (
          <CalendarView range={range} />
        ) : (
          // The placeholder stands in for the calendar card, so it is the same
          // resting L1 card and holds the column's height while the range is unset.
          <section
            className={cn(
              "flex min-h-61 items-center justify-center p-6",
              surfaceVariants({ role: "surface", geometry: "card" }),
            )}
            data-testid="calendar-empty"
          >
            <p className="text-center text-meta text-ink3">
              Set a start and end date to preview the roster calendar.
            </p>
          </section>
        )}
      </div>

      <DateGroupsCard
        range={range}
        editableGroups={editableGroups}
        onCreateGroup={handleCreateGroup}
        onSaveGroup={handleSaveGroup}
        onDeleteGroup={handleDeleteGroup}
      />
    </Surface>
  );
}
