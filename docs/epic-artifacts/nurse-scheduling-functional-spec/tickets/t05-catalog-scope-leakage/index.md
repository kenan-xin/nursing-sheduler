---
title: "Remove excluded-ops scope leakage from the behavior/test catalog"
kind: ticket
status: 0
---

# Remove excluded-ops scope leakage from the behavior/test catalog

**Source: critique-review R5.**

The behavior/test catalog (mechanically derived from the current test suite)
re-introduces excluded ops features as parity behaviors:

- `ST-B4 — the cross-tab storage-change banner.`
- "Navigation & Shell" flows — build-selector/feedback-button overlap check.
- `OE-B8 — cites sentrySchedulingState.test.ts (Sentry transport is excluded;`
only the shared anonymize transform is in scope per `FR-SL-39).`

Fix: remove or reclassify these as out-of-scope in
`behavior-test-catalog/index.md. Decide forced-light-mode's disposition`
alongside ticket T01 (parity → own it in the shell spec; visual choice → drop
from the parity catalog, hand to Claude Design).
