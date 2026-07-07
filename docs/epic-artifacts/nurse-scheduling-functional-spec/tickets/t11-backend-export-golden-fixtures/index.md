---
kind: ticket
title: "Add export-block golden fixtures to the core Python test suite"
status: 0
---

# Add export-block golden fixtures to the core Python test suite

**Source:** critique-review, "Action item beyond the specs" (verified true).

Zero testcases in `core/tests/testcases/` (including `real/`) use a top-level
`export:` block. The YAML→CSV/XLSX golden-file harness (`schedule_test_helper.py`,
`export_test_helper.py`) therefore never exercises export layout — a rebuild
could pass the entire harness while regressing export rendering. Export
formatting is currently covered only by `test_export_formatting.py` (inline
YAML, not the golden harness) and the frontend test suite.

Fix (backend-side, not a spec change): add one or more `export:`-bearing YAML
fixtures with matching `.xlsx`/`.prettify.xlsx` goldens to
`core/tests/testcases/`.

Related: `exporter.py:589` concatenates a shift-type `id` without `str(...)` —
an integer shift-type id would raise `TypeError` on export, an untested path.
Keep emitting string shift-type ids in the rebuilt frontend to stay on the
tested path; consider a fixture/fix for this on the backend side too.
