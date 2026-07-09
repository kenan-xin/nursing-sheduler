---
title: "Decide policy for requirement-weight -Infinity frontend/backend mismatch"
kind: ticket
status: 0
---

# Decide policy for requirement-weight -Infinity frontend/backend mismatch

**Source: critique-review R3. Severity: CRITICAL.**

With `preferredNumPeople set, the backend rejects `**both **`+inf and -inf`
weights (`core/nurse_scheduling/preference_types.py:186-190, error E27). The`
current frontend only blocks weight `> 0 (AC-PR-08 says "<= 0 including`
`-Infinity"), and exposes a -∞ button. A user can create a requirement that`
passes frontend validation but fails the optimize job at solve time — a latent
bug in the current app.

**Needs a decision (user/product call) before the fix:**

1. Reproduce the bug for strict parity + add a parity test asserting the
 resulting FAILED job, or
2. Fix it in the rebuild (reject both infinities when `preferredNumPeople is`
 set) as a deliberate deviation from literal parity.

Either way, annotate spec 05 `AC-PR-08 to point at contract C3 error E27.`
