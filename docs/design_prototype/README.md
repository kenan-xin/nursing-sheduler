# Handoff: Nurse Scheduling — v2 "Mint Canvas, Warm Ink" redesign

## Overview

Rota is a **local-first** nurse rostering tool for a hospital unit: set up dates, staff, shift types, rules and leave requests, run an optimiser, then review/adjust and export the roster. There is **no backend database and no authentication yet** — everything lives on the device, and nothing in the UI may assume a signed-in user, an organisation, or a named ward.

v2 is a **visual redesign only**. Information architecture, screens, flows, data model and interaction logic are unchanged from v1. What changes is the visual system: a cool mint canvas under warm espresso ink, a real surface/elevation ladder, rounded geometry, and the removal of placeholder identity chrome.

The direction was arrived at in two passes, both included under `direction/`: first a look exploration (v2 started from "1a Warm Clinical" — warm paper *and* warm ink), then a palette pass after that read too heavy, landing on **2a "Mint, Warm Ink"** — the canvas cooled to mint while the ink stayed warm.

Reason for the redesign: the users are nurses in a healthcare setting; v1 read cold and utilitarian (near-black type, 90° corners, hairline grid everywhere).

## About the design files

The files in this bundle are **design references written in HTML** — running prototypes that show intended look and behavior. They are **not production code to copy**. The task is to **recreate these designs in the target codebase's environment** (React/Vue/Svelte/native) using its established patterns, component library and state management. If no app environment exists yet, pick the framework appropriate for a local-first single-page app (e.g. React + Vite, persistence in IndexedDB/localStorage) and implement the designs there.

The prototypes are authored in a component runtime (`support.js` + `*.dc.html`) that exists only in the design tool. Ignore that runtime; read the markup and inline styles as the spec.

## Fidelity

**High fidelity.** Colors, type, spacing, radii and states are final and should be matched. Content is realistic demo data (nurse names, February 2026 roster) — replace with real data sources.

## What's in this bundle

```
design_handoff_nurse_scheduling_v2/
├─ README.md                      ← this document
├─ standalone/
│  └─ nurse-scheduling-v2-standalone.html   ← single self-contained file, open in any browser, no server
├─ source/                        ← non-standalone design source (open "Nurse Scheduling v2.dc.html")
│  ├─ Nurse Scheduling v2.dc.html ← app shell: design tokens, top bar, routing, all app state
│  ├─ SideNav.dc.html             ← sidebar (rebuilt for v2)
│  ├─ ScreenHome.dc.html          ← guided/advanced landing
│  ├─ ScreenDates.dc.html         ← step 1 · date range, holidays, date groups
│  ├─ ScreenStaff.dc.html         ← step 2 · nurses, seniority, staff groups
│  ├─ ScreenShifts.dc.html        ← step 3 · shift types, times, minimum staffing
│  ├─ ScreenRules.dc.html         ← step 4 · plain-English rule library
│  ├─ ScreenRequests.dc.html      ← step 5 · person × date requests/leave matrix
│  ├─ ScreenGenerate.dc.html      ← optimiser run, progress, incumbent score
│  ├─ ScreenSchedule.dc.html      ← roster grid / coverage / day views + manual adjust
│  ├─ ScreenCards.dc.html         ← advanced constraint editors (requirements, successions, counts, affinities, coverings)
│  ├─ ScreenExport.dc.html        ← spreadsheet export configuration
│  ├─ ScreenSaveLoad.dc.html      ← local save/load/new scenario
│  ├─ ScreenAppendixAI.dc.html    ← optional LLM assist appendix
│  ├─ InfoTip.dc.html             ← inline glossary tooltip
│  └─ support.js                  ← design-tool runtime (NOT for production)
└─ direction/
   ├─ Design Directions.dc.html   ← the three original directions; v2 started from "1a Warm Clinical"
   └─ Palette Directions.dc.html  ← the palette explorations that followed; v2 ships option **2a "Mint, Warm Ink"**
```

Open `standalone/nurse-scheduling-v2-standalone.html` first — it is the fastest way to click the whole app.

## Design intent (read before styling anything)

The direction is **mint canvas, warm ink** in service of a *warm clinical* tone — and both halves of that tone are load-bearing:

