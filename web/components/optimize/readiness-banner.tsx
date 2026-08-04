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
      <ul className="list-disc space-y-1 pl-5">
        {issues.map((issue) => (
          <li key={issue.kind}>
            {issue.before}
            {/* D10 coarse-pointer floor. An inline `<a>` is measured height-only by
                F4's target battery, and a bare inline box is one line tall, so the
                link becomes an inline-flex box that can carry `min-h-touch` on a
                coarse pointer. Width stays intrinsic so the sentence still reads as
                prose (the R3 P4 backlog owns any precise-pointer change). */}
            <GuardedLink
              href={issue.href}
              className="inline-flex items-center font-semibold text-brandink underline underline-offset-2 pointer-coarse:min-h-touch hover:no-underline"
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
