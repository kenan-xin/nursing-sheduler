---
name: Nurse Scheduling
description: A warm-ink scheduling instrument on a cool mint canvas — rounded where the hand goes, square where the data is.
colors:
  ink: "#332e2b"
  ink-secondary: "#57504b"
  ink-tertiary: "#665d57"
  faint: "#9d938c"
  on-ink: "#fbf9f7"
  bg: "#f3f6f4"
  surface: "#fcfefd"
  surface-raised: "#ffffff"
  panel: "#eef3f0"
  panel-alt: "#f9fbfa"
  line: "#e0e3da"
  line-hairline: "#ecefe9"
  rule: "#d1cec5"
  sidebar: "#f7faf8"
  chrome: "#0b7d68"
  brand: "#0b7d68"
  brandink: "#096755"
  brandtint: "#e4f1ee"
  onbrand: "#ffffff"
  success: "#1f6b52"
  success-tint: "#e2f1ea"
  success-ink: "#1f6b52"
  warn: "#8c5f1c"
  warn-tint: "#f8efdd"
  warn-ink: "#8c5f1c"
  error: "#bd4a28"
  error-tint: "#fae7df"
  error-ink: "#9e3d1c"
  fill-error: "#bd4a28"
  on-error: "#ffffff"
  fill-warn: "#8c5f1c"
  on-warn: "#ffffff"
  scrim: "rgb(17 24 22 / 0.52)"
dark-colors:
  ink: "#f0ece7"
  ink-secondary: "#b3aca6"
  ink-tertiary: "#a09892"
  faint: "#6a635e"
  on-ink: "#1d1a18"
  bg: "#111816"
  surface: "#1a2220"
  surface-raised: "#222b28"
  panel: "#151d1b"
  panel-alt: "#1f2826"
  line: "#2f3936"
  line-hairline: "#27302e"
  rule: "#404b47"
  sidebar: "#141b19"
  onbrand: "#111816"
  success: "#63c79e"
  success-tint: "#1a3129"
  success-ink: "#7fd7b2"
  warn: "#d9a85c"
  warn-tint: "#33280f"
  warn-ink: "#e8bd7c"
  error: "#e58164"
  error-tint: "#38201a"
  error-ink: "#f09b80"
  fill-error: "#e58164"
  on-error: "#1d1a18"
  fill-warn: "#d9a85c"
  on-warn: "#1d1a18"
  scrim: "rgb(17 24 22 / 0.72)"
accents:
  teal: { light: "#0b7d68", dark: "#12a389" }
  sage: { light: "#3f7f6b", dark: "#72aa94" }
  rose: { light: "#af605a", dark: "#d1847e" }
  plum: { light: "#6b5f8c", dark: "#9e91c2" }
typography:
  display:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "26px-38px fluid base (480-1920px ladder), x0.9 baseline"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "0.78x display"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Figtree, system-ui, sans-serif"
    fontSize: "0.60x display"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "14px-16.2px fluid"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "10.8px-12.6px fluid"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.03em"
  mono:
    fontFamily: "Spline Sans Mono, ui-monospace, monospace"
    fontWeight: 400
rounded:
  card: "16px"
  control: "12px"
  chip: "9px"
  pill: "999px"
  avatar: "50%"
  none: "0px"
spacing:
  space-1: "3.6px"
  space-2: "7.2px"
  space-3: "10.8px"
  space-4: "14.4px"
  space-5: "18px"
  space-6: "21.6px"
  space-8: "28.8px"
  space-12: "43.2px"
elevation:
  sh-1: "0 1px 2px rgba(60,55,45,.05), 0 2px 8px rgba(60,55,45,.05)"
  sh-2: "0 2px 4px rgba(60,55,45,.06), 0 10px 24px rgba(60,55,45,.09)"
  sh-3: "0 20px 50px rgba(60,55,45,.22)"
  sh-edge: "6px 0 8px -6px rgba(60,55,45,.16)"
  sh-well: "inset 0 1px 2px rgba(60,55,45,.05)"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.onbrand}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    elevation: "{elevation.sh-1}"
    padding: "0 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    elevation: "{elevation.sh-1}"
    border: "1px solid {colors.line}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    elevation: "{elevation.sh-1}"
    padding: "0 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "{colors.fill-error}"
    textColor: "{colors.on-error}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    elevation: "{elevation.sh-1}"
    padding: "0 16px"
    height: "36px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    elevation: "{elevation.sh-1}"
    padding: "20px"
  well:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.chip}"
    elevation: "{elevation.sh-well}"
  badge-status:
    backgroundColor: "{colors.success-tint}"
    textColor: "{colors.success-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.chip}"
    padding: "2px 8px"