- **Warm**, because the users are nurses on shift, mostly women, using this at the start and end of long days: warm espresso ink, soft rounded controls, generous touch targets. The warmth lives in the **type and hairlines**, not the canvas — a cool mint page keeps the app feeling clean and awake, while warm ink stops it reading clinical-cold. (A fully warm-on-warm scheme was tried first and read as dinge under ward lighting.)
- **Clinical**, because this is a rostering instrument, not a wellness app: dense data stays dense, the roster grid stays a crisp grid, numbers are monospaced and aligned, and nothing decorative is added to a data surface.

Two guardrails that follow from that, and that were applied during a de-slop pass:

1. **No decorative ornament in labels or status.** Status reads `DONE` / `CURRENT` / `TO DO` as text — no check glyphs, no coloured leader dots on eyebrows. Colour and weight carry state.
2. **Rounding is warmth, not a theme.** Cards, controls and buttons round; **tables, table cells, the roster grid and its chips do not become soft blobs** — chips are 9px, grid cells are square. Do not round data structure away.

Copy is instructional and short. Avoid promotional phrasing ("build a fair roster that respects every rule" was cut as filler); say what the step does and what happens next.

## Design tokens

Defined once on the app root in `Nurse Scheduling v2.dc.html` (`:root` in the `<style>` block) and consumed everywhere as CSS variables. Reproduce them as your platform's token layer.

### Surface & elevation system

The single most important rule in v2: **every surface belongs to a named level, and level is expressed by tone first, shadow second.** v2.0 shipped with `--bg` and `--panel` only 1–2 values apart, which made insets invisible and the whole app read flat; the ramp below is deliberately stepped so each level is legible without a heavy shadow.

| Level | Token | Shadow | What lives here |
|---|---|---|---|
| L0 · page | `--bg` | none | the app background; nothing floats free on it |
| sidebar | `--sidebar` | hairline right edge | the nav plane |
| L1 · surface | `--surface` | `--sh-1` | cards, table containers, the sticky top bar, secondary/ghost buttons |
| L1 selected | `--surface` + `--brand` border | `--sh-2` | the current wizard step, an active editor card |
| L2 · raised | `--surface2` | `--sh-3` | dialogs, drawer, popovers, toast |
| well · inset | `--panel` | `inset 0 1px 2px rgba(60,55,45,.05)` | summary chips, table header bands, note strips *inside* an L1 card |

Shadow ladder (warm, brown-tinted — never neutral grey/black in light mode):

- `--sh-1: 0 1px 2px rgba(60,55,45,.05), 0 2px 8px rgba(60,55,45,.05)` — resting L1
- `--sh-2: 0 2px 4px rgba(60,55,45,.06), 0 10px 24px rgba(60,55,45,.09)` — hover / selected / lifted
- `--sh-3: 0 20px 50px rgba(60,55,45,.22)` — modal layer (also `--shadow-dialog`, `--shadow-toast`)

Rules that follow from this:

1. **A well never has an outer shadow, and a raised surface never has an inset one.** Direction of light is fixed.
2. **Full-bleed bands are square and flat.** A div-based table's header band and its zebra rows span the whole card, so they never take a chip radius or a well shadow — only inset *islands* (chips, summary pills, note strips) do. Zebra striping uses `--panel-alt`, not the well tone `--panel`, which is reserved for header bands and true insets.
3. **A scroll region that ends a card takes the card's bottom radius and clips to it.** Without that, rows run into a hard square edge inside a rounded card and the list looks truncated rather than scrollable.
4. **Secondary and ghost buttons are L1, not transparent.** A transparent outlined button on the recessed page doesn't read as pressable — give it `--surface`, a `--line` hairline, and `--sh-1`; hover goes to `--panel-alt` + `--sh-2`; active drops the shadow entirely. Filled primary buttons take `--sh-1` and also flatten on `:active`.
5. **Never stack two levels of the same tone.** An L1 card inside an L1 card becomes a well instead.
6. **Dark mode inverts the direction, not the ladder**: wells go *darker* than their surface (`--panel #1a1718` under `--surface #201c1d`), raised surfaces go lighter (`--surface2 #282324`), and shadows switch to black at higher alpha (`--sh-1` .34/.24 → `--sh-3` .55).
7. **Nothing inherits the UA default black.** `button` does not inherit `color` by default; the shell sets `button { color: inherit }`. Any control that renders `rgb(0,0,0)` is a bug — the whole point of v2's ink ramp is that no true black appears.

