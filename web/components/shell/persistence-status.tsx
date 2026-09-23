"use client";

// Persistence status affordance (T08, MAJOR 6; rebased onto repository authority
// in T03). The shell promises browser auto-save; this makes that promise
// observable with an honest, stateful signal instead of an unconditional
// "is saved".
//
// The four states are unchanged, but they are now READ rather than inferred:
//   • restoring   — authority bring-up is still resolving
//   • saving      — a repository transaction is in flight
//   • saved       — the last transaction committed (prototype green ● SAVED)
//   • error       — the last transaction failed, and is surfaced, not swallowed
//
// The pre-T03 controller had to INFER all of this: it subscribed to every store
// `setState`, assumed the persist middleware had enqueued a write, drained the
// write queue, and read a self-clearing error flag — with a monotonic token to
// stop an older write settling after a newer one. None of that is needed now. A
// command's own transaction reports its outcome, and the controller publishes it,
// so the badge can no longer say "Saved" about a write that never happened.

import { useHotStore, useAuthorityStore, type WriteStatus } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { FaSpinner } from "@/components/icons";

export type PersistenceStatus = "restoring" | "saving" | "saved" | "error";

/**
 * Fold the hydration lifecycle and the repository write status into the one
 * status the shell shows. Bring-up wins: while authority is still resolving there
 * is nothing meaningful to say about a write.
 *
 * A pure function so the mapping is testable without mounting React or a store.
 */
export function resolvePersistenceStatus(
  hydrationStatus: "unhydrated" | "hydrating" | "ready" | "recoverable-error",
  writeStatus: WriteStatus,
): PersistenceStatus {
  if (hydrationStatus === "unhydrated" || hydrationStatus === "hydrating") return "restoring";
  if (hydrationStatus === "recoverable-error") return "error";
  switch (writeStatus) {
    case "writing":
      return "saving";
    case "error":
      return "error";
    default:
      // `idle` means no command has run yet, which — once bring-up succeeded — is
      // exactly the "whatever is on screen is what is stored" state.
      return "saved";
  }
}

/** Synchronous read of the current persistence status (T08b's beforeunload guard
 *  arms on `saving`/`error` alongside a losable draft). */
export function getPersistenceStatus(): PersistenceStatus {
  return resolvePersistenceStatus(
    useHotStore.getState().hydrationStatus,
    useAuthorityStore.getState().writeStatus,
  );
}

/** Reactive read of the same derivation, for the two badges below. */
function usePersistenceStatus(): PersistenceStatus {
  const hydrationStatus = useHotStore((s) => s.hydrationStatus);
  const writeStatus = useAuthorityStore((s) => s.writeStatus);
  return resolvePersistenceStatus(hydrationStatus, writeStatus);
}

/**
 * Retained as the shell's mount point for this surface. The status is now derived
 * from state the command bus already publishes, so there is nothing to subscribe
 * or settle here — the hook stays so the hydration gate's controller list (and its
 * tests) keep one obvious place to look.
 */
export function usePersistenceStatusController(): void {}

const LABEL: Record<PersistenceStatus, string> = {
  restoring: "Restoring",
  saving: "Saving",
  saved: "Saved",
  error: "Save failed",
};

// F2 owns this file's PRESENTATION only, and is its sole visual owner before F4 —
// R1 and R7 consume both surfaces below without editing them.
//
// v2 status surfaces ARE Badges: each state picks the semantic tier, and the shared
// primitive pairs that tint with its MATCHING ink and border (every pair clears AA
// in both themes, the tightest being warn at 4.88:1). Mapping state onto the shared
// vocabulary is what lets this presenter stop authoring its own tone classes.
const VARIANT: Record<PersistenceStatus, "neutral" | "success" | "error"> = {
  restoring: "neutral",
  saving: "neutral",
  saved: "success",
  error: "error",
};

// DESIGN.md §5 retires decorative ornament on status — no check glyphs, no coloured
// leader dots; the label text plus the semantic tint/ink/border triple carries the
// state, and the prototype's own SAVED badge is text-only
// (ScreenSaveLoad.dc.html:87). The in-flight spinner is KEPT because it reports
// ACTIVITY, which neither static text nor a hue can express, and it inherits the
// badge's ink rather than introducing a second colour.
function StatusMark({ status }: { status: PersistenceStatus }) {
  if (status !== "restoring" && status !== "saving") return null;
  return <FaSpinner className="animate-spin-slow" aria-hidden />;
}

// Compact top-bar status chip (the "compact secondary status surface" of MAJOR 5).
export function PersistenceStatus() {
  const status = usePersistenceStatus();
  return (
    <Badge
      data-testid="persistence-status"
      data-status={status}
      role="status"
      variant={VARIANT[status]}
      className="hidden sm:inline-flex"
    >
      <StatusMark status={status} />
      {LABEL[status]}
    </Badge>
  );
}

// Fuller badge for the Save & Load surface — mirrors the prototype's green
// ● SAVED confirmation, but stays honest across the other three states. NOT a
// live region (T08a): the top bar's compact `PersistenceStatus` is the shell's
// one live `role="status"` announcement, so a second live surface on the same
// underlying state would double-announce to assistive tech. This badge is
// static explanatory copy that happens to re-render on status change.
export function PersistenceBadge() {
  const status = usePersistenceStatus();
  return (
    <Badge
      data-testid="persistence-badge"
      data-status={status}
      variant={VARIANT[status]}
      className="gap-2 px-3 py-1.5"
    >
      <StatusMark status={status} />
      {LABEL[status]}
    </Badge>
  );
}
