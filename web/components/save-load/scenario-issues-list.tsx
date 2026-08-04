// Shared V-issues renderer (T17a-4). Both the Scenario-file card and the
// read-only YAML preview surface the exact same `ScenarioValidationIssue[]`
// from `prepareExport` on an invalid draft — this is the one place that list
// is rendered, so the two surfaces cannot drift in wording or styling.
//
// R7 v2: an inset ISLAND inside an L1 card, so it takes `--r-ctl` (DESIGN.md §5,
// "inner bordered boxes") rather than staying square. Heading and list move onto
// `--errorink`, the deepest semantic tier: v1 painted the errortint plane with a
// neutral `--ink2` list and a base-tier `--error` heading, so in dark mode — where
// the base and ink tiers diverge — the body read as unrelated grey text on a red
// wash. The leading icon keeps the BASE tier, which §2 defines as "text or icon on
// its own tint". The path prefix stays monospaced but inherits the semantic ink
// instead of overriding it with `--ink3`, which would opt a descendant back out of
// the pairing.

import type { ScenarioValidationIssue } from "@/lib/scenario";
import { FaTriangleExclamation } from "@/components/icons";

export function ScenarioIssuesList({ issues }: { issues: ScenarioValidationIssue[] }) {
  return (
    <div
      className="rounded-control border border-error bg-errortint p-3 text-meta text-errorink"
      data-testid="scenario-export-issues"
    >
      <div className="mb-1.5 flex items-center gap-2 font-semibold">
        <FaTriangleExclamation className="size-3.5 shrink-0 text-error" aria-hidden />
        {issues.length} issue{issues.length === 1 ? "" : "s"} must be fixed before this scenario can
        be saved.
      </div>
      <ul className="list-disc space-y-1 pl-5">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>
            {issue.path ? <span className="font-mono text-label">{issue.path}: </span> : null}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