---

# Design System: Nurse Scheduling

> **Status: shipped.** This document describes the **v2 "Mint Canvas, Warm Ink"** system, adopted 2026-07-27 from `docs/design_prototype/` and now implemented across every shipped route in `web/`. Read it as a description of the running app, not only as a target: `web/app/globals.css` and this file agree. Should they ever drift, this document's visual rules are canon under the authority order below.

**Canonical reference:** `docs/design_prototype/` — open `standalone/nurse-scheduling-v2-standalone.html` to click the whole app, read `source/Screen*.dc.html` for per-screen markup, and `README.md` for the authored handoff. `direction/` holds the two exploration passes that produced this system.

**Authority order:** product contracts and ratified decisions → this document's visual rules → prototype examples. The prototype is authoritative for visual treatment and layout, not for product behaviour, architecture, data contracts, or feature priority. When an example conflicts with a ratified decision, the decision wins and the difference belongs in the deviation matrix below.

## 1. Overview

**Creative North Star: "Mint Canvas, Warm Ink"**

A rostering instrument for nurses on shift — used at the start and end of long days, by people doing an admin chore they did not ask for. Both halves of the name are load-bearing, and neither one wins:

- **Warm**, in the *ink and the hairlines*. Type is warm espresso (`#332e2b`), never pure black; borders are warm-tinted; shadows are brown, never neutral grey. Controls round, touch targets are generous. This is what stops the tool reading as cold clinical software.
- **Mint**, in the *canvas*. The page is a cool, recessed mint (`#f3f6f4`) that keeps the app awake and clean. A fully warm-on-warm scheme was built first and read as dinge under ward lighting — the canvas cooled, the ink stayed warm.

And **clinical**, because this is an instrument, not a wellness app: dense data stays dense, the roster grid stays a crisp grid, numbers are monospaced and aligned, and nothing decorative goes onto a data surface.

The single most important structural rule is the **surface ladder**: every surface belongs to a named level, and level is expressed by *tone first, shadow second* (see §4). The retired v1 system had page and card 1.03:1 apart, which made the hairline border carry 100% of the structure and made the whole app read as a wireframe. Tone now does that job.

This system explicitly rejects: the generic SaaS dashboard cliché (gradient hero metrics, glowing stat tiles, glassmorphism), cold clinical hospital software, the playful consumer app (mascots, bright primaries, everything-rounded), and the generic unstyled shadcn-default look every AI-generated app converges on.

**Key characteristics:**
- Warm espresso ink ramp on a cool mint canvas. **No true black anywhere** — a control rendering `rgb(0,0,0)` is a bug.
- A stepped L0 → L2 surface ladder with a warm shadow ramp. Tone carries separation; shadow confirms it.
- **Rounding is warmth, not a theme.** Cards `16px`, controls `12px`, chips `9px`, buttons and nav pills `999px` — but tables, roster cells and full-bleed bars stay square (see §5).
- Figtree 700 for display/headings, Hanken Grotesk for body/UI, Spline Sans Mono for codes, counts, hours and solver expressions.
- A fluid type scale stepping at six breakpoints (480/768/1024/1280/1440/1920px), baked at a fixed **0.9 density multiplier**. The v2 prototype respecifies a live Compact/Comfortable/Spacious knob; **we do not ship it** — the knob was removed as a product feature and 0.9 is the permanent baseline. Take v2's *ratios*, keep our multiplier.
- **Radius and shadow values are absolute px and are NOT multiplied by 0.9.** Only spacing and type ride the multiplier.
- Two independent, deliberately disjoint breakpoint ladders: a **type ladder** (the six steps above, plus the 920px nav pivot) and a **layout ladder** (600/720/760/900/1100/1200px, one per grid/form-layout class). A layout grid must use its own ladder step, never the nearest type-ladder value — conflating the two has previously shipped the wrong column count.

### Prototype deviation matrix

This is the complete known boundary for the v2 bundle. New mismatches must be added here before a fidelity pass treats them as regressions.

