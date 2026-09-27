---
title: "Decision Logs"
kind: spec
---

# Decision Logs

Settled decisions, scope boundaries, and confirmed baselines. Each is durable
context for the rebuild. **Before making a choice that touches any of these**
**areas, read the relevant log — do not silently contradict a settled decision;**
**raise it for confirmation first.**

Later logs can supersede or narrow earlier ones (e.g. DL11 supersedes DL07);
where they do, the later log says so explicitly.

- [01 — Singapore, English-only](./01-singapore-english-only/index.md)
- [02 — Shift Type Covering preference](./02-shift-type-covering-preference/index.md) — the discovered 7th preference type.
- [03 — Non-workday rename](./03-nonworkday-rename/index.md) — FreeDay → Non-Work Day (NON-WORKDAY).
- [04 — PH default group](./04-ph-default-group/index.md) — the Public Holidays default date group.
- [05 — Contracted-hours & leave model](./05-contracted-hours-and-leave-model/index.md) — first-class leave (Option C), shift durations (Option B).
- [06 — Re-baseline to the shipped backend](./06-rebaseline-to-shipped-backend/index.md) — the shipped three-state backend IS the contract; the fidelity rule; the spec-12 leaveTypes/migration vision is deferred.
- [07 — Backend URL via env](./07-backend-url-via-env/index.md) — build-time `NEXT_PUBLIC_BACKEND_API_URL`; the multi-server selector leaves scope. *(Superseded by DL11.)*
- [08 — Covering omitted date = all dates](./08-covering-omitted-date-all-dates/index.md) — handler bug fix; omitted/`None` covering date now means every day.
- [09 — Fixed half-hour grid, hard Contracted Hours & explicit refresh](./09-minute-unit-and-working-time-coefficients/index.md) — current-window Exact/Range totals, minimal `{unit,policy}` metadata, concrete selector snapshots, previewed Refresh, no migration or automatic synchronization.
- [10 — Design-review product decisions](./10-design-review-product-decisions/index.md) — role field, anonymize toggle, roster/AI direction.
- [11 — BFF supersedes DL07; version-reporting adaptation](./11-bff-and-version-reporting/index.md) — the BFF boundary replaces the env-URL wiring of DL07 and narrows the DL06 version-reporting rule.
- [12 — Local autosave, backup mode & load safety](./12-autosave-backup-mode-load-safety/index.md) — local autosave, workspace YAML, Guided mode, load safety.
- [13 — Shared workspace YAML contract](./13-shared-workspace-yaml-contract/index.md) — flat extended scheduling YAML and strict solver conversion.

## Related decision records elsewhere in the epic

- [Tech-plan decisions](../../rebuild-tech-plan/decisions/index.md) — implementer routing and upstream Redis job architecture / core deployment.
- [LEAVE day-state — uncredited-leave guard decision log](../../leave-daystate-contract/guard-decision-log/index.md) — the confirmed LEAVE day-state contract and guard behavior.