### Color — light (default)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#332e2b` | headings, primary text (warm espresso — never pure black) |
| `--ink2` | `#57504b` | body copy, secondary text |
| `--ink3` | `#665d57` | labels, meta, captions (dark enough for 10–12px text on any tint) |
| `--faint` | `#9d938c` | disabled, empty-cell marks |
| `--on-ink` | `#fbf9f7` | text on dark fills |
| `--bg` | `#f3f6f4` | **L0** page — the recessed plane everything sits on (cool mint) |
| `--surface` | `#fcfefd` | **L1** cards, tables, bars, secondary buttons |
| `--surface2` | `#ffffff` | **L2** raised — dialogs, drawers, popovers |
| `--panel` | `#eef3f0` | **well** — inset plane *inside* an L1 surface (chips, table header bands, summary rows) |
| `--panel-alt` | `#f9fbfa` | subtle band inside a surface (zebra rows, hover fill) |
| `--line` | `#e0e3da` | primary borders (warm-tinted, to sit with the ink not the canvas) |
| `--line2` | `#ecefe9` | inner dividers |
| `--rule` | `#d1cec5` | emphasis rules |
| `--sidebar` | `#f7faf8` | sidebar plane (its own step between L0 and L1, with a hairline right edge) |
| `--chrome` | `#0b7d68` | app mark tile |
| `--brand` | `#0b7d68` | primary teal (fills, active states) |
| `--brandink` | `#0a6e5c` | brand text/icon on light |
| `--brandtint` | `#e2f3ee` | brand-tinted backgrounds |
| `--onbrand` | `#ffffff` | text on brand |
| `--success` / `--successtint` | `#1f6b52` / `#e2f1ea` | done, feasible |
| `--warn` / `--warntint` | `#8c5f1c` / `#f8efdd` | holidays, soft warnings |
| `--error` / `--errortint` | `#bd4a28` / `#fae7df` | conflicts, understaffed, destructive |

**Semantic colour has three tiers, and picking the wrong one is the most common contrast bug in this app.** A semantic colour is almost always used as *text on its own pale tint*, so the base tier is already dark enough for that (the earlier `#1f7f60` success at 4.2:1 and `#a4711f` warn at 3.7:1 both failed):

| Tier | Tokens | Use |
|---|---|---|
| base | `--success` `--warn` `--error` | text or icon **on its own tint**; hairline borders |
| ink | `--successink #1f6b52` `--warnink #8c5f1c` `--errorink #9e3d1c` | the deepest treatment — headings, emphasised numerals |
| solid fill | `--fill-error` + `--on-error`, `--fill-warn` + `--on-warn` | filled badges and destructive buttons |

Solid fills carry their own ON-color because the pairing flips per theme: in light mode `--warn` is only 3.7:1 with white, so `--fill-warn` resolves to the darker `--warnink`; in dark mode the tints become light pastels, so both fills take `--on-ink` instead of white. Never hardcode white on a semantic fill.

### Color — dark (mint-dark canvas, warm ink — not an inversion)

`--ink #f0ece7` · `--ink2 #b3aca6` · `--ink3 #a09892` · `--faint #6a635e` · `--on-ink #1d1a18` · `--bg #111816` · `--surface #1a2220` · `--surface2 #222b28` · `--panel #151d1b` (darker than its surface — wells recede) · `--panel-alt #1f2826` · `--line #2f3936` · `--line2 #27302e` · `--rule #404b47` · `--sidebar #141b19` · `--brand #12a389` · `--brandink #6ed6c1` · `--brandtint #16352f` · `--success #63c79e` / tint `#1a3129` · `--warn #d9a85c` / tint `#33280f` · `--error #e58164` / tint `#38201a` · `--successink #7fd7b2` · `--warnink #e8bd7c` · `--errorink #f09b80`.

Applied via `data-theme="dark"` on the app root. The dark canvas is a desaturated mint-black, and the ink ramp stays warm, exactly as in light mode. Roster shift chips keep their pale fills in dark mode on purpose — they are data marks and must stay legible and comparable across themes.

