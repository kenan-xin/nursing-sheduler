# Product

## Register

product

## Users

Ward/nurse schedulers and managers who model a ward (people, shift types, calendar), express scheduling rules, run a fixed OR-Tools CP-SAT optimization core, and export the solved roster as a styled XLSX. Skill level ranges widely: some are power users who want full constraint control (Advanced mode), others just need a correct roster with minimal training (Guided mode). Both must be served by the same data model, never a stripped-down subset.

A secondary, strictly optional path: users who choose to enable AI features (BYO LLM API key, client-side direct to provider) get a Tier-2 AI infeasibility diagnostician on top of the always-on, deterministic Tier-1 static conflict validation. AI is never assumed present in copy or flow.

## Product Purpose

The product loop: **Model the ward -> Express the rules -> Generate the roster -> Review & export.** Success is a feasible, correct roster produced with minimal friction and training, while still capturing every real-world scheduling constraint a ward actually has (signed/infinite weights, coefficients, ordered patterns, groups, contracted hours, coverings). The UI is a proposal layer over one binding contract: the Python backend's data shapes, validation, and XLSX output. Visual system, navigation, and interaction choreography are free to design well, but capability and data fidelity are not negotiable.

## Brand Personality

**Precise, calm, approachable.** This is a professional scheduling instrument for healthcare staff, not a consumer app or a cold clinical system. The users are nurses on shift, using this at the start and end of long days — warmth is not decoration here, it is the difference between a tool that reads as hostile and one that reads as usable. Warmth lives in the ink, the hairlines and the rounded controls; precision lives in the data surfaces, which stay dense and square. Voice is plain-language: every constraint or disabled state explains what governs it and where to change it, never a bare greyed-out control. Confidence comes from precision and clarity, not decoration.

## Anti-references

- **Generic SaaS dashboard cliche** - gradient hero metrics, glowing stat tiles, hero-metric templates, glassmorphism-as-default.
- **Cold clinical hospital software** - sterile, impersonal, intimidating for non-technical ward staff just trying to fill in a roster.
- **Playful consumer app** - mascots, bright primary colors, everything-rounded. The design system rounds deliberately and selectively (cards 16px, controls 12px, chips 9px, pill buttons) but holds every data surface square - tables, roster cells, coverage grids and full-bleed bars. Rounding a person x date grid breaks the column read; rounding is warmth, never a theme applied wholesale.
- **AI slop / generic shadcn-default look** - the unstyled default shadcn aesthetic that every AI-generated app converges on. Every screen must read as a deliberately designed instrument built for this product, never as boilerplate scaffolding.

## Design Principles

1. **User-friendly and maximally flexible are co-equal goals.** Never resolve the tension by quietly dropping flexibility for simplicity, or burying simplicity under raw constraint editors.
2. **Progressive disclosure, not lossy modes.** Guided mode is a lens over the same Advanced data, never a mutation or a flattening of it. Anything Advanced-only that Guided can't render natively shows a clear read-only fallback.
3. **Show what governs a value, and why.** Every constrained/disabled/read-only control pairs with a plain-language reason and a link to where it's actually editable.
4. **Prototype fidelity is a first-class acceptance criterion, scoped to the visual system.** The canonical UI reference is the v2 bundle at `docs/design_prototype/` - `standalone/nurse-scheduling-v2-standalone.html` to click through, `source/Screen*.dc.html` for per-screen markup. Recreate its visual treatment faithfully using the codebase's own component contracts. Authority is deterministic: product contracts and ratified decisions → `DESIGN.md` visual rules → prototype examples. The bundle does not supersede behaviour, architecture, data contracts, or feature priority. In particular, Customise/pinning stays removed; Export Layout remains a separate user-gated deferred route; Roster and AI retain their own gates. See `DESIGN.md` §1 for the complete deviation matrix.
5. **Instrument, not decoration.** Precise data density, warm ink on a cool canvas, muted purposeful color, and a surface ladder where tone carries separation before shadow does. No AI-generated genericism - every visual choice should look deliberately chosen for this specific scheduling tool.

## Accessibility & Inclusion

WCAG 2.1 AA baseline. Respect `prefers-reduced-motion` (already load-bearing in the prototype's motion system). Mobile-first responsive ladder: sidebar becomes a fixed drawer below 920px, sticky rail above it; dense matrices (person x date requests) get horizontal scroll with sticky header/first column on small screens.
