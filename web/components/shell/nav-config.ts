// Navigation configuration (T08/T08d). The fixed 14-tab set from spec 07
// FR-ST-28, grouped by workflow phase per the user-approved nav-config mapping
// that came out of the prototype-conformance audit. The taxonomy is the
// prototype's phase language — Home (headerless, top-level) → SET UP →
// CONSTRAINTS → OUTPUT → SYSTEM — which reverses this ticket's original
// Model/Rules/Generate/Save headings.
//
// NAV-1 / Decision A — SPEC DEVIATION (recorded): the destination LABELS below
// are the PROTOTYPE's (SideNav.dc.html + Nurse Scheduling v2.dc.html), NOT spec 07
// FR-ST-28 / DL10-D4. This is a deliberate display-text-only override for visual
// fidelity (chosen by dev-seahouse) — Staff (was People), Shifts (was Shift
// Types), Requests & Leave (was Shift Requests), Staffing Requirements (was Shift
// Type Requirements), Shift Successions (was Shift Type Successions), Affinities
// (was Shift Affinities), Optimize & Export, Save & Load. ROUTES, data keys,
// icons and testids are UNCHANGED (/people, /shift-types, …). A future
// spec-conformance check must NOT "fix" these labels back to FR-ST-28. (Export
// Layout — prototype
// ScreenExport — is deferred to the backlog (T15 / nursing-sheduler-qq0.15)
// and has no shipped screen or nav entry; the exportLayout data model and its
// default XLSX layout are unaffected.)
//
// Mode-visible navigation (DL12 tech-plan §2, superseding the earlier DL10
// "identical in both modes" reading): Guided foregrounds Dates, People, Shift
// Types, Rules and Shift Requests; Advanced adds the raw Constraints group
// (Shift Type Requirements, Successions, Counts, Affinities, Coverings).
// Every capability still has an entry point somewhere — the raw
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
  FaCalendarCheck,
  FaFloppyDisk,
  FaGear,
} from "@/components/icons";
import type { IconType } from "@/components/icons";
import type { AppMode } from "@/lib/mode/mode";
import { NAV_ROUTE_PATHS, type NavRouteId } from "./nav-route-paths";

// The STABLE route ids and their paths live in `./nav-route-paths` — a
// dependency-free module, so build tooling and the Playwright suite can learn the
// id↔path binding without importing the icon barrel (and React with it). Each entry
// below takes its `path` from that map rather than restating the string, so the two
// cannot disagree. Re-exported here because this file remains the registry's public
// face for every existing consumer.
//
// WHY IDS AT ALL. A route's path is a URL and its label is display text; both are
// allowed to change. The help/capability registry needs a name for a screen that
// survives either change, so it references screens by id alone — never by a
// duplicated path string, and never by a raw URL the model could invent.
// `nav-route-ids.test.ts` proves the id map and `ALL_NAV_ITEMS` are in exact
// bijection, so neither can grow an entry the other lacks.
export { NAV_ROUTE_IDS, NAV_ROUTE_PATHS, navRoutePath, type NavRouteId } from "./nav-route-paths";

