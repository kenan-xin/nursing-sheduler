// Icon convention — single source of truth.
//
// The project standardizes on **react-icons Font Awesome 6** (`react-icons/fa6`).
// Import icons from THIS barrel, never directly from `lucide-react` (which ships
// in the dep tree only because package.json is frozen — it must not be imported).
//
// Why a barrel and not the shadcn `iconLibrary` field: shadcn's `iconLibrary`
// only accepts `lucide` or `radix`, so react-icons cannot be expressed there.
// Components are therefore hand-authored on-token rather than pulled via
// `shadcn add`; if you ever do run `shadcn add`, rewrite the generated
// `lucide-react` imports to icons re-exported here. The design-system vitest
// test enforces that no source file imports `lucide-react`.
//
// See web/components/ui/ICONS.md for the full convention.

export {
  FaSun,
  FaMoon,
  FaCheck,
  FaXmark,
  FaPlus,
  FaTrash,
  FaPen,
  FaChevronDown,
  FaChevronUp,
  FaChevronLeft,
  FaChevronRight,
  FaCircleInfo,
  FaTriangleExclamation,
  FaCircleCheck,
  FaBars,
  FaMagnifyingGlass,
  FaGear,
  FaCalendarDays,
  FaUsers,
  FaClock,
  FaArrowRotateRight,
  FaRotateLeft,
  FaHouse,
  FaLayerGroup,
  FaDownload,
  FaBolt,
  FaClipboard,
  FaFloppyDisk,
  FaSliders,
  FaArrowsLeftRight,
  FaArrowRightArrowLeft,
  FaArrowRight,
  FaArrowLeft,
  FaAnglesRight,
  FaAnglesLeft,
  FaFileArrowUp,
  FaCopy,
  FaLock,
  FaCircleExclamation,
  FaGripVertical,
  FaListOl,
  FaHandshake,
  FaChalkboardUser,
  FaWandMagicSparkles,
  FaDiagramProject,
  FaUserNurse,
  FaTableCells,
  FaListCheck,
  FaSpinner,
  FaHashtag,
  FaCalendarDay,
  FaPowerOff,
  FaClipboardList,
  FaArrowRightLong,
  FaCalculator,
  FaPeopleArrows,
  FaUserShield,
  FaTableColumns,
  FaCodeBranch,
  FaUpload,
  FaThumbtack,
  FaShieldHalved,
  FaWifi,
  FaBan,
} from "react-icons/fa6";

export type { IconType } from "react-icons";
