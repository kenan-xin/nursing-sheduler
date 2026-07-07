---
kind: ticket
title: "Minor citation and verbatim-string corrections"
status: 0
---

# Minor citation and verbatim-string corrections

**Source:** critique-review R17–R22.

1. **R17** — contract C5 `CON-OUT-41`: "rows `3 .. 3+count`" should be the
   half-open `[3, 3+count)` / "rows `3 … 3+count−1`" (spec 10 already correct).
2. **R18** — contract C3 catalog error **E29** ("History must not include
   nested ID") is unreachable for loader-validated scenarios (E12/E13 pre-empt
   it). Annotate as unreachable; clarify "nested" means a sid expanding to
   multiple indices, not literal YAML nesting.
3. **R19** — spec 10: SSE terminal-status check is exact-case in
   `waitForOptimizeJob`/`pollOptimizeJob` (`page.tsx:690,706`) but lower-cased in
   `isJobActive` (`:497`). Pin the case-sensitivity difference; note conformance
   to C2 assumes lower-cased statuses.
4. **R20** — spec 06 `FR-RI-09`: omits that an undefined `history` coerces to
   `[]` on deletion (`schedulingReferenceUpdates.ts:63`), asymmetric with
   `FR-RI-04`'s rename path. Add it.
5. **R21** — string/citation slips: spec 08 `FR-SL-37` prose has a stray
   trailing `"` on the scatter date-category error (V17 table row is correct);
   spec 07 `FR-ST-15` cites `useSchedulingData.ts:207-213` spuriously for the
   drag-coalescing flag flip (logic actually lives in
   `app/shift-requests/page.tsx`); spec 05 `FR-PR-11` cites the delete-filter to
   `DraggableCardList` but it lives in each page's `handleDelete`; spec 02's
   live-count string drops a word — actual is
   `` `${N} day${N===1?'':'s'} selected` `` (with trailing "selected").
6. **R22 (verify-debt)** — the calendar-picker / member-selector mechanics
   (`FR-DC-13..33` in spec 02, sourced from `CalendarMonthView.tsx`,
   `DateGroupMemberSelector.tsx`, `DateRangeCalendarPicker.tsx`) were only
   partly ground-verified during critique. Run a targeted re-verify pass before
   trusting these as test seeds.