export interface NavItem {
  /** Stable identity for this destination. Survives a path or label change. */
  id: NavRouteId;
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
    items: [
      {
        id: "home",
        label: "Home",
        path: NAV_ROUTE_PATHS.home,
        icon: FaHouse,
        blurb: "Workflow overview & progress",
      },
    ],
  },
  {
    id: "setup",
    label: "Set up",
    items: [
      {
        id: "dates",
        label: "Dates",
        path: NAV_ROUTE_PATHS.dates,
        icon: FaCalendarDays,
        blurb: "Roster range, holidays, date groups",
        guidedStep: 1,
      },
      {
        id: "people",
        label: "Staff",
        path: NAV_ROUTE_PATHS.people,
        icon: FaUserNurse,
        blurb: "Nurses and people groups",
        guidedStep: 2,
      },
      {
        id: "shift-types",
        label: "Shifts",
        path: NAV_ROUTE_PATHS["shift-types"],
        icon: FaLayerGroup,
        blurb: "Shifts and shift-type groups",
        guidedStep: 3,
      },
      {
        id: "rules",
        label: "Rules",
        path: NAV_ROUTE_PATHS.rules,
        icon: FaListCheck,
        blurb: "Plain-English constraint library",
        guidedStep: 4,
      },
      {
        id: "shift-requests",
        label: "Requests & Leave",
        path: NAV_ROUTE_PATHS["shift-requests"],
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
        id: "shift-type-requirements",
        label: "Staffing Requirements",
        path: NAV_ROUTE_PATHS["shift-type-requirements"],
        icon: FaClipboardList,
        blurb: "Nurses per shift & who may work it",
        advancedOnly: true,
      },
      {
        id: "shift-type-successions",
        label: "Shift Successions",
        path: NAV_ROUTE_PATHS["shift-type-successions"],
        icon: FaArrowRightLong,
        blurb: "Forbid / encourage shift sequences",
        advancedOnly: true,
      },
      {
        id: "shift-counts",
        label: "Shift Counts",
        path: NAV_ROUTE_PATHS["shift-counts"],
        icon: FaCalculator,
        blurb: "Rest days, night caps, hours balance",
        advancedOnly: true,
      },
      {
        id: "shift-affinities",
        label: "Affinities",
        path: NAV_ROUTE_PATHS["shift-affinities"],
        icon: FaPeopleArrows,
        blurb: "Keep people together or apart",
        advancedOnly: true,
      },
      {
        id: "shift-type-coverings",
        label: "Shift Type Coverings",
        path: NAV_ROUTE_PATHS["shift-type-coverings"],
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
        id: "optimize-and-export",
        label: "Optimise & Export",
        path: NAV_ROUTE_PATHS["optimize-and-export"],
        icon: FaWandMagicSparkles,
        blurb: "Run the optimiser & export",
        guidedStep: 6,
      },
      // G4 — the Roster destination is the second Output entry (prototype
      // SideNav.dc.html / Nurse Scheduling v2.dc.html, group:out). It sits
      // alongside Optimise & Export, is reachable in BOTH modes, and carries
      // NO `guidedStep` — keeping `GUIDED_STEP_COUNT` at six. Persistent
      // shell navigation is its entry in both modes; Advanced Home gains
      // the prototype-aligned editor card with the same blurb.
      {
        id: "roster",
        label: "Roster",
        path: NAV_ROUTE_PATHS.roster,
        icon: FaCalendarCheck,
        blurb: "View & manually adjust results",
      },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      {
        id: "save-and-load",
        label: "Save & Load",
        path: NAV_ROUTE_PATHS["save-and-load"],
        icon: FaFloppyDisk,
        blurb: "Download, upload, anonymise, start over",
      },
      // T04. Visible in BOTH modes and not `advancedOnly`: it is the only place the
      // optional AI assistant can be discovered or turned off, and a Guided user is
      // exactly the user that feature is for. It carries no `guidedStep` because it
      // is not part of the six-step workflow.
      {
        id: "settings",
        label: "Settings",
        path: NAV_ROUTE_PATHS.settings,
        icon: FaGear,
        blurb: "Optional AI assistant and its OpenRouter key",
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

/**
 * Look up a destination by its STABLE id (T06). Total over `NavRouteId` — the
 * bijection test guarantees every id in the tuple is registered — so the
 * capability registry can resolve a screen without carrying a path string of its
 * own, and a renamed path stays a one-line change here.
 */
export function findNavItemById(id: NavRouteId): NavItem {
  const item = ALL_NAV_ITEMS.find((candidate) => candidate.id === id);
  // Unreachable while the bijection test passes. Throwing rather than returning
  // undefined keeps every caller free of a branch that cannot happen, and turns a
  // hand-edited registry that broke the invariant into an immediate, loud failure
  // instead of a silently missing help target.
  if (!item) throw new Error(`nav-config: no navigation entry for route id "${id}"`);
  return item;
}

/** The stable id for a path, or undefined for an unlisted route. */
export function navRouteIdForPath(path: string): NavRouteId | undefined {
  return findNavItem(path)?.id;
}

/**
 * Whether a destination is reachable in `mode`, addressed by stable id. The
 * capability registry's mode check reads THIS rather than re-deriving
 * `advancedOnly`, for the same reason `isRouteValidForMode` does: one filtered
 * projection, so a help answer can never offer a screen the sidebar hides.
 */
export function isRouteIdVisibleInMode(id: NavRouteId, mode: AppMode): boolean {
  return getNavItemForMode(findNavItemById(id).path, mode) != null;
}