| Prototype or handoff behaviour | Product decision here | Re-skin treatment |
|---|---|---|
| Local-only, backend-less architecture; persist the whole store on device | Scenario drafts are local, but optimisation uses BFF routes, SSE, Redis workspace state, vendored Python CP-SAT, and server-side XLSX. | Visuals only; never port the sandbox architecture. |
| **Customise library**, guided-rule constraint pinning, shortcut metadata, and editable category assignment | Removed end-to-end. Rules shows every constraint, always; inline rename remains. Domain-level paid leave may still be a hard pin—that is unrelated. | Do not restore the action, modes, pin form, badges, stale-pin state, or workspace field. |
| Semantic categories such as Rest & recovery / Skill mix / Fairness / Preferences | Not derivable from arbitrary constraint cards. Guided Rules groups by constraint kind; semantic categories belong only to future guided templates with baked-in meaning. | Do not add the prototype taxonomy to existing Rules records or UI. |
| Live Compact / Comfortable / Spacious density selector | Removed. The product uses a permanent 0.9 multiplier for spacing and type; radius and shadow remain absolute. | Keep the fixed baseline and omit the control. |
| Collapsible desktop sidebar and `ns-side-collapsed` persistence | Separate, low-priority feature. | Excluded from the re-skin. |
| **Roster** route and grid | Planned but unbuilt (`cjr` / `f4-roster-viewer`). | The grid specification is future design input, not current re-skin scope. |
| **Export Layout** route | Separate, low-priority, user-gated feature (`qq0.15`). Its placeholder/nav entry stay absent until the user explicitly commissions the real editor. | Excluded from the re-skin. When built, restore its own route and nav item; preview is a client-side schematic, not WYSIWYG XLSX. |
| **AI Assistant** nav item | AI is optional, off by default, BYO-key, and client-direct. | No phantom destination while disabled; show it only inside the eventual enabled AI experience. |
| Page-level **neutral note strip** authored as `--panel` + a `--line` border directly on the page plane (`ScreenCards.dc.html:28`, `ScreenRequests.dc.html:80`, `ScreenRules.dc.html:101`) | §4 gives L0 no free-floating children and seats a well *inside* an L1 card, so a `--panel` plane on L0 is recessed into nothing. A page-mounted neutral notice takes the **L1** role instead — `--surface`, a `--line` edge, `--sh-1`, card radius. | Keep the well for a neutral note nested in an L1 card; use L1 for a page-mounted one. **Status-tinted** page banners are unchanged — tint plus a matching semantic border, which is what the prototype itself authors (`ScreenSaveLoad.dc.html:19`, `ScreenExport.dc.html:20`, `ScreenRequests.dc.html:21`). |
| Prototype attribute-substring compatibility CSS | Production uses explicit component/recipe contracts. | Never port selectors such as `[style*="border: 1px solid var(--line)"]`. |
| Prototype body can inherit UA black | Violates the No-Black Rule. | Keep the app shell's explicit `color: var(--ink)`. |

Everything else in the current navigation matches down to the group headings. Minor copy deviation: v2 spells it "Optimise"; the product ships "Optimize".

## 2. Colors

A warm ink ramp over a cool mint surface ladder, one selectable accent, and status colour used only where it means something.

### Ink
- **Ink** (`#332e2b`): headings and primary text. Warm espresso — **never pure black**.
- **Ink Secondary** (`#57504b`): body copy, secondary text.
- **Ink Tertiary** (`#665d57`): labels, meta, captions. Unlike v1's `#8b929c`, this is deliberately dark enough for 10–12px text on any tint — the sub-AA tertiary exemption v1 documented **no longer applies** and should not be reintroduced.
- **Faint** (`#9d938c`): disabled affordances and empty-cell marks only. Non-functional by definition.
- **On-ink** (`#fbf9f7`): text on dark fills.

### Surfaces (the ladder — see §4 for the rules)
- **Page / L0** (`#f3f6f4`): the recessed cool-mint plane everything sits on. Nothing floats free on it.
- **Sidebar** (`#f7faf8`): its own step between L0 and L1, with a hairline right edge.
- **Surface / L1** (`#fcfefd`): cards, table containers, the sticky top bar, secondary and ghost buttons.
- **Raised / L2** (`#ffffff`): dialogs, drawers, popovers, toast.
- **Panel / well** (`#eef3f0`): the inset plane *inside* an L1 surface — summary chips, table header bands, note strips.
- **Panel-alt** (`#f9fbfa`): subtle band inside a surface — zebra rows, hover fill. **Not** interchangeable with the well tone.
- **Line** (`#e0e3da`): primary borders, warm-tinted to sit with the ink rather than the canvas.
- **Hairline** (`#ecefe9`): inner dividers.
- **Rule** (`#d1cec5`): emphasis rules.

