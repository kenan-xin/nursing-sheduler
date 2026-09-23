"use client";

// F2 production composition — subscribing a React tree to the app-lifetime gate.
//
// The gate itself is NOT owned here. It lives in `./roster-capture-app` at module
// scope, because its per-job state (the coalesced in-flight promise, the container
// a `commit-failed` retry reuses, the cleanup tokens that are the sole DELETE
// authority) has to survive the Optimize route being unmounted and remounted. A
// component-owned gate survives rerenders but not navigation, and a remount would
// then duplicate an open `/roster` flight and lose the bytes-in-hand retry.
//
// This hook only wires that gate to React: it resolves it, subscribes so state
// transitions re-render, and exposes a per-job reader.

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { RosterCaptureGate, RosterCaptureState } from "./roster-capture";
import { getRosterCaptureGate, type RosterCaptureGateDeps } from "./roster-capture-app";

/**
 * Collaborators for the FIRST creation of the app-lifetime gate (see
 * `getRosterCaptureGate` — first call wins). Production passes nothing.
 */
export type UseRosterCaptureDeps = RosterCaptureGateDeps;

export interface RosterCaptureSurface {
  /** The single app-lifetime gate, handed to `useOptimizeTerminal`. */
  gate: RosterCaptureGate;
  /** The capture state for `jobId`, re-rendered as the gate advances. */
  stateFor(jobId: string | null): RosterCaptureState;
}

const IDLE: RosterCaptureState = { status: "idle" };

/**
 * Resolve and subscribe to the app-lifetime capture gate.
 *
 * Subscription goes through `useSyncExternalStore` because the gate is a plain
 * mutable store driven by async flights, not React state: the terminal hook holds
 * the authoritative copy for its own job, and this subscription exists so any
 * surface reading `stateFor` re-renders on the same transitions. The gate returns
 * referentially stable state objects, which is what makes that snapshot safe.
 *
 * Remounting this hook re-attaches to the SAME gate, so a capture still in flight
 * is joined rather than restarted and a retained `commit-failed` keeps its
 * already-fetched container.
 */
export function useRosterCapture(deps?: UseRosterCaptureDeps): RosterCaptureSurface {
  const gate: RosterCaptureGate = getRosterCaptureGate(deps);

  // A monotonic counter is the snapshot: the gate holds per-JOB state, so there is
  // no single value to snapshot, and `stateFor` reads the gate directly once a
  // transition has re-rendered us. The counter is stable between notifications,
  // which is what `useSyncExternalStore` requires.
  const versionRef = useRef(0);
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      gate.subscribe(() => {
        versionRef.current += 1;
        onStoreChange();
      }),
    [gate],
  );
  useSyncExternalStore(
    subscribe,
    () => versionRef.current,
    () => 0,
  );

  // Nothing is torn down on unmount: the gate is intentionally app-lifetime, and
  // its per-job tokens must survive a remount so a remounted screen cannot
  // re-authorize a second DELETE for a job it already cleaned up. F5's Clear seam
  // reaches the gate directly through `notifyRosterCaptureCleared`, so it works
  // even while this route is unmounted.
  const stateFor = useCallback(
    (jobId: string | null) => (jobId === null ? IDLE : gate.getState(jobId)),
    [gate],
  );

  return { gate, stateFor };
}
