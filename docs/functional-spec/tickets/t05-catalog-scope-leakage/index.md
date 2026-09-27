---
title: "Remove excluded-ops scope leakage from the behavior/test catalog"
kind: ticket
status: 2
---

# Remove excluded-ops scope leakage from the behavior/test catalog

**Source: critique-review R5.**

The behavior/test catalog (mechanically derived from the current test suite)
re-introduced excluded-ops features as parity behaviors. All leakage points are
now reclassified against the decision-log-06 fidelity rule (backend behavior is
binding; UI/ops presentation is `[incidental]` or out-of-scope, not required).

## Resolution (done)

| Leakage | Disposition |
| --- | --- |
| `ST-B4` — cross-tab storage-change banner | `[OUT OF PRODUCT SCOPE — excluded per the brief]` (catalog line ~344); the reuse-table `useSchedulingData.test.ts` row now notes the cross-tab portion maps to ST-B4 and must not enter the parity gate. |
| "Navigation & Shell" flows — build-selector / feedback-button overlap, arrow-nav, shortcuts | Tagged `[incidental]` (catalog lines ~640–643); section preamble states these are current-frontend presentation, not a binding gate. |
| `OE-B8` — cites `sentrySchedulingState.test.ts` | Split: the shared client-side **anonymize transform + reverse mapping is in scope** (FR-SL-39); the **Sentry transport is `[OUT OF SCOPE]`**. Reuse table now lists `anonymizeSchedulingState.test.ts` (re-author-logic) and `sentrySchedulingState.test.ts` (out-of-scope) separately. |
| Forced light-mode | Decided as a **visual choice → `[incidental]`**, dropped from the parity gate and handed to design (not owned as parity). If a rebuild must preserve it, that is a shell-spec decision (ticket t01), not a catalog parity behavior. |

## Also verified (no further leakage)

- The `VersionWarningBanner` reference (catalog ~line 393) is the **in-scope**
save/load appVersion-mismatch import warning (spec 08), NOT the excluded GitHub
version-check banner — left as binding.
- No build-origin-selector, Google Analytics, or GitHub-version-check parity rows
remain in the catalog beyond the `[incidental]`-tagged floating-widgets row.

Catalog fidelity intro (lines ~16–23) was already re-baselined to DL06 in an
earlier round, establishing the binding-vs-`[incidental]` convention these tags
rely on.