### Brand
- **Ward Teal** is the default accent; sage, rose, and plum are selectable alternates.
- The selected accent persists across theme changes, but each option has a separately audited light and dark value.

| Accent | Light `--brand` | Dark `--brand` |
|---|---:|---:|
| teal | `#0b7d68` | `#12a389` |
| sage | `#3f7f6b` | `#72aa94` |
| rose | `#af605a` | `#d1847e` |
| plum | `#6b5f8c` | `#9e91c2` |

Every light pair clears WCAG AA against white on the **unrounded** ratio — the tightest is rose at 4.5224:1. Thresholds are never compared after rounding: a computed 4.4999:1 does **not** meet 4.5:1 ([Understanding SC 1.4.3](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum)). That is why light rose is `#af605a` and not the originally published `#b0605a`, which computed to 4.49985:1 (decision **D4c**). The dark pairs clear at least 5.68:1 with `#111816` and 5.12:1 against the dark L1 surface. `--chrome` aliases the active `--brand`, so the app mark never introduces a second accent. `--onbrand` is `#ffffff` in light mode and `#111816` in dark mode. The derived text and tint tokens use the active theme-specific `--brand`:

```
--brandink  = color-mix(--brand 82%, black)     light | color-mix(--brand 60%, white)     dark
--brandtint = color-mix(--brand 10%, --surface) light | color-mix(--brand 26%, --surface) dark
```

Static unsupported-`color-mix()` fallbacks are part of the same contract and precede the guarded formulas in CSS:

| Accent/theme | `--brandink` | `--brandtint` |
|---|---:|---:|
| teal light | `#096755` | `#e4f1ee` |
| teal dark | `#71c8b8` | `#18443b` |
| sage light | `#346858` | `#e9f1ee` |
| sage dark | `#aaccbf` | `#31453e` |
| rose light | `#904f4a` | `#f4eeed` |
| rose dark | `#e3b5b2` | `#4a3b38` |
| plum light | `#584e73` | `#eeeef2` |
| plum dark | `#c5bdda` | `#3c3f4a` |

Note the tint mixes against **`--surface`**, not a literal white — so it must be re-tracked whenever the surface ladder changes. (v1 mixed 9% against a hardcoded `#ffffff`.) The allowlist is exactly `teal | sage | rose | plum`. An absent or unsupported stored value falls back to teal; there is no legacy blue/magenta/slate mapping or migration layer.

### Status — informational tiers plus exceptional solid actions

A semantic colour is almost always used as *text on its own pale tint*, so the base tier is already dark enough for that.

| Tier | Tokens | Use |
|---|---|---|
| **base** | `--success #1f6b52` · `--warn #8c5f1c` · `--error #bd4a28` | text or icon **on its own tint**; hairline borders |
| **ink** | `--successink #1f6b52` · `--warnink #8c5f1c` · `--errorink #9e3d1c` | deepest treatment — headings, emphasised numerals |
| **solid action** | `--fill-error` + `--on-error` · `--fill-warn` + `--on-warn` | destructive and exceptional warning actions only |

Tints: success `#e2f1ea` · warn `#f8efdd` · error `#fae7df`.

Only `--errorink` currently differs from its base; success and warn share a value at both informational tiers. Keep all six base/ink names anyway—their roles are a contract. **Success deliberately has no `--fill-success` / `--on-success` pair:** success stays a quieter tint + border + ink state and never competes with the primary accent.

**Solid fills carry their own ON-colour, because the pairing flips per theme.** In light mode `--warn` is 5.57:1 with white; `--fill-warn` still resolves to `--warnink` so the semantic fill uses its declared ON-colour contract rather than relying on a hardcoded foreground. In dark mode the tints become light pastels, so both fills take `--on-ink` instead. **Never hardcode white on a semantic fill.** This supersedes v1's single `--error-strong` patch, which fixed red only and left green and amber failing.

### Dark theme — mint-dark canvas, warm ink (not an inversion)

