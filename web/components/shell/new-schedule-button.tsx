"use client";

// Start-over card (T08, acceptance row 3 / MINOR 8). The primary reset affordance
// lives in Save & Load — not the top bar — inside a "Start over" section with
// explanatory backup copy and a destructive (error-outline) treatment, matching
// the prototype (ScreenSaveLoad.dc.html:50-58). On confirm it calls the verified
// full reset, `resetToNewSchedule`: the roster/candidate/snapshot/session/marker
// and capture cleanup first, and only once that is proven, the T04 scenario reset
// (drop the persisted record, replace every scenario slice with the empty default,
// clear undo history, reset the hot store).
//
// F2 owns this file's PRESENTATION only, and is its sole visual owner before F4 —
// R1 and R7 consume it without editing it. v2 reading (ScreenSaveLoad.dc.html:50-58):
// an ordinary L1 card with a header band, and the destructive signal carried by the
// ACTION rather than by an error border drawn around the whole card. The button is
// the shared `destructive-outline` Button variant, so its error tone and its 44px
// coarse-pointer target come from the primitive instead of a local class override.
//
// G4 closure — the confirmed reset now goes through `resetToNewSchedule`, which
// runs the existing verified roster/stored-data cut BEFORE the scenario reset. So
// `New schedule` genuinely leaves the previous run behind (no surviving roster,
// candidate, capture state or session record, and therefore no stale capture
// notice on Optimize), and it fails closed: an unverified cut changes nothing and
// reports plainly instead of claiming `New schedule created`. `onResetComplete` is
// called only on a real reset.
//
// F07 — the card also offers a realistic example ward. The example is deliberately
// NOT a second reset protocol: it fetches the bundled YAML and hands it to the SAME
// inbound pipeline the Upload modal and Edit-YAML use (`useScenarioImport` →
// `prepareScenarioLoad` → replacement/version confirm → `loadScenario`), so the
// confirmation, the V-issue list and the advanced-syntax warnings are the shared
// ones, and a normal import replaces the SCENARIO only — no invented residue cut.
// The `New schedule` action keeps `resetToNewSchedule` exactly as before.

import { useState } from "react";
import { NEW_SCHEDULE_FAILED_MESSAGE, resetToNewSchedule } from "@/lib/roster";
import { ConfirmDialog } from "./confirm-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { surfaceVariants } from "@/components/ui/surface";
import { FaFileCirclePlus, FaSpinner, FaUsers } from "@/components/icons";
import { ImportWarningsBanner } from "@/components/save-load/import-warnings-banner";
import { ScenarioIssuesList } from "@/components/save-load/scenario-issues-list";
import { VersionConfirmModal } from "@/components/save-load/version-confirm-modal";
import { useScenarioImport } from "@/components/save-load/use-scenario-import";

/** The realistic 87-person November 2025 ward, shipped as a same-origin static file. */
export const EXAMPLE_SCHEDULE_PATH = "/examples/large-ward-with-87-people-2025-11.yaml";

/**
 * The example-load failure message. Like {@link NEW_SCHEDULE_FAILED_MESSAGE} it is a
 * constant, not built from the cause: a fetch can fail for reasons that are all
 * internal (offline, a 404, a truncated response), and naming any of them would leak
 * protocol vocabulary. It says what did not happen and what is still true.
 */
export const EXAMPLE_SCHEDULE_FAILED_MESSAGE =
  "The example schedule could not be loaded. Your current schedule has been kept.";

/** Fetch the bundled example through the same-origin static path. */
async function fetchBundledExampleSchedule(): Promise<string> {
  const response = await fetch(EXAMPLE_SCHEDULE_PATH);
  if (!response.ok) {
    throw new Error(`Example schedule request failed with status ${response.status}`);
  }
  return response.text();
}

export interface StartOverCardProps {
  onResetComplete?: () => void;
  /** Runs after a committed example load, so the caller can close its own editors. */
  onExampleLoaded?: () => void;
  /**
   * Test seam for the reset authority. Production uses the real one; a proof can
   * drive the failed-cleanup branch without breaking the browser's storage.
   */
  resetNewSchedule?: typeof resetToNewSchedule;
  /** Test seam for the bundled example fetch. Production fetches the static YAML. */
  fetchExampleSchedule?: () => Promise<string>;
}

