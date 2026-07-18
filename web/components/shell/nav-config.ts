// Navigation configuration (T08/T08d). The fixed 13-tab set from spec 07
// FR-ST-28, grouped by workflow phase per the user-approved nav-config mapping
// that came out of the prototype-conformance audit. The taxonomy is the
// prototype's phase language — Home (headerless, top-level) → SET UP →
// CONSTRAINTS → OUTPUT → SYSTEM — which reverses this ticket's original
// Model/Rules/Generate/Save headings.
//
// The committed destination LABELS are retained (DL10-D4 / FR-ST-28): People,
// Shift Types, the six rule-editor names, Optimize and Export, Export Layout,
// Save and Load. Only the phase headings + grouping change.
//
// Mode-visible navigation (DL12 tech-plan §2, superseding the earlier DL10
// "identical in both modes" reading): Guided foregrounds Dates, People, Shift
// Types, Rules and Shift Requests; Advanced adds the raw Constraints group
// (Shift Type Requirements, Successions, Counts, Affinities, Coverings) and
// Export Layout. Every capability still has an entry point somewhere — the raw
// constraint editors are reachable from Advanced mode directly, or from Guided
// via the Rules screen's "Edit in Advanced" contextual links — but the Guided
// sidebar/Home/crumb projection no longer lists them as if they were Guided
// destinations. `getNavGroupsForMode` is the one place that applies this split;
// every nav-driven surface (sidebar, mobile drawer, Home, route validity)
// reuses it instead of filtering `NAV_GROUPS` itself. The DL10-removed AI
// Assistant means the prototype's `APPENDIX · OPTIONAL` group has no item and
// is dropped entirely.
//
// Beyond label/path/icon, each item may carry prototype workflow metadata
// (audit MAJOR 4): a `guidedStep` number for the six-step Guided workflow
// badge, an `advancedOnly` flag for the DL12 mode split, and a `blurb` reused
// by the Advanced Home editor grid.

import {
  FaHouse,
  FaCalendarDays,
  FaUserNurse,
  FaLayerGroup,
  FaClipboardList,
  FaListCheck,
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
import type { AppMode } from "@/lib/mode/mode";

export interface NavItem {
  label: string;
  path: string;
  icon: IconType;
  /** One-line description reused by the Advanced Home editor grid. */
  blurb: string;
  /** 1-based position in the six-step Guided workflow, when this row is a step. */
  guidedStep?: number;
  /** DL12 §2: reachable only in Advanced mode (raw Constraints group, Export Layout). */
  advancedOnly?: boolean;
}

export interface NavGroup {
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
      },
      {
        label: "Shift Types",
        path: "/shift-types",
        icon: FaLayerGroup,
        blurb: "Shifts and shift-type groups",
        guidedStep: 3,
      },
      {
        label: "Rules",
        path: "/rules",
        icon: FaListCheck,
        blurb: "Plain-English constraint library",
        guidedStep: 4,
      },
      {
        label: "Shift Requests",
        path: "/shift-requests",
        icon: FaTableCells,
        blurb: "Person × date preferences & leave",
        guidedStep: 5,
      },
    ],
  },
  {
    id: "constraints",
    label: "Constraints",
    items: [
      {
        label: "Shift Type Requirements",
        path: "/shift-type-requirements",
        icon: FaClipboardList,
        blurb: "Min nurses & skill mix per shift",
        advancedOnly: true,
      },
      {
        label: "Shift Type Successions",
        path: "/shift-type-successions",
        icon: FaArrowRightLong,
        blurb: "Forbid / encourage shift sequences",
        advancedOnly: true,
      },
      {
        label: "Shift Counts",
        path: "/shift-counts",
        icon: FaCalculator,
        blurb: "Rest days, night caps, hours balance",
        advancedOnly: true,
      },
      {
        label: "Shift Affinities",
        path: "/shift-affinities",
        icon: FaPeopleArrows,
        blurb: "Keep people together or apart",
        advancedOnly: true,
      },
      {
        label: "Shift Type Coverings",
        path: "/shift-type-coverings",
        icon: FaUserShield,
        blurb: "Preceptor supervision constraint",
        advancedOnly: true,
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
        advancedOnly: true,
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

/**
 * The one filtered route registry every mode-aware surface reuses (DL12 §2):
 * desktop/mobile nav, Home, crumbs and `isRouteValidForMode`. Guided drops
 * every `advancedOnly` item; a group left with no items (Constraints, in
 * Guided) is dropped entirely rather than rendering an empty/headed group.
 */
export function getNavGroupsForMode(mode: AppMode): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => mode === "advanced" || !item.advancedOnly),
  })).filter((group) => group.items.length > 0);
}

/**
 * Look up a route's registry entry regardless of mode — used only to tell a
 * policy-tracked route (Guided *or* Advanced) apart from an unlisted one
 * (e.g. `/design-system`), which carries no mode policy at all.
 */
export function findNavItem(path: string): NavItem | undefined {
  return ALL_NAV_ITEMS.find((item) => item.path === path);
}

/**
 * Look up a route's registry entry AS FILTERED for `mode` — undefined when
 * the route exists but `getNavGroupsForMode(mode)` hides it (DL12 §2
 * `advancedOnly`). This is the one projection `isRouteValidForMode` and the
 * top-bar crumb both read (T08d repair P2), so neither re-derives the
 * Guided/Advanced policy independently of the sidebar/Home/mobile-drawer
 * projection.
 */
export function getNavItemForMode(path: string, mode: AppMode): NavItem | undefined {
  return getNavGroupsForMode(mode)
    .flatMap((group) => group.items)
    .find((item) => item.path === path);
}
