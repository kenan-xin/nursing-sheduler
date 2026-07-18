"use client";

// Shared navigation-intent guard state (T08a draft registry + T08b typed
// intents). The guard is consulted from many places — sidebar links, the
// mobile sheet, browser Back, any programmatic navigation — but the confirm
// dialog it drives is rendered ONCE in the AppShell. A per-hook `useState`
// cannot bridge those: each caller would own a private copy, so a sidebar click
// would flip its own flag while the shell's dialog watched a different one and
// never opened. A module-level store gives one source of truth every consumer
// reads and writes.
//
// T08b: navigation is one of four typed intents — `push`, `replace`, `back`,
// `mode-transition` — each carrying its own `commit` (what actually happens on
// Confirm). Cancel never touches history or mode — every intent kind leaves
// both untouched until `commit` actually runs — but a caller may still need a
// pure UI-side cleanup when Cancel is chosen instead: `onCancel` (T08d repair
// P2) is that optional hook, e.g. the mode toggle restoring roving-tab focus
// to the still-selected tab after a pointer click focused the (cancelled)
// target tab. The store stays free of any router/mode import: callers
// (use-guarded-navigation, T08c's mode transaction) supply `commit`/`onCancel`
// as closures, so the store only ever holds and runs them, never authors them.
//
// Losable-draft registry (T08a, replacing the old `draftOpen: boolean`): a
// boolean is unsafe once two editors can mount/unmount independently — closing
// one editor would wrongly disarm the guard for another still-open editor. Each
// draft owner registers under its own stable `id`; the guard is armed while the
// registry is non-empty, and unregistering one id can never affect another's
// registration. Registration is idempotent: registering the same id twice just
// replaces its entry, and the returned cleanup only ever removes that one id —
// keyed on a private identity token (T08f P2), so a STALE cleanup from an
// older same-id registration can't disarm a newer replacement under that id.

import { create } from "zustand";

/** A losable-draft owner: an open editor holding unsaved work that is NOT yet a
 *  durable scenario mutation (e.g. an add/edit form, an Edit-YAML draft). */
export interface DraftRegistration {
  id: string;
  label: string;
}

export type NavIntentKind = "push" | "replace" | "back" | "mode-transition";

/** A staged navigation the guard may confirm or cancel. `commit` performs the
 *  actual navigation (and, for `mode-transition`, the mode change) — the store
 *  never touches the router or mode store itself. Cancel never runs `commit`;
 *  history/mode are always untouched by it. `onCancel` (T08d repair P2) is an
 *  optional, purely cosmetic hook for the rare case a caller needs to react to
 *  Cancel itself (not to undo anything, since there is nothing to undo). */
export interface PendingNavIntent {
  kind: NavIntentKind;
  commit: () => void;
  onCancel?: () => void;
}

interface NavGuardState {
  /** The staged intent, held while the confirm is open. */
  pendingIntent: PendingNavIntent | null;
  /** Whether the navigation confirm dialog is currently shown. */
  open: boolean;
  /** Currently-open losable drafts, keyed by owner id. */
  drafts: Map<string, DraftRegistration>;
  /** Stage `intent`, opening the confirm dialog. No-op while an intent is
   *  already pending (T08f P1) — a repeated Back press before the user has
   *  decided must not overwrite the original intent (whose commit/cancel the
   *  dialog is already bound to) with a second one built against a URL that
   *  has since moved. */
  requestIntent: (intent: PendingNavIntent) => void;
  /** Confirm — run the staged intent's `commit` and close. */
  confirm: () => void;
  /** Cancel — close without running `commit` (Stay / backdrop / Esc), then run
   *  the staged intent's `onCancel` if it supplied one. */
  cancel: () => void;
  /** Register a losable draft under `id`. Returns idempotent cleanup that only
   *  ever removes THIS registration — closing/unmounting one owner can never
   *  disarm another's, including a later owner that re-registered the SAME id
   *  (T08f P2): each registration gets its own identity token, and cleanup only
   *  deletes the entry if it is still the one that token created. */
  registerDraft: (registration: DraftRegistration) => () => void;
}

export const useNavGuardStore = create<NavGuardState>((set, get) => {
  // Identity token per draft id, private to this store instance — not part of
  // the reactive state (nothing needs to re-render on it). A registration's
  // cleanup only ever deletes the map entry if its own token still matches the
  // CURRENT holder of that id, so a stale cleanup from a replaced same-id
  // registration can never remove its (still-open) replacement (T08f P2).
  const draftTokens = new Map<string, symbol>();

  return {
    pendingIntent: null,
    open: false,
    drafts: new Map(),
    requestIntent: (intent) => {
      if (get().pendingIntent) return; // one unresolved intent at a time
      set({ pendingIntent: intent, open: true });
    },
    confirm: () => {
      const intent = get().pendingIntent;
      set({ pendingIntent: null, open: false });
      intent?.commit();
    },
    cancel: () => {
      const intent = get().pendingIntent;
      set({ pendingIntent: null, open: false });
      intent?.onCancel?.();
    },
    registerDraft: (registration) => {
      const token = Symbol(registration.id);
      draftTokens.set(registration.id, token);
      set((state) => {
        const drafts = new Map(state.drafts);
        drafts.set(registration.id, registration);
        return { drafts };
      });
      let cleaned = false;
      return () => {
        if (cleaned) return; // idempotent: a second cleanup call is a no-op
        cleaned = true;
        if (draftTokens.get(registration.id) !== token) return; // superseded
        draftTokens.delete(registration.id);
        const drafts = new Map(get().drafts);
        drafts.delete(registration.id);
        set({ drafts });
      };
    },
  };
});

/** Synchronous read: is any losable draft currently registered? Consulted by
 *  the navigation guard and the browser-unload guard. */
export function hasLosableDrafts(): boolean {
  return useNavGuardStore.getState().drafts.size > 0;
}

/**
 * Dispatch `intent` through the shared guard: run it immediately when no
 * losable draft is open, otherwise stage it for the shell's confirm dialog.
 * The single decision point every navigation surface (push, replace, browser
 * Back, mode transitions) funnels through.
 */
export function dispatchNavIntent(intent: PendingNavIntent): void {
  if (!hasLosableDrafts()) {
    intent.commit();
    return;
  }
  useNavGuardStore.getState().requestIntent(intent);
}
