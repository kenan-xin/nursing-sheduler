---
title: "Cold critique — Save / Load rewrite plan"
kind: review
---

# Cold critique — Save / Load rewrite plan

## Verdict

**Revision required before drafting.** The plan correctly replaces the obsolete
strict-scenario export story with Workspace V1 and removes implementation-level
rot. It is not yet safe to draft because its contract boundary is incomplete and
one of its proposed primary references is stale. The must-fix items are C1's
role, the two load-gate paths, the Guided-Rules ownership seam, and making the
backup/sample behaviors independently testable in 08.

## Blockers

### B1 — C1 cannot currently be the rewrite's legacy-format authority

**Claim.** 08 can describe Workspace V1 and cross-reference C1 for the
legacy/scenario format.

**What breaks first if wrong.** A reader follows C1 and learns that emitted YAML
is the old `apiVersion … appVersion` document, must reject unknown fields, and
has old key-order/style rules. That directly contradicts DL13 and the shipped
Save/Load behavior, which writes a Workspace V1 superset. Moving this spec to
`/docs` would canonize two incompatible accounts of the same format boundary.

**Improve.** Before drafting, explicitly assign C1 one of two roles: revise it
first into a strict-solver-only contract with a clearly delimited legacy-import
section, or make 08 self-contained enough to define both accepted file classes
until C1 is corrected. In either case, state which contract wins when a
Workspace extension and the strict solver model disagree. Do not leave the
format discriminator or Workspace-only fields defined only by a multi-hop
reference.

### B2 — “Dual-format load” hides materially different acceptance gates

**Claim.** Load is dual-format dispatch plus version/replacement confirmation,
with backward compatibility for old files.

**What breaks first if wrong.** An implementer may run the strict
producer/readiness validation on a Workspace backup and reject the very
incomplete dates or disabled records DL12 says must be recoverable. The inverse
mistake is accepting a malformed legacy document as a permissive workspace
backup. Current behavior deliberately differs: Workspace V1 load requires YAML,
strict structural fields, and identity/Guided-pin integrity; legacy load runs
the strict import/projection preflight and may surface non-blocking
advanced-syntax warnings.

**Improve.** Add a compact dispatch matrix to 08: discriminator, accepted
authoring state, blocking conditions, warning channel, and restored metadata for
each file class. Define the unsupported-version outcome too. Frame compatibility
as “legacy strict files supported subject to their import validation,” not as an
unqualified guarantee that every old file loads.

### B3 — The proposed 07/08 Guided-Rules split has no ownership contract

**Claim.** Put the projection model in 07 and retain load-time Guided behavior
in 08.

**What breaks first if wrong.** A future change adds a sixth constraint kind,
changes card identity, or changes the built-ins and updates 07 alone. 08 can
then promise that legacy imports populate Rules while the projection no longer
does so. The present behavior is more specific than the plan records: every
card, enabled or disabled, projects to a row; built-ins are also projected; a
pin overlays a row but never creates or gates it; Workspace pins must resolve
uniquely to source cards.

**Improve.** The split is viable only with a named shared contract and a single
source of truth. Put the complete projection/identity invariants in 07 (or a
dedicated Guided Rules artifact), then have 08 state the load mapping precisely:
legacy supplies no pins; Workspace restores validated pins; both derive rows
from imported constraints and built-ins. Cross-link using stable requirement
IDs, not “see Guided Rules.”

## Drift and contradictions

### D1 — The export claim needs its exception and its real gate

**Claim.** Save/Load always emits Workspace V1, with no fallback to the strict
scenario format.

**What breaks first if wrong.** The main claim is correct for user-facing
Download, Copy, Edit preview, and anonymised Download. But a blanket statement
will be falsified by the built-in sample loader, which intentionally creates a
strict legacy scenario to exercise compatibility. It also conceals the only
backup-export blocker: duplicate durable workspace identities, not general
solver readiness. A rewrite that says “valid scenario required” would regress
incomplete-work backup; one that says “never blocked” would permit a file that
cannot reload without identity collision.

**Improve.** Scope “always emits Workspace V1” to all user-authored backup
actions, enumerate those actions, and document the sample as a deliberately
generated strict compatibility fixture. State the narrow Workspace export gate
and its outcome in behavioral terms. Preserve the separate Optimize strict
projection boundary in DL13/C1 rather than implying that a backup is
solver-ready.

### D2 — Replacement, version, and history are not yet one end-to-end contract

**Claim.** The plan corrects the three-case version classification and adds the
DL12 replacement confirmation with combined modal strings.

**What breaks first if wrong.** A matching-version load into a non-empty
workspace could again replace state without confirmation, or an empty
workspace with a version warning could bypass the warning. A cancelled dialog
must leave state untouched. A confirmed load must replace as one undoable
history boundary, rather than clear history, and it must not mark the imported
file as a fresh local backup.

