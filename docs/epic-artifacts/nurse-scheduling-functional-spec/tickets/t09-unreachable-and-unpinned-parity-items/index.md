---
kind: ticket
title: "Fix unreachable conditions and unpinned parity claims (specs 02, 05, 08, 09, 10) — partial; R10 + R12 reopened in iter 3"
status: 1
---

# Fix unreachable conditions and unpinned parity claims

**Source:** critique-review R10–R16.

Grouped fixes across several specs:

1. **R10** — spec 10 `FR-OE-30/31`/`AC-OE-11`: "shift types missing" precondition
   is unreachable-by-construction (auto `OFF` item + `ALL` group are always
   injected). Mark as unreachable, keep for literal parity.
2. **R11** — contract C2 `CON-API-03`: doesn't state the server never validates
   `solver` (accepts any string, 202, then FAILS async with E52). Add a sentence.
3. **R12** — spec 08 `FR-SL-06`/`AC-SL-02`: "byte-stable YAML" overclaimed as an
   unconditional MUST; only holds for UI-generated YAML at matching app version.
   Scope the requirement; reference the shape-changing normalizations
   (`FR-SL-23/24/27`).
4. **R13** — e2e mock job-response (`e2e/helpers.ts`) is a strict subset of the
   real contract (missing `queuePosition`, `finishNowRequested`,
   `cancelRequested`, `error`, `clientHeartbeatExpired`). Flag divergence;
   require the parity suite to exercise queue-position/finish-now rendering via
   an enriched mock or unit test.
5. **R14** — spec 02 `FR-DC-04`/`AC-DC-01`: the "Apply" button label is dead
   code — `dateData.range` is always a truthy object, so the label is always
   "Update," even first-run. Correct `FR-DC-01/02/04`.
6. **R15** — spec 04 `FR-SR-39`: "Current Shift Requests" summary renders the
   **raw** weight number with a `+` prefix (not `getWeightDisplayLabel` as the
   matrix uses) — pin this explicitly plus the three captions
   (`Wants this shift`/`Wants to avoid`/`Neutral`); note `OFF` is a valid,
   selectable history value.
7. **R16** — spec 01/08: top-level `description` is serialized but has no
   editor in the current UI (settable only via YAML load/edit). Add one
   sentence.