### Shift colour palette

Worked shifts are coloured by **start time**, assigned from a fixed 8-entry ramp so mornings read warm and nights read cool. The one hard constraint: **adjacent entries must differ in hue, not just lightness.** v2.0 opened with two near-identical sands (`#fbeed6`, `#f7f0d9`) followed by two greens, which made AM/PM/LD unreadable at chip size.

| Order | Fill | Ink | Bar | Reads as |
|---|---|---|---|---|
| 1 | `#f8e2b8` | `#7a5310` | `#d4a038` | morning — amber |
| 2 | `#f6dbcd` | `#9a4726` | `#cf7049` | afternoon/evening — clay |
| 3 | `#e4ecd0` | `#586a22` | `#8fa243` | long day — olive |
| 4 | `#d8e0f2` | `#374777` | `#6274ad` | night — cool slate |
| 5 | `#e9dbf0` | `#653f8e` | `#9670bd` | plum |
| 6 | `#d3e9e3` | `#1b6a5d` | `#3d9587` | teal |
| 7 | `#f7dae2` | `#9a3153` | `#c66184` | rose |
| 8 | `#2b2733` | `#ece6f2` | `#5c5468` | dark (overflow) |

`fill`+`ink` are the chip; `bar` is the legend dot and day-view tag. These are literal hexes, not theme tokens, and stay the same in dark mode — they are data marks and must remain comparable across themes. Reserved, never from this ramp: leave (`--panel`) and rest (`--faint` dot).

### Accent options (user-selectable, optional to ship)

teal `#0b7d68` (default) · sage `#3f7f6b` · rose `#b0605a` · plum `#6b5f8c`. The accent overrides `--brand`; `--brandink` = `color-mix(accent 82%, black)` (light) / `color-mix(accent 60%, white)` (dark); `--brandtint` = `color-mix(accent 10%, --surface)` (light) / `color-mix(accent 26%, --surface)` (dark) — the tint mixes against the current surface, so it must be retracked whenever the surface ladder changes.

### Radius

| Token | Value | Applied to |
|---|---|---|
| `--r-card` | `16px` | cards, panels, table containers, dialogs |
| `--r-ctl` | `12px` | inputs, selects, textareas, inner bordered boxes |
| `--r-chip` | `9px` | badges, tinted chips, roster shift chips |
| `--r-pill` | `999px` | buttons, nav items, segmented controls, status pills |

Avatars are `50%`.

Stay square: `table, thead, tbody, tr, th, td`, the coverage grid cells, the small legend swatches (2–3px), and **every full-bleed bar or edge** — the sticky top bar, sticky sub-toolbars, and any container whose border is a single edge (`border-bottom`, `border-top`) rather than a box. A rounded corner on a full-width bar leaves a visible sliver of page background in the corner; bars butt flush to their container.

### Typography

- Display/headings: **Figtree** 700 (v1 used 800 — v2 is one step lighter), `letter-spacing:-.015em`.
- UI/body: **Hanken Grotesk** 400/500/600/700.
- Numeric/code: **Spline Sans Mono** 400–700 (roster day numbers, IDs, counts, hours, solver expressions).
- Fluid scale driven by `--base-h` (heading root), `--base-b` (body root), `--base-l` (label root) with breakpoint steps at 480/768/1024/1280/1440/1920px. At 1280px: `--base-h:32px`, `--base-b:17px`, `--base-l:13px`.
- Two fixed steps sit below the fluid scale for dense data: `--t-micro` (11px) and `--t-nano` (10px), both still multiplied by `--dens`.
- Derived: `--t-display`/`--t-h2` = `--base-h`; `--t-cardhead` = `.78×`; `--t-h3`/`--t-title` = `.60×`; `--t-body` = `--base-b`; `--t-sm`/`--t-xs` = `.92× --base-b`; label sizes `--m-xs`/`--m-sm` = `--base-l`, `--m-md` = `1.13×`, `--m-lg` = `1.27×`.
- Body line-height 1.5; card paragraphs 1.45–1.5; headings 1.05–1.15. Prose columns cap at 60–68ch.

### Spacing

