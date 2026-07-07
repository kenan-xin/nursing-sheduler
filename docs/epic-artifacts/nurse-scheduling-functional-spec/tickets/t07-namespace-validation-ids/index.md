---
kind: ticket
title: "Namespace validation and edge-case IDs globally"
status: 0
---

# Namespace validation and edge-case IDs globally

**Source:** critique-review R7.

Bare `V1..Vn` validation IDs collide across specs 03, 08, and 09 (each denotes a
different rule). Edge-case IDs are inconsistent (`QK-SR-nn` vs `EDGE-PR-nn` vs
none). The story's convention section only governs `FR-`/`CON-`/`AC-` IDs.

Fix: namespace all validation IDs as `VR-<PREFIX>-nn` and edge-case IDs as
`EDGE-<PREFIX>-nn` across every spec; add the convention to
`nurse-scheduling-functional-spec/index.md`.
