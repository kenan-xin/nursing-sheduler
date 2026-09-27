---
title: "Document 'at most one shift per day' UI disposition and load-path gap"
kind: ticket
status: 0
---

# Document "at most one shift per day" UI disposition and load-path gap

**Source: critique-review R6.**

This preference is seeded, required, and indestructible in cascades, but no
spec states it's implicit/non-editable/tab-less/always-emitted. Spec 05 defers
to "covered elsewhere," which doesn't exist.

Also: `loadFromYaml (useSchedulingData.ts:771-970) does `**not re-add this**
preference if a loaded YAML omits it, producing a frontend scenario the backend
will reject (CON-YAML V1) — undocumented.

Fix: state the implicit disposition in spec 01 (or the new shell spec from T01);
delete the dangling "(covered elsewhere)" in spec 05; document the load-path gap
in spec 08 plus a parity test asserting the resulting invalid state.