`--ink #f0ece7` · `--ink2 #b3aca6` · `--ink3 #a09892` · `--faint #6a635e` · `--on-ink #1d1a18` · `--bg #111816` · `--surface #1a2220` · `--surface2 #222b28` · `--panel #151d1b` (darker than its surface — wells recede) · `--panel-alt #1f2826` · `--line #2f3936` · `--line2 #27302e` · `--rule #404b47` · `--sidebar #141b19` · `--success #63c79e` / tint `#1a3129` · `--warn #d9a85c` / tint `#33280f` · `--error #e58164` / tint `#38201a` · `--successink #7fd7b2` · `--warnink #e8bd7c` · `--errorink #f09b80`.

The canvas is a desaturated mint-black and the ink ramp stays warm, exactly as in light mode. Accent values come from the selected row in the table above; dark mode never silently resets the choice to teal.

### Shift colour palette

Worked shifts are coloured **by start time**, from a fixed 8-entry ramp so mornings read warm and nights read cool. The one hard constraint: **adjacent entries must differ in hue, not just lightness** — two near-identical sands in a row made AM/PM/LD unreadable at chip size.

| # | Fill | Ink | Bar | Reads as |
|---|---|---|---|---|
| 1 | `#f8e2b8` | `#7a5310` | `#d4a038` | morning — amber |
| 2 | `#f6dbcd` | `#9a4726` | `#cf7049` | afternoon/evening — clay |
| 3 | `#e4ecd0` | `#586a22` | `#8fa243` | long day — olive |
| 4 | `#d8e0f2` | `#374777` | `#6274ad` | night — cool slate |
| 5 | `#e9dbf0` | `#653f8e` | `#9670bd` | plum |
| 6 | `#d3e9e3` | `#1b6a5d` | `#3d9587` | teal |
| 7 | `#f7dae2` | `#9a3153` | `#c66184` | rose |
| 8 | `#2b2733` | `#ece6f2` | `#5c5468` | dark (overflow) |

`fill`+`ink` are the chip; `bar` is the legend dot and day-view tag. These are **literal hexes, not theme tokens, and do not change in dark mode** — they are data marks and must stay comparable across themes. Reserved and never drawn from this ramp: leave (`--panel`) and rest (a `--faint` dot).

### Named rules

**The One Accent Rule.** Exactly one accent is live at a time, user-selected from four. The selection maps to its theme-specific `--brand`; `--brandink` and `--brandtint` derive from that active value and `--chrome` aliases it. Never hand-author a fifth accent at a consumer.

**The Redundant Signal Rule.** Status is never carried by colour alone: every status badge pairs its tint with a matching semantic ink and border, and status text says what it means (`DONE`, not a check glyph).

**The No-Black Rule.** Nothing inherits the UA default black. `button` does not inherit `color` by default — the shell must set `button { color: inherit }`. Any control rendering `rgb(0,0,0)` is a bug.

## 3. Typography

**Display:** Figtree · **Body/UI:** Hanken Grotesk · **Numeric/code:** Spline Sans Mono

A confident geometric display face over a plain, highly-legible grotesque, with a monospace face reserved for roster day numbers, IDs, counts, hours and solver expressions — so a number always reads as data, never as prose in the wrong face.

### Hierarchy
- **Display** (700, 1.15 line-height, -0.015em): page headings. v1 used Figtree 800; **v2 is one step lighter.**
- **Headline** (600, 1.2, -0.015em): card headers — 0.78× display.
- **Title** (600, 1.25, -0.015em): section titles — 0.60× display.
- **Body** (400, 1.5): running text and form content. Card paragraphs 1.45–1.5.
- **Label** (600, +0.03em, uppercase where used): eyebrows, badge text, field labels.
- **Micro / Nano** (11px / 10px): two **fixed** steps below the fluid scale, for dense data. Still multiplied by the 0.9 baseline.

All fluid steps ride the 480/768/1024/1280/1440/1920 ladder at a baked 0.9 multiplier. Prose columns cap at 60–68ch; headings 1.05–1.15.

### Named rules

**The Negative-Tracking Rule.** Every heading-weight face carries -0.015em (v1 used -0.02em); every uppercase label carries +0.03em. Never leave a heading at default tracking or a label un-tracked.

## 4. Elevation

> **This section reverses v1's "Flat by default, shadow only for overlays" doctrine and its Floating-Only Rule. Resting cards and secondary buttons now carry `--sh-1`.**

