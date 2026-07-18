"use client";

// Dates screen orchestrator (T10; spec 02; audit MAJOR 1-6). Reproduces the
// prototype ScreenDates layout: a STEP 1 hero with the "Continue to staff" CTA, a
// responsive two-column work area (Roster-period card | Calendar card), and the
// full-width Date-groups card beneath it.
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
  type DateRange,
} from "@/lib/dates";
import { FaArrowRight } from "@/components/icons";
import { datesDescriptor } from "./dates-descriptor";
import { RosterPeriodCard } from "./roster-period-card";
import { CalendarView } from "./calendar-view";
import { DateGroupsCard } from "./date-groups-card";

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
    <div
      data-testid="screen"
      data-screen="Dates"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8"
    >
      <header className="mb-2 flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <div className="mb-2 text-label font-semibold uppercase tracking-[0.03em] text-brandink">
            Step 1 · Dates
          </div>
          <h1 className="mb-2 font-heading text-display font-extrabold leading-[1.05] tracking-[-0.02em]">
            Schedule Dates
          </h1>
          <p className="max-w-[56ch] text-ink2">
            Choose the month you are rostering. Days are generated automatically, and public
            holidays are marked for you.
          </p>
        </div>
        <GuardedLink
          href="/people"
          className="ns-btn ns-btn--primary h-11 px-5 text-body"
          data-testid="dates-continue"
        >
          Continue to staff <FaArrowRight className="size-3" />
        </GuardedLink>
      </header>

      <div className="ns-grid2 items-start">
        <RosterPeriodCard range={range} onCommit={handleCommit} />
        {complete ? (
          <CalendarView range={range} />
        ) : (
          <section
            className="flex min-h-[220px] items-center justify-center border border-line bg-surface p-6 text-center text-sm text-ink3"
            data-testid="calendar-empty"
          >
            Set a start and end date to preview the roster calendar.
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
    </div>
  );
}
