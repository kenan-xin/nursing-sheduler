---
title: "Add Home / App-Shell functional spec"
kind: ticket
status: 0
---

# Add Home / App-Shell functional spec

**Source: critique-review R1, R9. Severity: CRITICAL.**

Tab 0 ("Home") and the app shell have no owning spec. Create a new domain spec
covering:

- Tab-0 content: title, welcome copy, dev-in-progress warning banner.
- "New Schedule" and "Continue" (→ `/dates) buttons.`
- The **custom "Confirm Reset" modal (not a native **`confirm() — contrast with`
`FR-ST-31's native tab-switch guard): heading Confirm Reset, body`
`Are you sure you want to start from a new state? This will reset all your current data.,`
buttons `Cancel / Reset Data.`
- Footer content.
- Forced light-mode (decide policy: parity requirement vs. visual choice for
Claude Design — see critique for the framing).
- An explicit "present in current app but excluded" list (resolves the dangling
"App Shell / Layout artifact" references in specs 07 and 08 — R9).

Source: `web-frontend/src/app/page.tsx, web-frontend/src/app/layout.tsx,`
`web-frontend/src/app/globals.css.`
