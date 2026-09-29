// Scenario lifecycle (T03): bring-up, New, Load, and reset — all of them
// repository transactions now.
//
// WHAT CHANGED, AND WHY IT SIMPLIFIED. The pre-T03 controller had to run two
// different replacement disciplines because zundo history and Zustand `persist`
// were separate mechanisms with separate failure modes: initialization used a
// paused-replace protocol so the replacement stayed out of undo history, while a
// confirmed Load was a tracked full-slice `setState` so Undo could restore the
// prior workspace.
//
// Both collapse into repository semantics:
//
//   • bring-up      — migrate the legacy record, reread this tab's persisted
//                     selection, acquire the lease when free, start a fresh Undo
//                     session, publish. Nothing is "replaced"; the projection is
//                     written FROM durable truth, so there is no history to keep
//                     it out of.
//   • New and Load  — atomic scenario SWITCHES. Each mints a new identity in one
//                     transaction that validates the old owner, acquires the
//                     target, records the switch, and releases the old lease.
//
// Load minting a new identity is what makes a restored file's history, receipts,
// and (later) threads its own rather than inherited — and it is why Undo does not
// reach back across a Load into a document this identity never contained.

import {
  type ImportNormalizationTarget,
  type ScenarioUiState,
  type UiRequestCell,
} from "@/lib/scenario";
import type { CommandOutcome } from "./authority";
import { getScenarioAuthority } from "./spine";
import type { HotStore } from "./hot-store";

/**
 * Give an imported card body durable store identity. A legacy import body has no
 * `uid`, so a fresh one is minted; a Workspace V1 body already carries its restored
 * `uid` (and `disabled` flag), which is preserved so a reloaded card keeps the
 * identity the file recorded.
 */
function hydrateCard<T extends { uid?: string }>(body: T): T & { uid: string } {
  return { ...body, uid: body.uid ?? crypto.randomUUID() };
}

/** Ensure a matrix cell carries a durable `uid` (a legacy import cell has none). */
function ensureCellUid(cell: UiRequestCell): UiRequestCell {
  return cell.uid ? cell : { ...cell, uid: crypto.randomUUID() };
}

/**
 * Hydrate an import target into durable UI state. Card and matrix-cell identity is
 * assigned where missing and preserved where restored. Every durable card/cell
 * ends up with a stable `uid`, so Workspace serialization never has to fall back
 * to a positional id.
 */
function hydrateImportTarget(target: ImportNormalizationTarget): ScenarioUiState {
  return {
    ...target,
    reqData: target.reqData.map(ensureCellUid),
    cardsByKind: {
      requirements: target.cardsByKind.requirements.map(hydrateCard),
      successions: target.cardsByKind.successions.map(hydrateCard),
      counts: target.cardsByKind.counts.map(hydrateCard),
      affinities: target.cardsByKind.affinities.map(hydrateCard),
      coverings: target.cardsByKind.coverings.map(hydrateCard),
    },
  };
}

/**
 * Client-only bring-up: run the one-time legacy migration, reread this tab's
 * persisted selection and lease, acquire the lease when it is free, start a fresh
 * Undo session, and publish the committed envelope.
 *
 * The hot store's `hydrationStatus` remains the shell's gate, so the existing
 * skeleton/error surfaces are unchanged. A failure here settles
 * `recoverable-error` rather than crashing, exactly as before — but the durable
 * record is left intact for the next attempt instead of being written over.
 *
 * BOUNDED, BUT NOT ABANDONED. Every await in bring-up is an IndexedDB transaction, and
 * IndexedDB queues one behind any overlapping readwrite transaction on any connection --
 * including one held by another tab that is hung or frozen. Nothing here can break that
 * lock, so past `stallAfterMs` the gate says so (`stalled`) instead of showing skeletons
 * forever. Bring-up keeps waiting underneath and settles normally once the lock clears;
 * nothing is written or discarded to get there.
 */
