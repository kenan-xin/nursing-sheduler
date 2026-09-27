---
title: "Fixed Contracts — Conformance Targets"
kind: story
status: 1
---

# Fixed Contracts — Conformance Targets

The Python optimization core is **not being rebuilt. Its interfaces and**
semantics are documented here as **contracts the new frontend must conform to**
**exactly. These are reference specs, not requirements to re-decide.**

| Artifact | Prefix | Covers |
| --- | --- | --- |
| C1 — YAML Scenario Schema | CON-YAML | The exact YAML the frontend generates and the backend accepts: every section, field, type, default, key ordering; camelCase Kubernetes-style conventions. |
| C2 — HTTP Serve API | CON-API | FastAPI endpoints, request/response schemas, status codes, SSE event stream, job lifecycle, limits, cookies, CORS. |
| C3 — Preference / Constraint Semantics | CON-SEM | The seven preference types, weight/hard-vs-soft math, group/keyword/date-shorthand resolution, validation error catalog. |
| C4 — Solvers, CLI & Execution | CON-EXE | Solver selection & options, per-solver differences, cancellation/stop support, CLI usage, progress/stat plumbing, infeasibility handling. |
| C5 — Exporter Output | CON-OUT | Solved-schedule DataFrame layout, prettify additions, custom formatting, xlsx (+ Notes sheet) and csv output structure. |
