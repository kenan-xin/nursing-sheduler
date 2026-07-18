// Shared V-issues renderer (T17a-4). Both the Scenario-file card and the
// read-only YAML preview surface the exact same `ScenarioValidationIssue[]`
// from `prepareExport` on an invalid draft — this is the one place that list
// is rendered, so the two surfaces cannot drift in wording or styling.

import type { ScenarioValidationIssue } from "@/lib/scenario";
import { FaTriangleExclamation } from "@/components/icons";

export function ScenarioIssuesList({ issues }: { issues: ScenarioValidationIssue[] }) {
  return (
    <div
      className="border border-error bg-errortint p-3 text-meta text-ink"
      data-testid="scenario-export-issues"
    >
      <div className="mb-1.5 flex items-center gap-2 font-semibold text-error">
        <FaTriangleExclamation className="size-3.5" aria-hidden />
        {issues.length} issue{issues.length === 1 ? "" : "s"} must be fixed before this scenario can
        be saved.
      </div>
      <ul className="list-disc space-y-1 pl-5 text-ink2">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>
            {issue.path ? (
              <span className="font-mono text-label text-ink3">{issue.path}: </span>
            ) : null}
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