4px base scale, multiplied by a density factor: `--space-1:4 · -2:8 · -3:12 · -4:16 · -5:20 · -6:24 · -8:32 · -12:48` (× `--sp`). Density presets: Compact `--sp .8 / --dens .9`, Comfortable `1 / 1`, Spacious `1.16 / 1.07` (`--dens` scales type).

### Elevation & motion

- Elevation uses five tokens and nothing else: the `--sh-1 / --sh-2 / --sh-3` ladder above, plus `--sh-edge` (`6px 0 8px -6px`) for the sticky-column scroll edge and `--sh-well` (`inset 0 1px 2px`) for inset planes. `--shadow-toast` and `--shadow-dialog` alias `--sh-3`; `--shadow-side` is the drawer's directional variant. Every one of them re-tints per theme — dark mode swaps the warm browns for black at higher alpha.
- Easing `cubic-bezier(.4,0,.2,1)`; durations `150ms` (fast) / `220ms` (base). Buttons transition `box-shadow` and `background` on the fast duration.
- Keyframes: fade-up 6px, scrim fade, drawer slide-in from 100%, spinner, skeleton shimmer (opacity .45→.9, 1.1s), toast rise 14px. All animation collapses to `.01ms` under `prefers-reduced-motion`.

## Layout

- **Shell**: sticky full-height sidebar + fluid main column. Below `920px` the sidebar becomes an overlay drawer (`250px`, max `84vw`) behind a `rgba(8,10,14,.5)` scrim, opened by a hamburger in the top bar.
- **Collapsible sidebar** (desktop, `≥920px`): the sidebar toggles between an expanded `244px` panel and a `60px` icon rail, animated on `width` over `--dur-base`. The control is a `36px` outlined icon button at the far left of the top bar (`fa-angles-left` / `fa-angles-right`), and the state persists in `localStorage` under `ns-side-collapsed`. Collapsed rail rules: `10px` gutters, brand mark only (title attribute carries the product name), nav items become `40×38` centred icon buttons with `--brandtint` for the active one, every item gets a `title` (`"Dates · step 1"`) plus an `aria-label`, group headings become `1px` `--line2` separators, the Guided/Advanced segmented control collapses to one `GUI`/`ADV` pill that toggles the mode, and the footer keeps only the theme toggle. The mobile drawer always renders expanded regardless of the collapsed state. Nav items carry `aria-current="page"` when active.
- **Top bar**: sticky, `56px`, `--surface` background, bottom `1px solid --line`, **square corners** (a full-bleed bar never rounds — rounding it exposes the warm page background in the corners). Left: `26px` rounded teal app mark + breadcrumb (uppercase, `--ink2`). Right: "Saved on this device" pill (`--panel`, laptop icon, hidden under 768px) + circular theme toggle. **No user avatar, no ward/org label** — neither exists yet.
- **Content**: `max-width:1240px`, centred, padding `--space-6 --space-5 72px`.
- **Page header pattern** (every screen): a two-column flex row, `align-items:flex-end`, `gap:--space-4`. Text column is `flex:1 1 440px; min-width:min(100%,440px)` so the prose keeps a readable measure and the action group wraps *below* instead of crushing the paragraph into a narrow ribbon. Action group is `display:flex;gap:10px;flex-wrap:wrap`. **Do not** give the text column a small `min-width` — that was the v2.0 bug.
- Recurring responsive grids: 2-up at ≥900px, 3-up at ≥1100px, wizard cards 2-up at ≥760px / 3-up at ≥1200px, transfer lists stack under 620px, two-column forms stack under 720px.

## Screens

Every screen keeps its v1 structure, content and behavior. Below is what each does plus its v2 visual treatment.