**Every surface belongs to a named level, and level is expressed by tone first, shadow second.**

| Level | Token | Shadow | What lives here |
|---|---|---|---|
| L0 · page | `--bg` | none | the app background; nothing floats free on it |
| sidebar | `--sidebar` | hairline right edge | the nav plane |
| L1 · surface | `--surface` | `--sh-1` | cards, table containers, sticky top bar, secondary/ghost buttons |
| L1 selected | `--surface` + `--brand` border | `--sh-2` | current wizard step, active editor card |
| L2 · raised | `--surface2` | `--sh-3` | dialogs, drawer, popovers, toast |
| well · inset | `--panel` | `--sh-well` | summary chips, table header bands, note strips *inside* an L1 card |

### Shadow vocabulary

Five general-purpose elevation tokens plus one specialized directional side-overlay shadow. All are **warm brown-tinted in light mode — never neutral grey or black** — and all re-tint per theme.

- `--sh-1`: `0 1px 2px rgba(60,55,45,.05), 0 2px 8px rgba(60,55,45,.05)` — resting L1
- `--sh-2`: `0 2px 4px rgba(60,55,45,.06), 0 10px 24px rgba(60,55,45,.09)` — hover / selected / lifted
- `--sh-3`: `0 20px 50px rgba(60,55,45,.22)` — modal layer; `--shadow-dialog` and `--shadow-toast` alias it
- `--sh-edge`: `6px 0 8px -6px rgba(60,55,45,.16)` — sticky-column scroll edge
- `--sh-well`: `inset 0 1px 2px rgba(60,55,45,.05)` — inset planes
- `--sh-side`: `-16px 0 50px rgba(60,55,45,.20)` — specialized directional runtime shadow for side drawers and mobile navigation only; Tailwind registers `--shadow-side: var(--sh-side)` and emits `shadow-side`

Dark mode swaps the warm browns for black at higher alpha (`--sh-1` .34/.24 → `--sh-3` .55).

### Named rules

1. **Direction of light is fixed.** A well never has an outer shadow; a raised surface never has an inset one.
2. **Full-bleed bands are square and flat.** A table's header band and its zebra rows span the whole card, so they never take a chip radius or a well shadow — only inset *islands* do. Zebra uses `--panel-alt`; `--panel` is reserved for header bands and true insets.
3. **A scroll region that ends a card takes the card's bottom radius and clips to it.** Otherwise rows hit a hard square edge inside a rounded card and the list reads truncated rather than scrollable.
4. **Secondary and ghost buttons are L1, not transparent.** A transparent outlined button on the recessed page does not read as pressable. Give it `--surface`, a `--line` hairline, and `--sh-1`; hover → `--panel-alt` + `--sh-2`; **active drops the shadow entirely.** Filled primary buttons also take `--sh-1` and flatten on `:active`.
5. **Never stack two levels of the same tone.** An L1 card inside an L1 card becomes a well instead.
6. **Dark mode inverts the direction, not the ladder.** Wells go *darker* than their surface; raised surfaces go lighter.

## 5. Components

### Radius — where it applies, and where it must not

| Token | Value | Applied to |
|---|---|---|
| `--r-card` | `16px` | cards, panels, table containers, dialogs |
| `--r-ctl` | `12px` | inputs, selects, textareas, inner bordered boxes |
| `--r-chip` | `9px` | badges, tinted chips, roster shift chips |
| `--r-pill` | `999px` | buttons, nav items, segmented controls, status pills |

Avatars are `50%`.

**Stay square, always:** `table`, `thead`, `tbody`, `tr`, `th`, `td`; the coverage grid cells; the small legend swatches (2–3px); and **every full-bleed bar or edge** — the sticky top bar, sticky sub-toolbars, and any container whose border is a single edge (`border-bottom`/`border-top`) rather than a box. A rounded corner on a full-width bar leaves a visible sliver of page background in the corner; bars butt flush to their container.

> **Rounding is warmth, not a theme. Do not round data structure away.** Rounding a person × date grid breaks the column read.

