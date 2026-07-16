// Navigation configuration (T08). The fixed 13-tab set from spec 07 FR-ST-28,
// grouped by workflow phase (model→rules→generate→save) per the T08 ticket.
//
// Mode-visible navigation (critique #8): every capability — including Export
// Layout — has an entry point in BOTH Guided and Advanced mode. The nav set is
// identical regardless of mode; mode changes how content is *presented*, never
// what is *reachable*. So nothing is unreachable in Guided (acceptance row 5).

import {
  FaHouse,
  FaCalendarDays,
  FaUsers,
  FaClock,
  FaBolt,
  FaClipboard,
  FaFloppyDisk,
  FaSliders,
  FaArrowsLeftRight,
  FaArrowRightArrowLeft,
  FaListOl,
  FaHandshake,
  FaChalkboardUser,
} from "@/components/icons";
import type { IconType } from "@/components/icons";

export interface NavItem {
  label: string;
  path: string;
  icon: IconType;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "model",
    label: "Model",
    items: [
      { label: "Home", path: "/", icon: FaHouse },
      { label: "Dates", path: "/dates", icon: FaCalendarDays },
      { label: "People", path: "/people", icon: FaUsers },
      { label: "Shift Types", path: "/shift-types", icon: FaClock },
    ],
  },
  {
    id: "rules",
    label: "Rules",
    items: [
      { label: "Shift Type Requirements", path: "/shift-type-requirements", icon: FaSliders },
      { label: "Shift Requests", path: "/shift-requests", icon: FaArrowsLeftRight },
      {
        label: "Shift Type Successions",
        path: "/shift-type-successions",
        icon: FaArrowRightArrowLeft,
      },
      { label: "Shift Counts", path: "/shift-counts", icon: FaListOl },
      { label: "Shift Affinities", path: "/shift-affinities", icon: FaHandshake },
      { label: "Shift Type Coverings", path: "/shift-type-coverings", icon: FaChalkboardUser },
    ],
  },
  {
    id: "generate",
    label: "Generate",
    items: [{ label: "Optimize and Export", path: "/optimize-and-export", icon: FaBolt }],
  },
  {
    id: "save",
    label: "Save",
    items: [
      { label: "Export Layout", path: "/export-layout", icon: FaClipboard },
      { label: "Save and Load", path: "/save-and-load", icon: FaFloppyDisk },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
