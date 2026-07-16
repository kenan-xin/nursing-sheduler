"use client";

// Global confirm modal (T08, ticket item 1). One imperative confirm any screen can
// call — `await confirmDialog({ title, description, variant: "destructive" })` —
// resolving to true/false. The single dialog is rendered by the AppShell so delete
// affordances across the app share one accessible, token-styled modal instead of
// each mounting its own (or falling back to native `confirm()`).

import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

interface ConfirmState {
  /** The active request, or null when no confirm is open. */
  request: ConfirmRequest | null;
  /** Resolver for the in-flight `open` promise. */
  resolve: ((confirmed: boolean) => void) | null;
  /** Open a confirm and resolve once the user answers. */
  open: (request: ConfirmRequest) => Promise<boolean>;
  /** Settle the current confirm (called by the shell dialog). */
  settle: (confirmed: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolve: null,
  open: (request) =>
    new Promise<boolean>((resolve) => {
      // If a confirm was somehow already open, reject the stale one as cancelled.
      get().resolve?.(false);
      set({ request, resolve });
    }),
  settle: (confirmed) => {
    get().resolve?.(confirmed);
    set({ request: null, resolve: null });
  },
}));

/** Imperative entry point for callers outside React render (event handlers, etc.). */
export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().open(request);
}
