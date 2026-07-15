# Handoff: Nurse Scheduling — Frontend Rebuild

## Overview
A responsive, mobile-first UI for a nurse-rostering application. The user models a
ward (people, shift types, calendar), expresses scheduling rules, runs a fixed
Python optimization core (OR-Tools CP-SAT), and exports the solved roster as a
styled XLSX. This package is the **complete redesigned frontend prototype** for
that whole loop — every screen and capability in the functional spec has a home.

The product loop: **Model the ward → Express the rules → Generate the roster → Review & export.**

## About the design files
The files in this bundle are **design references authored in HTML** (as "Design
Components", see below) — high-fidelity prototypes showing intended look, layout,
copy, and interaction. They are **not** production code to ship directly. The task
is to **recreate these designs in the target codebase** using its established
framework and patterns. If no frontend exists yet, the spec (see "The binding
contract" below) names the shipped stack as a Next.js/React app — recreate the UI
in React there.

## The binding contract (read this before implementing)
There is exactly **one** binding layer: the **Python backend** — its data shapes,
validation, exact error strings, selector expansion, constraint semantics, HTTP
behavior, and XLSX exporter output. The **UI is free**: this prototype's visual
system, navigation, and interaction choreography are proposals, not requirements.

The authoritative capability source of truth is the functional spec corpus the
user maintains separately (`nurse-scheduling-functional-spec/`, domains 01–12,
plus `CONTRACTED-HOURS-DESIGN-NOTE.md`). **Where this prototype and the spec ever
disagree, the spec wins.** Throughout the code, behaviors are annotated with their
spec IDs (`FR-…`, `AC-…`, `CON-…`, `C1`/`C2`/`F2`) so you can trace each UI
affordance back to its requirement. Search the source for those tags.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, component design, and
interaction states are all specified. Recreate the UI pixel-faithfully using the
codebase's own component library where equivalents exist; use the exact tokens
below where they don't.

## Architecture of the prototype (important)
The prototype is built as **Design Components (`.dc.html`)** — a lightweight
runtime (`support.js`) that renders an inline HTML template driven by a
`class Component` logic block. This is a *prototype* convention, **not** a target
framework. When porting:

- Treat each `Screen*.dc.html` as one screen/route component.
- `Nurse Scheduling.dc.html` is the **app shell + single source of truth**. Its
  logic class holds the entire scenario store (people, groups, shifts, shift
  groups, dates, date groups, rule cards by kind, requests, export layout, run
  state) and every mutation handler. Screens receive a `vals` prop bag of data +
  callbacks. **Port this as one store** (Redux/Zustand/Context) — the spec §07
  calls for a single store — with screen components subscribing to slices.
- `SideNav.dc.html` and `InfoTip.dc.html` are shared sub-components.
- The `{{ … }}` holes are simple data bindings; `<sc-if>` / `<sc-for>` are
  conditional/repeat; `<dc-import>` mounts a child component. Map these to your
  framework's equivalents.

### State model (single store)
Key slices (see the constructor + handlers in `Nurse Scheduling.dc.html`):
`theme, mode (guided|advanced), screen, staff[], staffGroups[], shifts[],
shiftGroups[], dateGroups[], rangeStart/rangeEnd, cardsByKind{requirements,
successions, counts, affinities, coverings}, reqData (person×date requests+history),
guidedShortcuts[], exportSecs[], runState, schedule, undoStack`.

**IDs are labels** — renaming an entity must cascade to every reference (rules,
groups, requests, history, export layout, roster). The prototype implements the
full cascade (`_mapLabelInCards`, `_renameShiftInCards`, `_removeShiftFromCards`,
etc.) and surfaces an impact-preview confirm modal before any destructive change.
Reproduce this cascade behavior — it is a spec requirement (§06), not decoration.

### Serialization boundary (flagged `F2` in source)
Several fields are UI-only and must be stripped/resolved before generating scenario
YAML or POSTing to `/optimize`: React keys (`_k`, `uid`), the guided on/off
`disabled` flag, card UI markers (`unit`/`tag`/`applied`), and `guidedShortcuts`
(a UI projection, not a backend concept). `tag:'contracted_hours'` maps to the
backend `hoursContract:{unit:'half-hour', policy}` marker. See the constructor
comment block and `saveContract()` in `ScreenCards.dc.html`.

## Design tokens

### Typography
- Display / headings: **Figtree** (weights 500–900)
- UI / body: **Hanken Grotesk** (400–700)
- Mono (codes, weights, data): **Spline Sans Mono** (400–700)
- Type scale is **fluid**, driven by `--base-h` / `--base-b` / `--base-l` that
  step up at breakpoints 480/768/1024/1280/1440/1920px, and by a density
  multiplier (Spacious 1.16 / Comfortable 1.0 / Compact 0.9). Headings use
  `letter-spacing:-.02em`; uppercase eyebrows/labels use `+.03em`.

### Color — light theme
| Token | Hex | Use |
|---|---|---|
| `--ink` | `#14161b` | primary text |
| `--ink2` | `#4a515c` | secondary text |
| `--ink3` | `#8b929c` | tertiary/labels |
| `--faint` | `#aab0ba` | disabled/placeholder |
| `--on-ink` | `#ffffff` | text on dark chrome |
| `--bg` | `#fbfcfd` | app background |
| `--surface` | `#ffffff` | cards/panels |
| `--panel` | `#f2f4f7` | inset/subtle fills |
| `--line` | `#c8cdd5` | primary borders |
| `--line2` | `#e2e5ea` | hairline dividers |
| `--rule` | `#14161b` | emphasis rule |
| `--brand` | `#2360c4` | primary/accent |
| `--brandtint` | `#eef4fc` | brand fill |
| `--onbrand` | `#ffffff` | text on brand |
| `--success` | `#1f9a5c` / tint `#eafaf1` | positive weights, saved |
| `--warn` | `#b07d10` / tint `#fbf3df` | caution, negative weights |
| `--error` | `#d94032` / tint `#fbeae8` | destructive, infeasible |

### Color — dark theme (`[data-theme="dark"]`)
`--ink:#eef1f4; --ink2:#9aa3b0; --ink3:#6b7585; --bg:#13171e; --surface:#181d25;
--panel:#1d242e; --line:#313a46; --line2:#262e38; --brandink:#7fb2f0;
--brandtint:#1c2738; --success:#5fcf94; --warn:#d6a743; --error:#e06a5e`.

### Selectable accents (tweakable prop)
`#2360c4` (default), `#0e7490`, `#b0357a`, `#3f4a63`. Brand-ink and brand-tint are
derived from the accent via `color-mix` (lightened in dark mode).

### Spacing / radius / motion
- Spacing scale `--space-1…12` = 4/8/12/16/20/24/32/48px × density.
- **Radius: 0** throughout (square corners are intentional; do not add radius).
- Motion: `--ease: cubic-bezier(.4,0,.2,1)`; `--dur-fast:.15s`; `--dur-base:.22s`.
  Respects `prefers-reduced-motion`. Keyframes: fade, scrim, slide, spin, shimmer, toast.
- Shadows: toast `0 8px 26px rgba(20,30,50,.16)`, dialog `0 12px 34px rgba(20,30,50,.18)`, side drawer `-16px 0 40px rgba(20,30,50,.18)`.

### Responsive ladder
Mobile-first. Sidebar becomes a fixed drawer below **920px** (hamburger in top
bar); ≥920px it is a sticky 280px rail. Grids collapse to single column on phones
(`ns-grid2/3`, `ns-formgrid`, `ns-panes2`, `ns-xfer` breakpoints in the shell
`<style>`). The person×date matrix scrolls horizontally with sticky first column +
header. Icons: Font Awesome 6.5.2.

## Screens / views
All are mounted by the shell (`Nurse Scheduling.dc.html`) based on `state.screen`.
Nav is grouped **Home · Set up · (Constraints, Advanced only) · Output · System ·
Appendix**. The **Guided/Advanced mode toggle** reshapes nav: Guided hides the raw
Constraints editors and surfaces them through the Rules layer.

| File | Screen | Purpose | Notes for implementation |
|---|---|---|---|
| `Nurse Scheduling.dc.html` | **App shell** | Store, routing, top bar, mobile drawer, toast, global delete-confirm modal, mode toggle, theme, New-schedule reset | The single store + all mutation handlers live here. Props: `density`, `accent`, `appearance` (tweakable). |
| `ScreenHome.dc.html` | **Home** | Entry, mode toggle, guided setup wizard with per-step summaries, ward stats | First-run/empty states derive from store counts. |
| `ScreenDates.dc.html` | **Dates & Calendar** | Roster range, **ID-format-by-span** (DD / MM-DD / YYYY-MM-DD), SG public-holiday import (English), date-group CRUD + auto-derived read-only groups | Calendar renders one grid per spanned month; date-group day-picker; WORKDAY/NON-WORKDAY/PH are import-created & editable. |
| `ScreenStaff.dc.html` | **Staff (People)** | CRUD, seniority, staff-group membership, reorder, duplicate, **bulk upload**, reserved-keyword rejection (`ALL`) | Delete routes through the shell's cascade-preview confirm. |
| `ScreenShifts.dc.html` | **Shift Types** | CRUD on a strict **30-min grid**, overnight (+1 day), rest→working-time derivation, `durationMinutes` transport, reserved OFF/LEAVE (auto), shift groups | A shift's "minimum nurses" is the Required value of its baseline requirement card — one shared object, two views. |
| `ScreenRules.dc.html` | **Rules (Guided)** | Plain-English categorized rules that are **lossless projections** of the Advanced constraint records; pin any constraint; inline "Adjust" numbers; advanced-only fields shown read-only | Toggling/editing here writes the same records Advanced edits. Built-in structural rules are locked. |
| `ScreenRequests.dc.html` | **Requests & Leave** | The person×date **matrix** (the densest surface): quick-paint drag, per-cell weights, **paid-leave hard pin**, off-requests, people-group rows, date-group columns, **history (H-n) columns**, CSV upload (requests + history), derived summaries | Mobile strategy today = horizontal scroll + sticky column; consider a focused-row view when porting to phone. |
| `ScreenCards.dc.html` | **Card editors (Advanced)** | Renders all five editors by `kind`: Requirements, Successions, Counts, Affinities, **Coverings** + guided **Contracted Hours**. Per-editor validation, weight semantics, coefficients, transfer-list multi-selects | Coverings = 4 multi-selects (OFF/LEAVE excluded), hard rule (weight hidden). Contracted Hours = Add-Contracted-Hours action, Exact/Allowed-range half-hours, Refresh-from-Shift-Types preview, Solver details (locked expr/weight + convert-to-generic), uncredited-leave guard, coefficient coverage. |
| `ScreenExport.dc.html` | **Export Layout** | Style rules, extra columns/rows, coefficients, default generated layout | Shapes the XLSX; edits are list rows. |
| `ScreenGenerate.dc.html` | **Optimize & Export** | Read-only backend/version status, run settings (timeout, anonymize, prettify), full job lifecycle (idle→running→optimal/feasible/infeasible/cancelled), live incumbent score, progress chart (range presets + comments overlay), event log, cancel / finish-now, download + download-again, version-mismatch note | A "demo outcome" segmented control simulates results — replace with real SSE + `/optimize` wiring. `failed` state and no-incumbent finish-now are stubbed. |
| `ScreenSchedule.dc.html` | **Roster viewer** ⚠ EXPLORATORY | In-app roster grid/day/coverage views with tap-to-edit + drag-swap + warnings | **Flagged non-parity:** the backend has no roster-data endpoint (only the XLSX blob + score/status). All data here is fabricated. Treat as a NEW capability needing a new backend contract — see the note at the top of the file. |
| `ScreenSaveLoad.dc.html` | **Save / Load & YAML** | Download/upload/copy/edit scenario YAML, import warnings, **anonymize panel**, app-version-mismatch confirm, New-schedule reset | Full-state replace on load. |
| `ScreenAppendixAI.dc.html` | **AI Assistant** ⚠ OPTIONAL | Out-of-scope exploratory appendix (LLM config + conflict-fix proposals) | Spec §10 marks AI assist **out of scope / not a delivered screen**. Kept separate under Appendix; do not wire into committed flows without a feasibility call. |
| `SideNav.dc.html` | Sidebar nav | Grouped navigation, mode toggle, theme toggle | Shared. |
| `InfoTip.dc.html` | Info tooltip | Inline term explanations | Shared, imported by several screens. |
| `support.js` | Prototype runtime | Renders the `.dc.html` components | **Do not port** — prototype infrastructure only. |

## Interactions & behavior
- **Guided ↔ Advanced** is a lens change, never a data mutation. Switching modes
  or editing in Guided must not default, flatten, or drop Advanced-only detail
  (signed/infinite weights, coefficients, ordered patterns, groups, nested
  references). Any Advanced construct Guided can't render natively shows a
  read-only fallback ("Set in Advanced only").
- **Weights**: soft rules take a signed weight (±∞ = hard); hard rules (Coverings,
  Contracted Hours, LEAVE pins) hide/ignore the weight field. Never show an
  editable weight the solver ignores.
- **Reference cascade**: rename rewrites in place everywhere; delete opens an
  impact-preview modal listing every affected rule/group/request/cell, then
  cascades and prunes empty preferences.
- **Contracted Hours**: half-hour integer storage (friendly-hours display), Exact
  or inclusive Allowed-range, `ALL` = worked types only, every expanded concrete
  type needs one explicit positive-integer coefficient, LEAVE defaults to 16
  half-hours (editable). Membership/working-time changes never silently repair —
  they require an explicit previewed **Refresh from Shift Types**.
- **Optimize lifecycle**: queued → running (streaming score + chart) → optimal /
  feasible / infeasible / cancelled / failed; cancel/finish-now before any
  incumbent may end with **no download**. Backend URL comes from deployment config;
  UI shows only read-only online/offline + version status.
- **Toasts** auto-dismiss ~3.6s; modals close on scrim click; drawer has a scrim.

## State management to build (spec §07)
Single store + **first-class undo/redo** (prototype only stubs undo on the roster
editor — implement app-wide), **localStorage persistence** so work survives
refresh, and a **dirty / unsaved-edits guard** before navigation loss. These three
are intentionally left as stubs in the prototype and are the primary
implementation wiring for §07. Keyboard shortcuts and scroll-restore are
"worth having" (mappings are incidental).

## Assets
- **Fonts**: Google Fonts — Figtree, Hanken Grotesk, Spline Sans Mono.
- **Icons**: Font Awesome 6.5.2 (CDN in the prototype; swap for your icon system).
- No raster/image assets or brand logos are required.
- The old-app reference screenshots (`screenshots/` in the project) and the spec
  corpus are reference material, not part of the UI.

## Files in this bundle
All `.dc.html` design references listed in the table above, plus `support.js`
(prototype runtime — reference only, do not port). Open `Nurse Scheduling.dc.html`
in a browser to run the full prototype.
