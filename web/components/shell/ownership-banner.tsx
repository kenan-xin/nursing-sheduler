"use client";

// Single-writer ownership surface (T03).
//
// A scenario has exactly one writer at a time. A second tab on the SAME scenario
// is read-only until someone explicitly takes over — and this banner is the only
// place that fact is stated, so a user never discovers it by having an edit
// silently refused.
//
// Three things it deliberately does:
//
//   • It NAMES the state rather than just disabling controls. "Nothing happens
//     when I click" is indistinguishable from a bug.
//   • Takeover is an explicit, warned action, never automatic. Seizing the lease
//     immediately stops the other tab from saving, which is a real consequence
//     for whoever is sitting in front of it.
//   • It distinguishes "someone else has it" from "your own hold lapsed", because
//     those need different words: the second is usually a suspended laptop, not
//     a colleague.
//
// VISUAL LANGUAGE. A page-mounted status banner, the same treatment DESIGN.md §1's
// deviation matrix names for `ImportWarningsBanner`: semantic tint, matching
// border and ink, card radius, and the shared `Button` for the action so it
// inherits the pill geometry and the coarse-pointer target floor. No new visual
// vocabulary is introduced for it.

import { useState } from "react";
import { toast } from "sonner";
import { scenarioCommands, useAuthorityStore, type ScenarioOwnership } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "./confirm-dialog";
import { FaTriangleExclamation } from "@/components/icons";

interface OwnershipCopy {
  title: string;
  body: string;
  confirmTitle: string;
  confirmDescription: string;
}

/** The user-facing wording for each non-owning state. */
function copyFor(ownership: ScenarioOwnership): OwnershipCopy | null {
  switch (ownership) {
    case "read-only":
      return {
        title: "Read-only — open in another tab",
        body:
          "This schedule is being edited in another browser tab, so changes are turned off here. " +
          "You can still look through everything.",
        confirmTitle: "Edit here instead?",
        confirmDescription:
          "The other tab will stop being able to save. Anything it has open but has not saved " +
          "will be lost.",
      };
    case "taken-over":
      return {
        title: "Editing moved to another tab",
        body:
          "Another tab took over editing this schedule, so changes are turned off here. " +
          "Everything saved up to that point is safe.",
        confirmTitle: "Take editing back?",
        confirmDescription:
          "The other tab will stop being able to save. Anything it has open but has not saved " +
          "will be lost.",
      };
    case "expired":
      return {
        title: "Editing paused",
        body:
          "This tab lost its hold on the schedule — usually after the computer slept or the tab " +
          "was inactive for a while. Everything saved before that is safe.",
        confirmTitle: "Resume editing?",
        confirmDescription:
          "Editing will resume in this tab. If another tab picked the schedule up in the " +
          "meantime, it will stop being able to save.",
      };
    default:
      return null;
  }
}

// The banner is page-mounted above the app content, so it carries its own gutter
// rather than being wrapped — an owning tab must cost no layout at all, and an
// always-present wrapper would leave a gap on every ordinary session.
const BANNER_CLASS =
  "mx-4 mt-4 flex items-start gap-2.5 rounded-card border border-warn bg-warntint p-3.5";

/**
 * Renders nothing while this tab owns the scenario — the ordinary case must cost
 * no layout at all.
 */
export function OwnershipBanner() {
  const ownership = useAuthorityStore((s) => s.ownership);
  const reloadRequired = useAuthorityStore((s) => s.reloadRequired);
  const [confirming, setConfirming] = useState(false);

  if (reloadRequired) {
    // The commit landed but the view could not be updated from it. Saying "save
    // failed" here would be a lie that invites a destructive retry.
    return (
      <div data-testid="ownership-banner" data-ownership="reload-required" className={BANNER_CLASS}>
        <FaTriangleExclamation className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-meta font-semibold text-warnink">Your change was saved</div>
          <p className="text-meta text-warnink">
            The screen could not be refreshed to match it. Reload the page to see the saved
            schedule.
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }

  const copy = copyFor(ownership);
  if (!copy) return null;

  return (
    <div
      data-testid="ownership-banner"
      data-ownership={ownership}
      role="status"
      className={BANNER_CLASS}
    >
      <FaTriangleExclamation className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-meta font-semibold text-warnink">{copy.title}</div>
        <p className="text-meta text-warnink">{copy.body}</p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="ownership-takeover"
        onClick={() => setConfirming(true)}
      >
        Edit here
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={copy.confirmTitle}
        description={copy.confirmDescription}
        confirmLabel="Edit here"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={async () => {
          const outcome = await scenarioCommands.takeover();
          if (outcome.ok) toast.success("You can now edit this schedule");
          else toast.error("Could not take over editing — try again");
        }}
      />
    </div>
  );
}