**Improve.** Make this a small decision table, not adjacent prose: current
workspace empty/non-empty × version match/non-match, followed by
cancel/continue effects. Include the undoable replacement and backup-freshness
postconditions in the table or acceptance criteria. This closes confirmed 08-5
and 08-6 without relying on DL12 as a reader's second lookup.

### D3 — The “drop mechanics” decision risks dropping observable import outcomes

**Claim.** FR-SL-21…31 can be removed because their named functions and
normalizers are obsolete.

**What breaks first if wrong.** Removing implementation names is right, but
legacy files with scalar references, numeric IDs, nested reference trees,
omitted defaults, or LEAVE/OFF forms still have observable outcomes. In
particular, supported advanced syntax is preserved and warned rather than
silently rewritten or rejected; covering `preceptors` and `preceptees` now join
the warning set. An implementation that only sees “dual-format dispatch” has no
reason to retain those compatibility behaviors.

**Improve.** Replace the old function-by-function section with an outcomes-only
legacy-import subsection: canonicalization that succeeds, syntax preserved with
non-blocking warnings, and blocking structural/contract failures. Name the
warning categories and the no-state-change rule. This retains the behavioral
part of 08-8 and the corrected 08-9 behavior without carrying dead mechanics.

### D4 — Serializer detail should be reduced, not outsourced entirely

**Claim.** One behavioral line pointing to the serializer decision is enough.

**What breaks first if wrong.** A future serializer swap could retain the
library name while changing YAML-version/scalar semantics, aliases, newline
normalization, or output determinism. Those are cross-language wire properties,
not merely internal implementation. Conversely, byte-identical formatting,
flow-style arrays, and custom tag machinery are not requirements of the
Workspace contract and should not be preserved from the old section.

**Improve.** Keep one concise, testable contract in 08 or its format contract:
YAML 1.2, literal/no-alias output, deterministic document order, one trailing
newline, and value-preserving parsing by the Python contract. Link to the
serializer decision for rationale and guardrails. Explicitly retire
byte-identical reserialization, leaf-array style, and bespoke tag behavior.

## Gaps and ambiguities

### G1 — Cross-references need a local “load map” for a repo-canonical spec

**Claim.** DL12, DL13, C1, and FR-SL-02b can carry backup freshness, load
safety, schema, and uncredited-LEAVE behavior by reference.

**What breaks first if wrong.** A `/docs` reader cannot depend on Traycer-local
decision-log paths, and an agent chasing several links can miss which document
is normative for a concrete action. The plan prevents file-reference rot but
can replace it with reference-graph rot.

**Improve.** Keep cross-references for rationale, but add an 08-owned summary
of the externally observable rule at each boundary: which action records a
durable backup (plain Download only), that Copy/anonymised Download do not,
that Start Over cancels staged load/edit state, and that an uncredited-LEAVE
condition warns but does not block import. Before the `/docs` move, publish or
co-locate every normative dependency and use repository-relative links.

### G2 — Audit closure is not yet demonstrable from the planned structure

**Claim.** The Correct/Preserve/Drop lists close the audit's confirmed 08 drift.

**What breaks first if wrong.** A near-rewrite can still omit a minor but
observable correction: 1500 ms copy feedback; `Current state · YAML`; the three
anonymise labels and defaults; static filenames and `text/yaml`; toast/inline
issue layering; and the three version cases. The audit also says 08-11 was
refuted because the relevant validation already lives in a sibling artifact,
which makes it especially easy either to delete a necessary behavior or
duplicate it inconsistently.

**Improve.** Add an audit-to-requirement closure checklist to the drafting plan:
one destination requirement/acceptance test or an explicit rationale for every
08-1 through 08-12. Treat 08-11 as “retain sibling ownership and link it,” not
as a correction. Include the `appVersion` value as a file metadata field whose
classification is defined, without leaking build-tool implementation.

### G3 — Altitude is right; acceptance evidence still needs durable invariants

**Claim.** Behavior plus data contracts, with no source citations, is sufficient
for a future implementation or verification.

**What breaks first if wrong.** Removing code anchors avoids the known rot, but
without focused acceptance criteria a reviewer cannot detect loss of disabled
records, stable preference/request identities, Guided pins, null dates, or
non-mutating anonymisation. These contracts presently live partly in code and
would otherwise be lost.

**Improve.** Keep the no-code-citation convention, and replace each removed
anchor with a Given/When/Then contract. At minimum cover Workspace
Download→Load losslessness, legacy load's no-pin-but-full-rule projection,
replacement cancellation, and anonymised export preserving workspace metadata
while never mutating live state. That is implementation-independent evidence,
not an implementation reference.
