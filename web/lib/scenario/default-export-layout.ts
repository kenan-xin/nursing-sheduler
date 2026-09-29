// The default XLSX layout (v1 parity, audit C-01). v1 sent a generated layout
// with every run when none was saved (`generateExportLayoutConfig` in v1's
// `hooks/schedulingExportConfig.ts`, applied in `useSchedulingData.ts`), so the
// workbook carried the "[X]" unmet-request marks and the OFF / per-shift count
// rows and columns. This is that generator, ported over the canonical document.
// v1's FREEDAY group is v2's NON-WORKDAY. A saved layout is never touched.

import {
  SINGAPORE_NONWORKDAY_GROUP_ID,
  SINGAPORE_WORKDAY_GROUP_ID,
} from "@/lib/dates/holiday-groups";

import type {
  CanonicalExportConfig,
  CanonicalExportExtraColumn,
  CanonicalExportExtraRow,
  CanonicalExportFormattingRule,
  CanonicalScenarioDocument,
} from "./types";

const ALL = "ALL";
const OFF = "OFF";
const SEPARATOR_COLOR = "#000000";

function shiftCountRefs(doc: CanonicalScenarioDocument): (number | string)[] {
  return [
    ...doc.shiftTypes.items.map((item) => item.id),
    ...(doc.shiftTypes.groups ?? []).map((group) => group.id),
  ];
}

/** v1 `generateExportLayoutConfig`, over the document's own shifts and date groups. */
export function generateDefaultExportLayout(doc: CanonicalScenarioDocument): CanonicalExportConfig {
  const dateGroupIds = new Set((doc.dates.groups ?? []).map((group) => String(group.id)));
  const hasWorkday = dateGroupIds.has(SINGAPORE_WORKDAY_GROUP_ID);
  const hasNonWorkday = dateGroupIds.has(SINGAPORE_NONWORKDAY_GROUP_ID);
  const lastItemIdx = doc.shiftTypes.items.length - 1;

  const workdayColumns: CanonicalExportExtraColumn[] = [
    ...(hasWorkday ? [SINGAPORE_WORKDAY_GROUP_ID] : []),
    ...(hasNonWorkday ? [SINGAPORE_NONWORKDAY_GROUP_ID] : []),
  ].map((groupId) => ({
    type: "count",
    header: `OFF (${groupId})`,
    countShiftTypes: [OFF],
    countDates: [groupId],
  }));
  if (workdayColumns.length > 0) {
    workdayColumns[workdayColumns.length - 1].rightBorderColor = SEPARATOR_COLOR;
  }

  const unmetRequest = {
    preference: {
      types: ["shift request" as const],
      requestShape: ["person-item-to-date-item" as const],
      weightRange: [-Infinity, Infinity],
    },
  };
  const formatting: CanonicalExportFormattingRule[] = [
    {
      description: "Show requested shift request target",
      type: "cell",
      appendText: " [{shiftType}]",
      people: [ALL],
      dates: [ALL],
      shiftTypes: [ALL, OFF],
      when: unmetRequest,
    },
    {
      description: "Mark unsatisfied shift requests",
      type: "cell",
      appendText: " [X]",
      fontColor: "#c00000",
      note: { text: "Weight of unmet single-style request: {totalAbsWeight}" },
      people: [ALL],
      dates: [ALL],
      shiftTypes: [ALL, OFF],
      when: { preference: { ...unmetRequest.preference, satisfied: false } },
    },
    { type: "history header", backgroundColor: "#fefce8" },
    { type: "history", people: [ALL], backgroundColor: "#fefce8" },
    { type: "column", dates: ["SATURDAY", "SUNDAY"], backgroundColor: "#dbeafe" },
    { type: "column", dates: ["SATURDAY"], rightBorderColor: "#9ca3af" },
    ...(hasNonWorkday
      ? [
          {
            type: "column" as const,
            dates: [SINGAPORE_NONWORKDAY_GROUP_ID],
            backgroundColor: "#dcfce7",
          },
        ]
      : []),
  ];

  const extraColumns: CanonicalExportExtraColumn[] = [
    {
      type: "count",
      header: "OFF (Total)",
      countShiftTypes: [OFF],
      countDates: [ALL],
      rightBorderColor: SEPARATOR_COLOR,
    },
    ...workdayColumns,
    { type: "count", header: "OFF (Weekday)", countShiftTypes: [OFF], countDates: ["WEEKDAY"] },
    {
      type: "count",
      header: "OFF (Weekend)",
      countShiftTypes: [OFF],
      countDates: ["WEEKEND"],
      rightBorderColor: SEPARATOR_COLOR,
    },
    ...shiftCountRefs(doc).map((id, index) => ({
      type: "count" as const,
      header: `${id} Count`,
      countShiftTypes: [id],
      countDates: [ALL],
      ...(index === lastItemIdx ? { rightBorderColor: SEPARATOR_COLOR } : {}),
    })),
  ];

  const extraRows: CanonicalExportExtraRow[] = shiftCountRefs(doc).map((id, index) => ({
    type: "count",
    header: `${id} Count`,
    countShiftTypes: [id],
    countPeople: [ALL],
    ...(index === lastItemIdx ? { bottomBorderColor: SEPARATOR_COLOR } : {}),
  }));

  return { formatting, extraColumns, extraRows };
}

/** The document with the default layout filled in when it carries none; else unchanged. */
export function withDefaultExportLayout(doc: CanonicalScenarioDocument): CanonicalScenarioDocument {
  return doc.export === undefined ? { ...doc, export: generateDefaultExportLayout(doc) } : doc;
}
