// Navigation configuration (T08). The fixed 13-tab set from spec 07 FR-ST-28,
// grouped by workflow phase per the user-approved nav-config mapping that came
// out of the prototype-conformance audit. The taxonomy is the prototype's
// three-phase language — Home (headerless, top-level) → SET UP → OUTPUT → SYSTEM
// — which reverses this ticket's original Model/Rules/Generate/Save headings.
//
// The committed destination LABELS are retained (DL10-D4 / FR-ST-28): People,
// Shift Types, the six rule-editor names, Optimize and Export, Export Layout,
// Save and Load. Only the phase headings + grouping change.
//
// Mode-visible navigation: every capability — including Export Layout — has an
// entry point in BOTH Guided and Advanced mode. The nav set is identical
// regardless of mode; mode changes how content is *presented*, never what is
// *reachable* (acceptance row 5 / DL10). The DL10-removed AI Assistant means the
// prototype's `APPENDIX · OPTIONAL` group has no item and is dropped entirely.
//
// Beyond label/path/icon, each item may carry prototype workflow metadata
// (audit MAJOR 4): a `guidedStep` number for the six-step Guided workflow badge,
// a `countKey` naming the live scenario count to surface, and a `blurb` reused by
// the Advanced Home editor grid.

import {
  FaHouse,
  FaCalendarDays,
  FaUserNurse,
  FaLayerGroup,
  FaClipboardList,
  FaTableCells,
  FaArrowRightLong,
  FaCalculator,
  FaPeopleArrows,
  FaUserShield,
  FaWandMagicSparkles,
  FaTableColumns,
  FaFloppyDisk,
} from "@/components/icons";
import type { IconType } from "@/components/icons";

/** Live scenario counts a nav row / stat can surface. Resolved in `nav-counts.ts`. */
export type NavCountKey =
  | "people"
  | "shiftTypes"
  | "shiftRequests"
  | "requirements"
  | "successions"
  | "shiftCounts"
  | "affinities"
  | "coverings"
  | "exportRules";

export interface NavItem {
  label: string;
  path: string;
  icon: IconType;
  /** One-line description reused by the Advanced Home editor grid. */
  blurb: string;
  /** 1-based position in the six-step Guided workflow, when this row is a step. */
  guidedStep?: number;
  /** Which live scenario count to show as the row's trailing badge. */
  countKey?: NavCountKey;
}

interface NavGroup {
  id: string;
  /** Omitted on the Home group → renders headerless (prototype SET UP/OUTPUT/SYSTEM carry labels). */
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "home",
    items: [{ label: "Home", path: "/", icon: FaHouse, blurb: "Workflow overview & progress" }],
  },
  {
    id: "setup",
    label: "Set up",
    items: [
      {
        label: "Dates",
        path: "/dates",
        icon: FaCalendarDays,
        blurb: "Roster range, holidays, date groups",
        guidedStep: 1,
      },
      {
        label: "People",
        path: "/people",
        icon: FaUserNurse,
        blurb: "Nurses and people groups",
        guidedStep: 2,
        countKey: "people",
      },
      {
        label: "Shift Types",
        path: "/shift-types",
        icon: FaLayerGroup,
        blurb: "Shifts and shift-type groups",
        guidedStep: 3,
        countKey: "shiftTypes",
      },
      {
        label: "Shift Type Requirements",
        path: "/shift-type-requirements",
        icon: FaClipboardList,
        blurb: "Min nurses & skill mix per shift",
        guidedStep: 4,
        countKey: "requirements",
      },
      {
        label: "Shift Requests",
        path: "/shift-requests",
        icon: FaTableCells,
        blurb: "Person × date preferences & leave",
        guidedStep: 5,
        countKey: "shiftRequests",
      },
      {
        label: "Shift Type Successions",
        path: "/shift-type-successions",
        icon: FaArrowRightLong,
        blurb: "Forbid / encourage shift sequences",
        countKey: "successions",
      },
      {
        label: "Shift Counts",
        path: "/shift-counts",
        icon: FaCalculator,
        blurb: "Rest days, night caps, hours balance",
        countKey: "shiftCounts",
      },
      {
        label: "Shift Affinities",
        path: "/shift-affinities",
        icon: FaPeopleArrows,
        blurb: "Keep people together or apart",
        countKey: "affinities",
      },
      {
        label: "Shift Type Coverings",
        path: "/shift-type-coverings",
        icon: FaUserShield,
        blurb: "Preceptor supervision constraint",
        countKey: "coverings",
      },
    ],
  },
  {
    id: "output",
    label: "Output",
    items: [
      {
        label: "Optimize and Export",
        path: "/optimize-and-export",
        icon: FaWandMagicSparkles,
        blurb: "Run the optimiser & export",
        guidedStep: 6,
      },
      {
        label: "Export Layout",
        path: "/export-layout",
        icon: FaTableColumns,
        blurb: "Spreadsheet colours & summaries",
        countKey: "exportRules",
      },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      {
        label: "Save and Load",
        path: "/save-and-load",
        icon: FaFloppyDisk,
        blurb: "Download, upload, anonymise, start over",
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Total number of Guided workflow steps (drives the Home "N of 6" progress meter). */
export const GUIDED_STEP_COUNT = ALL_NAV_ITEMS.filter((i) => i.guidedStep != null).length;
