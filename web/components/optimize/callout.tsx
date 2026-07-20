// T16e — the Optimize screen's inline callout, following the repo's banner recipe
// (full border + semantic tint + a leading status icon), not a new component
// language. One small primitive keeps the readiness, version, recovery, terminal,
// and error notices visually consistent with the rest of the app.

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

const TONE: Record<CalloutTone, { container: string; icon: string; defaultIcon: IconType }> = {
  info: { container: "border-line bg-panel", icon: "text-ink3", defaultIcon: FaCircleInfo },
  warn: {
    container: "border-warn bg-warntint",
    icon: "text-warn",
    defaultIcon: FaTriangleExclamation,
  },
  error: {
    container: "border-error bg-errortint",
    icon: "text-error",
    defaultIcon: FaCircleExclamation,
  },
  success: {
    container: "border-success bg-successtint",
    icon: "text-success",
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
      role={alert ? "alert" : undefined}
      className={cn("flex items-start gap-2.5 border p-3.5", spec.container, className)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", spec.icon)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        {title ? <div className="text-meta font-semibold text-ink">{title}</div> : null}
        {children ? <div className="text-meta text-ink2">{children}</div> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
      </div>
    </div>
  );
}