1. **Home** — guided wizard landing. Eyebrow "ROSTER SETUP" in `--brandink`, `--t-display` heading "Build the February Roster", primary pill "Generate roster". **Stat strip**: five stats in a `gap:1px` grid over a `--line2` background — the gap *is* the divider, so hairlines stay correct in every wrap configuration. Columns step 2-up → 3-up (≥560px) → 5-up (≥900px); never `auto-fit`/`flex-wrap`, both of which stranded the fifth stat alone on a full-width second row. Progress row: label + 4px `--line2` track with teal fill. Six step cards: `--r-card` white cards; current step gets a `--brand` border; each card has a `34px` rounded ink tile with the step number, a `34px` `--panel` icon tile, a text status badge (`DONE` success tint / `CURRENT` brand tint / `TO DO` panel), title, 2-line description, a summary chip, and a pill CTA (Review / Continue / Set up). Advanced mode replaces the cards with a 3-up grid of direct-jump tiles under a warn-tinted note.
2. **Dates (step 1)** — range start/end, month calendar with holiday marking, holiday import toggle, user-defined date groups. Rounded inputs, pill toggles, calendar day cells `--r-chip`.
3. **Staff (step 2)** — "Your Nursing Staff". "Add nurse" pill (teal) + "Upload list" secondary pill + rounded search field; table of nurses with `30px` square initials tiles (`--panel` fill, `--line2` hairline — square, unlike the roster grid's `26px` circular avatars), group chips (`--panel`, `--r-chip`), circular icon actions (edit / duplicate / delete — delete in `--error`). Staff-group transfer list below. The auto "everyone" group is described without ward language.
4. **Shifts (step 3)** — shift rows with a `42px` rounded tile per shift (night keeps a dark ink tile as a semantic cue), start/end selects, rest hours, minimum and preferred staffing, drag-to-reorder, shift groups.
5. **Rules (step 4)** — plain-English rule list with `38×22` pill switches (teal on, `--line` off, white knob), linked/built-in badges, an "N of N rules on" counter chip, and a "Customise library" pill that opens the pin flow. Intro copy is two sentences, not a paragraph.
6. **Requests & Leave (step 5)** — person × date matrix with two modes (Normal / Quick paint) in a pill segmented control; cells show leave/off/preference marks; weight inputs; paint-target chips.
7. **Generate** — run settings summary, "Ready to optimise" empty state, live progress with incumbent score chart, event log, range presets (teal when active), result banner (OPTIMAL success / FEASIBLE warn / INFEASIBLE error tints with matching border).
8. **Roster (Review & Adjust)** — three views in a pill segmented control (Grid / Coverage / Day), undo circle, "Export" pill. Legend chips per shift type. **Grid**: `--r-card` container, `overflow:auto`, `max-height:66vh`; the container is the scroller, so sticky offsets resolve against it rather than the page.

  *Sticky layering* — the grid has three sticky planes and their z-order is load-bearing: day/summary headers `z:3`, the body's first column `z:2`, the top-left corner cell `z:5`. Getting this wrong (v2.0 had headers at `z:1`, below the first column) makes nurse names paint over the date row while scrolling. Both sticky edges carry a directional shadow — `box-shadow: 6px 0 8px -6px rgba(60,55,45,.16)` on the first column, slightly stronger on the corner — so content visibly passes *under* them instead of colliding. The header bottom rule is `2px solid --line` on **every** header cell including the corner; mismatched weights leave a visible step.

  *Chips* — one builder, one box: `34×28`, `--r-chip`, **no border**. Worked shifts take their palette `fill`/`ink`; leave is a neutral `--panel`/`--ink3` chip; rest is a bare `·` in `--ink3` at the same box size so columns never jitter. Two rules learned the hard way: (a) leave must **not** use `--brandtint` + a `--brand` border — that is the selection language, and the two states became indistinguishable; (b) don't put a `1px solid transparent` border on every chip to accommodate one dark variant — it made the dark chip a pixel larger than its neighbours. States are inset shadows instead: dark chips get `inset 0 0 0 1px bar`, rest-violation cells `inset 0 0 0 1.5px --warn`, selection an `outline: 2px --brand; outline-offset:-2px` on the cell.

  *Column backgrounds* — weekend columns `--panel`, ordinary columns `transparent` (they inherit the container so the row-hover fill reads through), holidays a 135° `--warntint`/`--surface` stripe, week boundaries a `1px --line` left edge every 7th column. Rows hover to `--panel-alt` (a click-to-edit grid with no hover state reads as static). Cell padding is `4px`, giving ~36px rows.

  *Right summary block* — per-nurse counts per shift type plus Off and Weekend-off, separated from the calendar by a `2px --line` edge; a nurse with zero weekend rest flags `--error` on `--errortint`. Footer rows count staffing per shift per day, shortfalls on `--errortint`. All semantic colour comes from tokens — no hardcoded `rgba(200,40,40,.08)` or `#f0c0b8`, which is what v2.0 shipped.

  *Interaction* — tap a cell to open the inline shift picker bar; drag one nurse's cell onto another to swap.

  **Coverage**: per-shift lanes × days on a `212px + repeat(n, 128px)` grid. The lane label holds the shift name plus a meta line (`07:00 – 15:00 · min 4`); split that meta into **two `nowrap` spans in a flex row**, never one wrapping string — at the original `184px` track the count broke onto its own line on every lane. Each cell shows `staffed/required` plus initials chips; understaffed cells take `--errortint` with an `--error` border. Below `760px` coverage restacks by day so there is no horizontal scroll. **Day**: day strip (active day = teal pill) plus per-shift assignment cards.
9. **Advanced constraint editors** (requirements, successions, counts, affinities, coverings) — shared card-list + detail-editor pattern: rounded list rows, chip pickers for staff/shift/date scopes (teal when selected), coefficient sub-editors, exact/range policy segmented control, monospaced solver expressions.
10. **Export** — section list (style / columns / rows), rule chips, colour swatches, and a live spreadsheet preview table with the roster cell styling. Preview banner reads "HISTORY & SCHEDULE · FEB 2026" (no ward name).
11. **Save / Load** — local scenario list with pill switches for what to include, "New schedule" destructive confirm, YAML preview described as a plain roster scenario.
12. **Appendix · AI assist (optional)** — provider segmented control (OpenAI / Anthropic / OpenRouter), model + key fields, test connection, chat panel that proposes fixes for infeasible rosters and applies them.

Global overlays: **toast** (bottom centre, `--ink` fill, `--on-ink` text, a leading ✓ mark, `--shadow-toast`, click to dismiss, `role="status"`) and **confirm dialog** (white `--r-card` card, `--errortint` warning tile, "Cancel" outline pill + destructive `--error` pill).

## Interactions & behavior

- Sidebar: Guided/Advanced pill segmented control switches the nav set and Home layout; nav items are pills, active = `--brandtint` fill + `--brandink` text + `--brandink` icon; hover = `--panel`. Group labels are sentence case ("Set up", "Output", "System", "Appendix · optional"). Footer shows "Local draft · autosaved" and the theme toggle.
- All buttons are pills; hover = `filter:brightness(.94)` on filled, `--panel` fill on ghost/outline; focus-visible = `2px --brand` outline, `-1px` offset.
- Wizard steps are non-linear: any step is reachable at any time; status (done/current/todo) is derived from data completeness, not from a forced sequence.
- Roster editing: tap cell → picker bar; pick shift → mutate + push to undo stack; drag/drop swap; undo restores the previous snapshot; each mutation shows a toast.
- Optimiser: idle → running (progress + score stream) → feasible/optimal/infeasible; skeleton shimmer rows while a roster loads.
- Destructive actions (delete rule/staff/shift, new schedule) always confirm and list downstream rule updates.
- Theme toggle is instant (`data-theme` swap), no colour transition.

## State

Single root store (in the prototype: the shell's component state) holding: `theme`, `mode` (guided/advanced), `navOpen`, `screen`, `wizardStep`, `rangeStart`/`rangeEnd`/`calMonth`/`importHolidays`, `dateGroups`, `staff` + `staffGroups` (+ edit drafts), `shifts` + `shiftGroups` (+ drafts), `rules`, `requests` matrix, advanced constraint records by kind, `runState`/`progress`, `schedule`, `selectedCell`, `undoStack`, `scheduleView`, `scheduleLoading`, export sections, LLM settings, `toast`, `confirmDelete`.

Because the app is local-first with no auth: persist this store to device storage (localStorage/IndexedDB) with explicit save/load scenarios (see Save/Load screen), and show the "Saved on this device" indicator. **Do not** introduce a signed-in user, avatar, org, or ward identity — none exists. When accounts/wards arrive, the top-bar right slot and the sidebar footer are the intended places for them.

## Assets

- Fonts: Google Fonts — Figtree, Hanken Grotesk, Spline Sans Mono.
- Icons: Font Awesome 6.5.2 free solid (`fa-heart-pulse`, `fa-calendar-days`, `fa-user-nurse`, `fa-layer-group`, `fa-list-check`, `fa-table-cells`, `fa-wand-magic-sparkles`, `fa-laptop`, `fa-rotate-left`, `fa-file-export`, `fa-triangle-exclamation`, …). Swap for the codebase's existing icon set — match weight and size, not the exact glyphs. No emoji anywhere.
- No images or illustrations. No brand assets.

## v1 → v2 diff summary

| | v1 | v2 |
|---|---|---|
| Ink | `#14161b` cold near-black | `#332e2b` warm espresso + lighter secondary ramp; no UA-default black anywhere |
| Background | `#fbfcfd` cool white | `#f3f6f4` recessed cool mint, with a stepped L0→L2 surface ladder |
| Elevation | flat, hairline borders only | tonal L0→L2 ladder + warm `--sh-1/2/3/edge/well` tokens; wells inset, raised surfaces lifted |
| Buttons | flat outlines | secondary/ghost sit on L1 with a hairline + `--sh-1`, hover lifts to `--sh-2`, active flattens |
| Primary | blue `#2360c4` | teal `#0b7d68` |
| Corners | 0 everywhere | 16 / 12 / 9 / pill (tables and grid stay square) |
| Borders | hairline `#c8cdd5` grid on everything | `#e0e3da` warm hairlines + tinted surfaces + the shadow ladder |
| Heading weight | Figtree 800 | Figtree 700 |
| Chrome | dark ink tiles, dark active segments | teal mark, teal active states |
| Identity | placeholder "Ward 7B · General Medicine" + fake user card | removed; "Saved on this device" + "Local draft · autosaved" |
| Status labels | `✓ DONE` / `● CURRENT`, dotted eyebrows | plain `DONE` / `CURRENT`, undotted eyebrows |
| Dark mode | cool blue-grey inversion | mint-dark canvas with the same warm ink ramp; wells recede, raised surfaces lift |

## Implementation notes

1. Build the token layer first (colors, radii, type scale, spacing, density factor), then the shell (sidebar + top bar + content column), then screens in wizard order.
2. **Do not reproduce the prototype's compatibility CSS.** Because v2 was retrofitted onto v1 markup, the shell contains a block of attribute-substring selectors (`[style*="border: 1px solid var(--line)"] { border-radius: … }`) that applies radii, shadows and button fills wholesale. Four traps if you ever touch it: match only the **box shorthand** (`border: 1px solid …`) so single-edge rules like `border-bottom` on the sticky top bar don't get rounded; those rules land at specificity (0,2,2) thanks to their `:not(th):not(td)` guards, so any override needs (0,3,x) — the shell uses a doubled `button[style][style]`; the DOM serializes inline styles **with a space after the colon** (`background: var(--surface)`, `border-radius: 50%`), so a guard written without the space silently matches nothing; and inline styles beat stylesheets, so changing an inline-declared fill needs `!important`. In production, skip all of this: put radii, elevation and button variants on components directly using the radius and shadow tokens. This layer is the single most fragile thing in these files.
3. **Build the surface ladder as real variants, not overrides.** Ship `Surface` (level: page | surface | raised | well) and `Button` (variant: primary | secondary | ghost | icon) components so elevation and pressability come from the component contract rather than from what a selector happened to match.
4. Keep the roster grid on a real `<table>` (or CSS grid) with sticky first column/header, and virtualise if the period can exceed ~31 days × ~40 nurses. Any scrolling code/data panel (the YAML preview, the roster container) needs `min-width:0` on **every flex ancestor** — a non-wrapping `<pre>` inside a default `min-width:auto` flex item pushes the whole page into horizontal scroll instead of scrolling itself.
5. Minimum hit target 44px on touch; roster cells are `30–34px` by design for density — pair them with the Day view for touch editing.
6. Accessibility: `role="tablist"`/`aria-pressed` on segmented controls, `role="status"` on toasts and skeletons, `title` on flagged roster cells, visible focus rings retained, and status never encoded by colour alone (the badges carry text).
7. Known follow-ups, not yet designed: an empty/first-run state for every screen (the prototype always has demo data), error states for a failed local save, and the account/ward chrome for when auth lands.
