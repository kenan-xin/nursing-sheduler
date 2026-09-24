"use client";

// After Apply: open the screen that owns the change and point at what changed.
//
// HOST NARRATION, NOT A MODEL TURN. Everything here is the app's: the plan comes from
// the Preview's host-derived diff, the navigation is the host's guarded navigation,
// and the words are this file's. Asking the model to narrate would send a provider
// request the user did not make, about a result the model cannot observe.
//
// A SIBLING OF THE TRANSCRIPT, like the Preview and the receipts: it is live state
// with live buttons, so it is mounted only in the live conversation.
//
// FOCUS STAYS PUT. Navigation runs with `reveal: false`, so the destination's first
// control is not focused; the live region says what happened and the changed rows
// are scrolled into view instead. The scroll passes no `behavior`, so it is instant
// and honours prefers-reduced-motion without a check here.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/ui/surface";
import { CAPABILITY_UNAVAILABLE, resolveCapability } from "@/lib/capability/resolve";
import { leavesLiveRun } from "@/lib/optimize/run-request";
import { useHotStore } from "@/lib/store";
import {
  planChangeHighlight,
  type ChangeHighlightPlan,
  type ChangeScreen,
} from "@/lib/change-highlight/plan";
import {
  CHANGE_HIGHLIGHT_SELECTOR,
  clearChangeHighlight,
  showChangeHighlight,
} from "@/lib/change-highlight/store";
import { readCapabilityContext } from "./capability-context";
import { useCapabilityNavigation } from "./use-capability-navigation";
import type { AssistantProposalController } from "./use-assistant-proposals";

export interface ApplyStep {
  screen: ChangeScreen;
  status: "opening" | "shown" | "stayed" | "run-live" | "failed";
}

export function describeStep({ screen, status }: ApplyStep): string {
  const what = screen.announcement ? ` ${screen.announcement}.` : "";
  switch (status) {
    case "opening":
      return `Opening ${screen.label}…`;
    case "shown":
      return `Opened ${screen.label}.${what}`;
    case "stayed":
      return `Stayed here so your unsaved edit is kept. The change is on ${screen.label}.${what}`;
    case "run-live":
      return `Stayed here so the optimiser run keeps going. The change is on ${screen.label}.${what}`;
    case "failed":
      return `${screen.label} could not be opened.${what}`;
  }
}

export function ApplyNavigationNotice({ controller }: { controller: AssistantProposalController }) {
  const navigate = useCapabilityNavigation();
  const [plan, setPlan] = useState<ChangeHighlightPlan | null>(null);
  const [step, setStep] = useState<ApplyStep | null>(null);
  const handled = useRef<string | null>(null);
  // Bumped by anything that should make an in-flight show() a no-op on arrival:
  // Done, a second link click, or the receipt it was about being undone.
  const showToken = useRef(0);
  const { outcome } = controller;

  const show = useCallback(
    async (screen: ChangeScreen) => {
      const token = ++showToken.current;
      setStep({ screen, status: "opening" });
      // The user's Apply (or link) click is its own authority, so no turn check. An
      // open unsaved draft still gets the shell's confirm, like a manual jump.
      const result = await navigate(screen.capabilityId, { reveal: false });
      if (token !== showToken.current) return;
      if (result.status === CAPABILITY_UNAVAILABLE) {
        setStep({
          screen,
          status: result.reason === "navigation_cancelled" ? "stayed" : "failed",
        });
        return;
      }
      showChangeHighlight(screen.keys);
      // After the rows re-render with the attribute. The requests matrix scrolls its
      // own virtualizer; this covers every non-virtualized screen.
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(CHANGE_HIGHLIGHT_SELECTOR)
          ?.scrollIntoView?.({ block: "center" });
      });
      setStep({ screen, status: "shown" });
    },
    [navigate],
  );

  useEffect(() => {
    if (outcome?.kind === "applied" && handled.current !== outcome.receiptId) {
      handled.current = outcome.receiptId;
      const next = planChangeHighlight(outcome.diff, readCapabilityContext().mode);
      setPlan(next);
      setStep(null);
      if (!next.primary) return;
      // Leaving Optimise stops a live run. The user pressed Apply, not a screen link,
      // so the host does not make that move for them; the links below still can.
      const target = resolveCapability(next.primary.capabilityId, readCapabilityContext());
      const routeId = target.status === "ok" ? target.value.routeId : undefined;
      if (leavesLiveRun(useHotStore.getState().runView.lifecycle, routeId)) {
        setStep({ screen: next.primary, status: "run-live" });
        return;
      }
      void show(next.primary);
      return;
    }
    // The receipt this notice was showing was undone, or a later Preview that
    // appeared after Apply was cancelled or withdrawn: either way the outcome no
    // longer names the applied receipt, so the notice's claims are no longer true.
    if (outcome?.kind !== "applied" && handled.current !== null) {
      handled.current = null;
      showToken.current++;
      setPlan(null);
      setStep(null);
      clearChangeHighlight();
    }
  }, [outcome, show]);

  // A new Preview replaces this notice; the user is reviewing the next change now.
  const visible = plan !== null && controller.proposal === null;
  const screens = plan ? [plan.primary, ...plan.others].filter((s): s is ChangeScreen => !!s) : [];
  const current = step && (step.status === "shown" || step.status === "opening") ? step : null;
  const links = screens.filter((s) => s.capabilityId !== current?.screen.capabilityId);

  return (
    <>
      {/* Always mounted: a region that appears with its text already inside is not
          reliably announced. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="apply-navigation-status">
        {visible && step ? describeStep(step) : ""}
      </p>
      {visible ? (
        <Surface
          level="well"
          geometry="control"
          className="mx-3 mb-2 flex shrink-0 flex-col gap-2 p-3"
          data-testid="apply-navigation"
          aria-label="Where the change is"
        >
          <ol className="flex flex-col gap-0.5 text-meta text-ink2">
            <li>Change applied.</li>
            {step ? <li data-testid="apply-navigation-step">{describeStep(step)}</li> : null}
          </ol>
          {links.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-meta text-ink3">Show changes on:</span>
              {links.map((screen) => (
                <Button
                  key={screen.capabilityId}
                  variant="outline"
                  size="sm"
                  data-testid="apply-navigation-link"
                  data-capability-id={screen.capabilityId}
                  onClick={() => void show(screen)}
                >
                  {screen.announcement ? `${screen.label} (${screen.announcement})` : screen.label}
                </Button>
              ))}
            </div>
          ) : null}
          <div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="apply-navigation-done"
              onClick={() => {
                showToken.current++;
                setPlan(null);
              }}
            >
              Done
            </Button>
          </div>
        </Surface>
      ) : null}
    </>
  );
}
