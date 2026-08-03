// T16e — the Optimize screen's inline callout, following the repo's banner recipe
// (full border + semantic tint + a leading status icon), not a new component
// language. One small primitive keeps the readiness, version, recovery, terminal,
// and error notices visually consistent with the rest of the app.
//
// R6 v2: a callout is an inset ISLAND inside an L1 card, not a full-bleed band,
// so it takes `--r-ctl` (DESIGN.md §5 "inner bordered boxes") rather than staying
// square. The neutral `info` tone is the canonical well — `--panel` + `--sh-well`
// + a `--line2` hairline (§4). Each status tone pairs its tint with the MATCHING
// semantic ink for BOTH title and body (the Redundant Signal Rule): v1 painted
// status tints with neutral `--ink`/`--ink2`, which reads as an unrelated grey
// note in dark mode, where the base and ink tiers diverge. The leading icon keeps
// the BASE tier, which §2 defines as "text or icon on its own tint".

import type { ReactNode } from "react";
import {
  FaCircleCheck,
  FaCircleExclamation,
  FaCircleInfo,
  FaTriangleExclamation,
  type IconType,
} from "@/components/icons";
import { cn } from "@/lib/utils";

export type CalloutTone = "info" | "warn" | "error" | "success";

interface CalloutToneSpec {
  container: string;
  icon: string;
  title: string;
  body: string;
  defaultIcon: IconType;
}

const TONE: Record<CalloutTone, CalloutToneSpec> = {
  info: {
    container: "rounded-control border-line2 bg-panel shadow-well",
    icon: "text-ink3",
    title: "text-ink",
    body: "text-ink2",
    defaultIcon: FaCircleInfo,
  },
  warn: {
    container: "rounded-control border-warn bg-warntint",
    icon: "text-warn",
    title: "text-warnink",
    body: "text-warnink",
    defaultIcon: FaTriangleExclamation,
  },
  error: {
    container: "rounded-control border-error bg-errortint",
    icon: "text-error",
    title: "text-errorink",
    body: "text-errorink",
    defaultIcon: FaCircleExclamation,
  },
  success: {
    container: "rounded-control border-success bg-successtint",
    icon: "text-success",
    title: "text-successink",
    body: "text-successink",
    defaultIcon: FaCircleCheck,
  },
};

export interface CalloutProps {
  tone?: CalloutTone;
  icon?: IconType;
  title?: ReactNode;
  children?: ReactNode;
  /** Trailing actions (buttons/links), aligned to the callout's end. */
  actions?: ReactNode;
  /** Announce assertively via `role="alert"` (errors and blocked states). */
  alert?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function Callout({
  tone = "info",
  icon,
  title,
  children,
  actions,
  alert = false,
  className,
  "data-testid": testId,
}: CalloutProps) {
  const spec = TONE[tone];
  const Icon = icon ?? spec.defaultIcon;
  return (
    <div
      data-testid={testId}
      data-slot="callout"
      data-tone={tone}
      role={alert ? "alert" : undefined}
      className={cn("flex items-start gap-2.5 border p-3.5", spec.container, className)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", spec.icon)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        {title ? (
          <div data-slot="callout-title" className={cn("text-meta font-semibold", spec.title)}>
            {title}
          </div>
        ) : null}
        {children ? (
          <div data-slot="callout-body" className={cn("text-meta", spec.body)}>
            {children}
          </div>
        ) : null}
        {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
      </div>
    </div>
  );
}
