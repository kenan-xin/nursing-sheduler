---
title: "Note frontend vs backend validation-message layering"
kind: ticket
status: 0
---

# Note frontend vs backend validation-message layering

**Source: critique-review R8.**

Some validation rules exist at both layers with subtly different verbatim
strings (e.g. spec 05's `Weight must be non-positive for shift count with "|x - T|^2"`
vs contract C3 E39's `...with '{expression}'. — different quoting/punctuation/`
templating; coefficient messages also differ by layer).

Fix: add a note in spec 05 and contract C3 that these are separate layers with
separate verbatim strings; a parity test must assert the frontend string for a
frontend-caught case and the backend string for a backend-caught case.
