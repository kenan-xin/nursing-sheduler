# Functional spec

This folder is the source of truth for the nurse-scheduling functional spec.
Edit it here.

## Where it came from

It was copied as-is on 2026-09-27 from the Traycer workspace (epic
`8b2235d5`, artifact `nurse-scheduling-functional-spec`). The Traycer copy is
no longer updated. Links that point outside this folder (for example to the
rebuild brief or tech plan) lead to Traycer artifacts that were not copied.

Fixes made after the import (bead `nursing-sheduler-76u`):

- Contract C2 now describes the current HTTP API (`/optimize`, events, roster,
  xlsx, options, `/info` with `api_version` `0.2.0`).
- Spec 01 states that IDs may be numbers or strings and match exactly; spec 06
  follows it.
- Old-app code citations were removed from specs 06, 10, 11 and 12.

Other sections, the audits, reviews and tickets still cite the old app's code
(`web-frontend/src/...`, `page.tsx:nnn`). Read those citations as history, not
as pointers into this repo.

## When sources disagree

`DESIGN.md` and the code win. If this spec disagrees with either one, fix the
spec. `DESIGN.md` owns the visual system; the code owns actual behavior and
the wire contract.

Start with `index.md`. Fixed contracts are in `contracts/`, and decisions are
in `decision-logs/`.