### Buttons
- **Shape:** pill (`999px`), all variants.
- **Primary:** `--brand` fill, `--onbrand` text, `--sh-1`, 36px height, 16px horizontal padding.
- **Secondary / Ghost:** `--surface` fill, `--line` hairline, `--sh-1` — **not transparent** (see Elevation rule 4).
- **Destructive:** `--fill-error` with its paired `--on-error` — never hardcoded white.
- **Link:** text-only, `--brandink`, underline on hover.
- **Hover:** `filter: brightness(.94)` on filled; `--panel-alt` + `--sh-2` on secondary/ghost. **Active:** shadow drops to none.
- **Focus-visible:** 2px `--brand` outline at `-1px` offset.
- **Precise-pointer sizes:** sm 32px / default 36px / lg 44px / icon 36px square.
- **Touch/coarse-pointer rule:** actual buttons and icon controls grow to a minimum 44px width and height. Do not simulate this with overlapping pseudo-element hitboxes.

### Cards / containers
- `--r-card` (16px), `--surface`, `--sh-1`, `--line` hairline, 20px internal padding.
- A selected card swaps the hairline for a `--brand` border and lifts to `--sh-2`.

### Inputs / fields
- `--r-ctl` (12px), `--surface`, `--line` hairline, 36px height with a precise pointer; actual height grows to at least 44px on touch/coarse-pointer devices.
- **Focus:** border shifts to `--brand` plus a soft 2px accent ring — reinforces the global focus-visible outline rather than replacing it.
- **Disabled:** reduced opacity, pointer-events removed. **Placeholder:** `--faint`, never the weight of real input text.

### Badges
- `--r-chip` (9px), tinted background matched to its semantic role, uppercase label at +0.03em.
- Always pairs its tint with the matching semantic **ink** and border. **No decorative ornament** — status reads `DONE` / `CURRENT` / `TO DO` as text; no check glyphs, no coloured leader dots on eyebrows. Colour and weight carry state.

### Roster grid (target — not yet built)

The densest surface in the system, and the one with the most specific rules. It has no implementation yet; this is the spec for when it is built.

- Container is `--r-card` with `overflow:auto` and `max-height:66vh` — **the container is the scroller**, so sticky offsets resolve against it, not the page.
- **Sticky z-order is load-bearing:** day/summary headers `z:3`, body first column `z:2`, top-left corner `z:5`. Headers below the first column makes nurse names paint over the date row while scrolling. Both sticky edges carry `--sh-edge` so content visibly passes *under* them.
- Header bottom rule is `2px solid --line` on **every** header cell including the corner; mismatched weights leave a visible step.
- **Chips:** one builder, one box — `34×28`, `--r-chip`, **no border**. Worked shifts take their palette `fill`/`ink`; leave is a neutral `--panel`/`--ink3` chip; rest is a bare `·` in `--ink3` at the same box size so columns never jitter. Leave must **not** use `--brandtint` + `--brand` border — that is the selection language. States are inset shadows, never a `1px transparent` border on every chip (which makes one variant a pixel larger than its neighbours).
- **Columns:** weekends `--panel`; ordinary columns `transparent` so row-hover reads through; holidays a 135° `--warntint`/`--surface` stripe; a `1px --line` left edge every 7th column. Rows hover to `--panel-alt`. Cell padding `4px` → ~36px rows.
- All semantic colour comes from tokens. **No hardcoded `rgba(200,40,40,.08)`.**

### Toast
- Bottom-centre, `--ink` fill, `--on-ink` text, leading ✓ mark, `--shadow-toast`, click to dismiss, `role="status"`.
- v1's green 3px left-edge rule is **retired** along with the no-side-stripe exception that justified it.

### Navigation
- Sticky full-height sidebar at ≥920px on the `--sidebar` plane with a hairline right edge; below 920px it becomes an overlay drawer (250px, max 84vw) behind the theme-specific `--scrim`. Raw `bg-black/*` and fixed near-black RGBA overlays are off-contract.
- Nav items are pills: active = `--brandtint` fill + `--brandink` text and icon; hover = `--panel`. `aria-current="page"` when active.
- Top bar is sticky, 56px, `--surface`, `1px solid --line` bottom, **square corners**. Left: 26px rounded `--chrome` app mark (the active accent) + uppercase breadcrumb. **No user avatar, no ward or org label** — neither exists yet. When accounts arrive, the top-bar right slot and the sidebar footer are the intended places.

## 6. Do's and Don'ts