export async function initializeScenarioAuthority(
  hot: HotStore,
  { stallAfterMs = BRING_UP_STALL_MS }: { stallAfterMs?: number } = {},
): Promise<void> {
  hot.getState().setHydrationStatus("hydrating");
  const stall = setTimeout(() => hot.getState().setHydrationStatus("stalled"), stallAfterMs);
  try {
    await getScenarioAuthority().initialize();
    hot.getState().setHydrationStatus("ready");
  } catch {
    hot.getState().setHydrationStatus("recoverable-error");
  } finally {
    clearTimeout(stall);
  }
}

/** A healthy bring-up takes well under a second; this is "something is holding the database". */
export const BRING_UP_STALL_MS = 10_000;

/**
 * Load a scenario from a keyless import target: assign card/cell identity, then
 * switch to a FRESH scenario identity holding the imported content in one
 * transaction. The backup baseline is `null` (unknown) — an imported file is not a
 * fresh local backup — and the hot store is reset after the commit so scenario A's
 * transient state cannot leak into B.
 */
export function loadScenario(target: ImportNormalizationTarget): Promise<CommandOutcome> {
  return getScenarioAuthority().loadScenario(hydrateImportTarget(target));
}

/**
 * Apply an edited import target (Edit YAML) as ONE tracked, undoable edit on the
 * CURRENT identity — unlike {@link loadScenario}, history, receipts and assistant
 * threads stay (v1 parity). Identity is hydrated exactly as a Load would.
 */
export function applyScenarioEdit(target: ImportNormalizationTarget): Promise<CommandOutcome> {
  return getScenarioAuthority().mutate(hydrateImportTarget(target));
}

/**
 * New scenario: switch to a fresh identity holding the empty workspace. It does
 * NOT invent a backup baseline — an empty workspace has no fresh local backup, so
 * the baseline is `null` (unknown) (DL12/T17r review P0).
 */
export function newScenario(apiVersion?: string): Promise<CommandOutcome> {
  return getScenarioAuthority().newScenario(apiVersion);
}

/**
 * The user-facing reset (the New button, and the `recoverable-error` recovery
 * affordance). Identical to {@link newScenario} now that there is no corrupt
 * write-behind record to drop first: a legacy record that cannot be decoded is
 * already handled softly by the repository migration, which leaves the legacy row
 * intact and mints an empty scenario rather than blocking bring-up.
 */
export function resetToNewScenario(apiVersion?: string): Promise<CommandOutcome> {
  return newScenario(apiVersion);
}

/**
 * Register the page-lifecycle listeners that keep this tab's authority honest, and
 * return an unsubscribe. No-op (with a no-op cleanup) outside the browser.
 *
 * Two distinct jobs, and conflating them was the pre-T03 bug this replaces:
 *
 *   • `pagehide` releases the lease — on a real teardown AND on entry to BFCache
 *     (`persisted === true`). Holding it while cached stranded the NEXT document
 *     (a reload, the same tab navigating back to a fresh page) read-only for the
 *     20-second expiry. A cached page that comes back simply re-acquires.
 *   • `pageshow`, `visibilitychange`, `focus`, and `online` are RESUMPTION points
 *     where process memory may describe a world that no longer exists — each one
 *     triggers an authoritative reread rather than trusting what this tab
 *     remembers about its own ownership, and the reread acquires the lease when it
 *     is free (a normal acquire; a live holder still wins).
 */
export function registerScenarioLifecycle(): () => void {
  if (typeof window === "undefined") return () => {};
  const authority = getScenarioAuthority();

  const onPageHide = () => void authority.release();
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return; // a fresh load already initialized
    void authority.reconcile();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") void authority.reconcile();
  };
  const onReread = () => void authority.reconcile();

  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onReread);
  window.addEventListener("online", onReread);

  return () => {
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onReread);
    window.removeEventListener("online", onReread);
  };
}
