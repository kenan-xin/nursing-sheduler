---
kind: ticket
title: "Document optimize-payload vs save/load export-block asymmetry"
status: 0
---

# Document optimize-payload vs save/load export-block asymmetry

**Source:** critique-review R4.

Spec 10 `FR-OE-43` treats the optimize `yaml_content` shape as identical to
spec 08's save/load output, but they differ: the optimize page always sends
`export: effectiveExportData` (generated default when `state.export` is unset),
while save/load's download omits `export` entirely in that case
(`optimize-and-export/page.tsx:508-516`, `useSchedulingData.ts:972-973` vs
`save-and-load/page.tsx:86`).

Fix: state the asymmetry explicitly in `FR-OE-43`/`AC-OE-15` of spec 10.