export function StartOverCard({
  onResetComplete,
  onExampleLoaded,
  resetNewSchedule,
  fetchExampleSchedule,
}: StartOverCardProps) {
  const [open, setOpen] = useState(false);
  const [exampleBusy, setExampleBusy] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const reset = resetNewSchedule ?? resetToNewSchedule;

  // The shared inbound pipeline (T17b-3): one instance for the example, mirroring the
  // workspace's own for Upload/Edit-YAML. Its staged confirmation, V-issues and
  // warnings are rendered below rather than forked into a second protocol.
  const { issues, confirm, warnings, dismissWarnings, handleFile } = useScenarioImport({
    onCommitted: () => onExampleLoaded?.(),
  });

  const loadExample = async () => {
    setExampleError(null);
    setExampleBusy(true);
    try {
      handleFile(await (fetchExampleSchedule ?? fetchBundledExampleSchedule)());
    } catch {
      setExampleError(EXAMPLE_SCHEDULE_FAILED_MESSAGE);
    } finally {
      setExampleBusy(false);
    }
  };

  const handleConfirm = async () => {
    // The verified roster/stored-data cut FIRST, then the scenario reset — and the
    // outcome is BRANCHED ON, not merely awaited. Both halves fail closed: nothing is
    // announced as done unless both succeeded, and the retry path is this same button.
    //
    // INTEGRATION (T03): the scenario half is now a repository command, so a refusal
    // arrives as a resolved outcome carrying a reason rather than as a throw.
    // `not-owner` is the one a user can act on — another tab holds the lease — so it
    // keeps its own message instead of being flattened into the generic one.
    const outcome = await reset();
    if (outcome.status !== "reset") {
      toast.error(
        outcome.scenarioReason === "not-owner"
          ? "This schedule is being edited in another tab. Take over editing, then start over."
          : NEW_SCHEDULE_FAILED_MESSAGE,
      );
      return;
    }
    onResetComplete?.();
    toast.success("New schedule created");
  };

  return (
    <section
      data-testid="start-over-card"
      className={cn(
        "flex flex-col overflow-hidden",
        surfaceVariants({ role: "surface", geometry: "card" }),
      )}
    >
      {/* Header band — a single bottom edge, so it stays square inside the card. */}
      <div className="flex flex-col gap-1 border-b border-line2 px-5 py-4">
        <h2 className="font-heading text-title font-semibold tracking-[-0.015em]">Start over</h2>
        <p className="max-w-[60ch] text-meta text-ink2">
          Start a new schedule: begin empty, or load the realistic 87-person November 2025 example.
          Starting empty removes everything saved in this browser and cannot be undone — download a
          copy first if you want to keep it.
        </p>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            variant="destructive-outline"
            onClick={() => setOpen(true)}
            data-testid="new-schedule-button"
          >
            <FaFileCirclePlus aria-hidden />
            New schedule
          </Button>
          {/* `secondary`, not destructive: loading the example replaces the scenario
              through the ordinary (undoable) import path, so it is not the
              irreversible reset the sibling action is. */}
          <Button
            variant="secondary"
            onClick={() => void loadExample()}
            disabled={exampleBusy}
            data-testid="new-schedule-example"
          >
            {exampleBusy ? (
              <FaSpinner className="animate-spin-slow" aria-hidden />
            ) : (
              <FaUsers aria-hidden />
            )}
            {exampleBusy ? "Loading example…" : "87-person example"}
          </Button>
        </div>
        {exampleError ? (
          <p
            role="alert"
            data-testid="new-schedule-example-error"
            className="rounded-control border border-error bg-errortint p-3 text-meta text-errorink"
          >
            {exampleError}
          </p>
        ) : null}
        {issues ? <ScenarioIssuesList issues={issues} /> : null}
        {warnings ? <ImportWarningsBanner warnings={warnings} onDismiss={dismissWarnings} /> : null}
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Start over?"
        description="This clears your entire current schedule and starts a new, empty one. It cannot be undone."
        confirmLabel="Start over"
        cancelLabel="Cancel"
        variant="destructive"
        consequences={[
          "All people, shift types and dates",
          "Every rule and request",
          "Your export layout",
          "The saved roster and the last run's result",
        ]}
        onConfirm={handleConfirm}
      />
      {/* The example's staged replacement/version confirmation — the same modal the
          Upload and Edit-YAML entry points render from their own pipeline instance. */}
      {confirm ? (
        <VersionConfirmModal
          open
          onOpenChange={(next) => {
            if (!next) confirm.onCancel();
          }}
          title={confirm.title}
          description={confirm.description}
          onContinue={confirm.onContinue}
        />
      ) : null}
    </section>
  );
}
