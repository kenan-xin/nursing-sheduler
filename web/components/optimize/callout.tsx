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
//
// R6 Round 9B — `placement` names WHERE on the surface ladder the callout is
// mounted, because the neutral tone's correct treatment depends on it. §4 gives
// L0 no free-floating children and seats note strips "*inside* an L1 card", so a
// neutral well rendered straight onto the page plane is a ladder violation: it is
// a recessed plane with no plane to be recessed INTO. A page-mounted neutral
// notice therefore takes the L1 role instead — `--surface`, a `--line` edge and
// the outer `--sh-1`, on the card radius, exactly like every other top-level
// container on the route. The status tones are unchanged at either placement:
// their tint plus a matching semantic border is already a self-contained banner,
// and it is the treatment the prototype itself authors for a page-level notice
// (ScreenSaveLoad.dc.html:19, ScreenExport.dc.html:20, ScreenRequests.dc.html:21).
// See DESIGN.md §1's deviation matrix for the recorded prototype divergence.

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

/**
 * Where on the surface ladder this callout is mounted.
 *
 * `inset` (the default) is the canonical island INSIDE an L1 card. `page` is a
 * callout mounted directly on the L0 page plane, as a sibling of the route's
 * cards — see the file header for why the neutral tone cannot stay a well there.
 */
export type CalloutPlacement = "inset" | "page";

interface CalloutToneSpec {
  /** Container treatment as an inset island inside an L1 card. */
  container: string;
  /**
   * Container treatment when mounted directly on L0. Declared only by the tones
   * whose ladder position actually changes — which is the neutral one, because a
   * well needs a host plane. A tone that omits it keeps `container` verbatim,
   * which states that its tint-plus-semantic-border IS its page treatment rather
   * than leaving the answer implicit.
   */
  pageContainer?: string;
  icon: string;
  title: string;
  body: string;
  defaultIcon: IconType;
}

const TONE: Record<CalloutTone, CalloutToneSpec> = {
  info: {
    container: "rounded-control border-line2 bg-panel shadow-well",
    // The L1 role from DESIGN.md §4, on the card radius — the same rung every
    // other top-level container on this route sits at. Deliberately NOT the
    // `surfaceVariants` recipe: `surface-contract.test.ts` treats every class
    // string combined with a recipe result as a consumer className and admits
    // only layout utilities there, so importing the recipe here would make this
    // file's own tone table illegal. The tokens are the recipe's, verbatim.
    pageContainer: "rounded-card border-line bg-surface shadow-1",
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
  /** Ladder position of the mount point. Defaults to an inset island in an L1 card. */
  placement?: CalloutPlacement;
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
  placement = "inset",
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
  const container = placement === "page" ? (spec.pageContainer ?? spec.container) : spec.container;
  return (
    <div
      data-testid={testId}
      data-slot="callout"
      data-tone={tone}
      data-placement={placement}
      role={alert ? "alert" : undefined}
      className={cn("flex items-start gap-2.5 border p-3.5", container, className)}
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
