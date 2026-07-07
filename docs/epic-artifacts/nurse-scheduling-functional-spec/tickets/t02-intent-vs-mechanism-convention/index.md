---
kind: ticket
title: "Add 'behavioral intent vs current mechanism' convention and apply it"
status: 0
---

# Add "behavioral intent vs current mechanism" convention and apply it

**Source:** critique-review R2. **Severity:** CRITICAL.

"Strict parity" and "brand-new design" collide where FRs pin current UI
*mechanism* as if it were required *behavior*. Add a convention to the story
index distinguishing the two, then re-tag the affected requirements:

- `FR-ST-24/28`, `AC-ST-17` — digit-key→tab-index shortcuts, numeric tab labels,
  the tabs-10/11-unreachable quirk: assume a numbered tab bar. Reframe as intent
  (fast keyboard jump to ~12 destinations) vs. mechanism (digit=index mapping).
- `FR-ED-22`, `FR-DC-33`, `FR-SR-30/45`, `FR-PR-12`, `FR-ED-19` — mouse-down/
  enter/up drag-select mechanics. `FR-DC-33` in particular pins a **calendar
  accessibility defect** (Enter/Space `preventDefault` → keys inert) as a
  requirement — do not carry this into the rebuild as binding.
- `AC-SR-05` opacity curve, verbatim aria-label strings, and native `confirm()`/
  `alert()` usage — reframe curve/strings/dialog-mechanism as current mechanism;
  keep only the intents (intensity scales with weight, accessible names exist,
  destructive actions are confirmed with the given prompt text) as parity.

Apply the pattern spec 04 already uses for matrix colors ("non-binding
reference") uniformly across the set.
