"use client";

// T16e — required-data readiness banner. Points the user at the Dates/People/Shift
// Types editors through the shell's guarded link so an in-app hop still stages the
// navigation guard. Renders nothing when the schedule is ready.

import { GuardedLink } from "@/components/shell/guarded-link";
import type { OptimizeReadinessIssue } from "@/lib/optimize";
import { Callout } from "./callout";

export interface ReadinessBannerProps {
  issues: OptimizeReadinessIssue[];
}

export function ReadinessBanner({ issues }: ReadinessBannerProps) {
  if (issues.length === 0) return null;
  return (
    <Callout
      tone="warn"
      data-testid="optimize-readiness"
      title="Finish setting up your schedule before optimizing"
    >
      <ul className="list-disc space-y-1 pl-[18px]">
        {issues.map((issue) => (
          <li key={issue.kind}>
            {issue.before}
            <GuardedLink
              href={issue.href}
              className="font-semibold text-brandink underline underline-offset-2 hover:no-underline"
            >
              {issue.linkLabel}
            </GuardedLink>
            {issue.after}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
