"use client";

// Roster document reader (F4) — reads the working roster + the current candidate
// from F1 storage and exposes them to the optimize screen.
//
// This hook is the bridge between F1's durable storage and the read-only viewer.
// It reads `working` and `currentCandidate` on mount and reload, and exposes the
// capture gate's state for the candidate's job so the screen can surface Load /
// Retry / Dismiss as roster-result actions.
//
// It owns NO document state: the working roster is whatever F1 last promoted;
// the candidate is whatever F2's capture gate last committed. Promotion (Load)
// and dismissal go through the F1/F2 APIs the screen already holds.

import { useCallback, useEffect, useState } from "react";
import { rosterStorage } from "@/lib/store";
import type { RosterDocument } from "@/lib/roster";
import type { CurrentCandidatePointer } from "@/lib/store";

export interface WorkingRosterState {
  /** The working roster document, or null when none has been loaded. */
  document: RosterDocument | null;
  /** The F1 working-row revision (the CAS baseline for F5 autosave), or null. */
  revision: number | null;
  /** The durable candidate pointer, or null when no candidate exists. */
  candidate: CurrentCandidatePointer | null;
  /** The candidate's document, or null when not yet read / absent. */
  candidateDocument: RosterDocument | null;
  /** Whether the initial read is still in flight. */
  loading: boolean;
  /**
   * True when the read could not be performed at all — no IndexedDB in this
   * environment (SSR, a hardened private window, a storage-denied browser).
   * This is NOT "there is no roster": it means we cannot know, so the section
   * must not claim an empty roster.
   */
  unavailable: boolean;
  /** Re-read working + candidate from storage (after Load/Dismiss). */
  reload(): Promise<void>;
}

/**
 * Read the working roster and the current candidate from F1 storage.
 *
 * The reads are non-blocking: `loading` is true until the first read resolves,
 * and `reload()` re-reads after a Load or Dismiss so the screen reflects the new
 * state without a full page reload.
 */
export function useWorkingRoster(): WorkingRosterState {
  const [document, setDocument] = useState<RosterDocument | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [candidate, setCandidate] = useState<CurrentCandidatePointer | null>(null);
  const [candidateDocument, setCandidateDocument] = useState<RosterDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const readAll = useCallback(async () => {
    const [workingRow, pointer] = await Promise.all([
      rosterStorage.readWorking<RosterDocument>(),
      rosterStorage.readCurrentCandidate(),
    ]);
    setDocument(workingRow?.document ?? null);
    setRevision(workingRow?.revision ?? null);
    setCandidate(pointer);
    if (pointer !== null) {
      const row = await rosterStorage.readCandidate<RosterDocument>(pointer.jobId);
      setCandidateDocument(row?.document ?? null);
    } else {
      setCandidateDocument(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await readAll();
        if (!cancelled) setUnavailable(false);
      } catch {
        // Storage is unreachable in this environment. The viewer degrades to a
        // read-unavailable state rather than crashing the Optimize screen or
        // asserting an empty roster it never actually read.
        if (!cancelled) setUnavailable(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [readAll]);

  return {
    document,
    revision,
    candidate,
    candidateDocument,
    loading,
    unavailable,
    reload: readAll,
  };
}