### Do:
- **Do** put every surface on a named ladder level, and express level by **tone first, shadow second**.
- **Do** round cards (16), controls (12) and chips (9), and pill every button and nav item.
- **Do** keep tables, roster cells, coverage grid cells, legend swatches and every full-bleed bar **square**.
- **Do** give secondary and ghost buttons a real `--surface` fill with `--sh-1` — a transparent outline on the recessed page does not read as pressable.
- **Do** pick the right semantic tier: base on its own tint, ink for the deepest treatment, and paired warn/error `--fill-*` + `--on-*` only for exceptional solid actions.
- **Do** use warm brown-tinted shadows in light mode, black at higher alpha in dark.
- **Do** use the layout ladder (600/720/760/900/1100/1200px) for grid/form breakpoints and the type ladder (480/768/1024/1280/1440/1920px, plus the 920px nav pivot) for everything else.
- **Do** multiply spacing and type by the 0.9 baseline — and **not** radius or shadow, which are absolute.

### Don't:
- **Don't** use pure black, or let a control inherit the UA default `rgb(0,0,0)`.
- **Don't** round a data structure — no soft-blob tables, roster cells or full-bleed bars.
- **Don't** hardcode white on a semantic fill; use the paired `--on-*` token.
- **Don't** put an outer shadow on a well or an inset shadow on a raised surface.
- **Don't** stack two surfaces of the same tone — nest a well instead.
- **Don't** use `--panel` for zebra striping; that tone is reserved for header bands and true insets. Use `--panel-alt`.
- **Don't** use `--brandtint` + a `--brand` border for anything but selection.
- **Don't** add decorative ornament to labels or status — no check glyphs, no leader dots. Text carries the state.
- **Don't** ship a generic SaaS dashboard cliché — no gradient hero metrics, no glowing stat tiles, no glassmorphism.
- **Don't** let anything look like an unstyled shadcn default. Every component must visibly belong to this system.
- **Don't** use gradient text or `background-clip: text`.
- **Don't** reproduce the prototype's compatibility CSS. Because v2 was retrofitted onto v1 markup, the shell carries a block of attribute-substring selectors (`[style*="border: 1px solid var(--line)"] { border-radius: … }`) that applies radii and fills wholesale. It is the single most fragile thing in those files. In production, put radii, elevation and button variants on components directly.
- **Don't** snap a layout grid to the nearest type-ladder breakpoint instead of its own layout-ladder value — it has previously shipped the wrong column count.

## 7. Implementation notes for the port

1. **Use a hybrid surface contract.** Ordinary containers render through `Surface` (`level: page | surface | raised | well`); specialized tables, sticky regions, editors, and grids consume the same shared variant/recipe definitions without wrapper-only DOM. `Button` variants remain a shared component contract.
2. **The token swap is only the foundation.** `bg-surface` currently spans 57 files, `bg-panel` spans 56, and `bg-panel-alt` is unused. Every shipped route must classify existing surfaces, wells, full-bleed bands, hover/zebra states, semantic fills, and scrims. The v2 re-skin is not complete while product routes remain visually mixed.
3. **Inventory radius by semantic owner, not text occurrence.** The current tracked-source query finds `253 border-line sites / 74 files`; it mixes boxes with dividers and single edges while missing unbordered/semantic-border owners, calendar CSS, InfoTip, and accent swatches. Classify primitives, card/list shells, modals, fields, chips, tables/grids, and single-edge bars; use source queries only as post-migration guards.
4. **Accent state is part of the port.** Update the allowlist, pre-paint hydration, settings control, persistence tests, and invalid-value fallback together. Do not add a legacy blue/magenta/slate migration.
5. **Verification is route-wide, not style-guide-only.** Re-pin token/radius/accent tests, then exercise every shipped route in light/dark, precise/coarse-pointer sizing, responsive layouts, and contrast/status/scrim states before the epic is complete.
6. Any scrolling code or data panel needs `min-width:0` on **every** flex ancestor — a non-wrapping `<pre>` inside a default `min-width:auto` flex item pushes the whole page into horizontal scroll instead of scrolling itself.
7. Accessibility: `role="tablist"`/`aria-pressed` on segmented controls, `role="status"` on toasts and skeletons, `title` on flagged roster cells, visible focus rings retained, and status never encoded by colour alone.
8. Motion: easing `cubic-bezier(.4,0,.2,1)`, durations 150ms fast / 220ms base. Buttons transition `box-shadow` and `background` on the fast duration. All animation collapses to `.01ms` under `prefers-reduced-motion`.
