"use client";

// F4 — client body of the roster viewer BROWSER fixture.
//
// Everything below the controls is production code: `RosterSection`, the real
// `useRosterCapture` gate, real `rosterStorage`, and F1's real promotion (which
// re-validates the stored document, `Blob` included). The controls exist only to
// put the store into a named starting condition, because a browser test cannot
// reach into IndexedDB as directly as a unit test can.
//
// The host width is a control rather than a viewport size on purpose: the F4
// contract is that Coverage stacks on the ROSTER CONTENT's width, so the
// discriminating test narrows the host inside a wide window — something a
// viewport-driven test can never distinguish.

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { RosterSection } from "@/components/roster-viewer/roster-section";
import {
  OPTIMIZE_RETIRE_PENDING_STORAGE_KEY,
  OPTIMIZE_SESSION_STORAGE_KEY,
  useRosterCapture,
} from "@/lib/optimize";
import { ROSTER_VIEW_PREFERENCE_KEY } from "@/lib/roster-viewer";
import { rosterStorage, type RosterStorage } from "@/lib/store";
import { fixtureRosterDocument } from "@/lib/roster/test-fixtures";

const JOB_A = "opt_fixture_a";
/** The owner id the seeded submission snapshot is stored under. */
const SNAPSHOT_OWNER = "owner_fixture_residue";

/** The real `writeWorking`, held while a failure-injection control is active. */
let realWriteWorking: RosterStorage["writeWorking"] | null = null;
/** Releases a stalled write (set by the stall control, called by the release control). */
let releaseStalledWrite: (() => void) | null = null;

export default function RosterViewerFixtureClient() {
  const capture = useRosterCapture();
  const [hostWidth, setHostWidth] = useState<number | null>(null);
  const [status, setStatus] = useState("idle");
  // Bumping this key re-mounts RosterSection after a direct storage write
  // (seedWorking/clearAll), so its useWorkingRoster hook re-reads. The hook has
  // no storage-change subscription by design; the fixture's controls bypass it.
  const [reloadKey, setReloadKey] = useState(0);
  const remount = () => setReloadKey((n) => n + 1);
  // The last residue probe, as JSON. `unknown` until a probe has run, so a test
  // can never read a stale "everything absent" that was simply never measured.
  const [residue, setResidue] = useState("unknown");

  const seedCandidate = useCallback(async () => {
    setStatus("seeding");
    const document = await fixtureRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await rosterStorage.commitCandidate({
      jobId: JOB_A,
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    setStatus(outcome.status === "committed" ? "candidate-seeded" : `failed:${outcome.status}`);
    remount();
  }, []);

  const seedWorking = useCallback(async () => {
    setStatus("seeding");
    const document = await fixtureRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await rosterStorage.writeWorking({
      document,
      expectedRevision: null,
      expectedClearEpoch: epoch,
    });
    setStatus(outcome.status === "written" ? "working-seeded" : `failed:${outcome.status}`);
    remount();
  }, []);

  const clearAll = useCallback(async () => {
    await rosterStorage.clearRosterData();
    setStatus("cleared");
    remount();
  }, []);

  // -------------------------------------------------------------------
  // G3 residue controls.
  //
  // An absent working roster is not an empty browser. These seed every hidden
  // surface the privacy Clear promises to reach WITHOUT writing a working row,
  // and read them all back afterwards — the state in which the empty-state Clear
  // is the only control that can reach any of it.
  // -------------------------------------------------------------------

  const seedResidue = useCallback(async () => {
    setStatus("seeding");
    const document = await fixtureRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const committed = await rosterStorage.commitCandidate({
      jobId: JOB_A,
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    const allocated = await rosterStorage.allocateSubmissionSnapshot({
      ownerId: SNAPSHOT_OWNER,
      payload: { canonicalYaml: "people: [Alice Ng]" },
      expectedClearEpoch: epoch,
    });
    window.sessionStorage.setItem(OPTIMIZE_SESSION_STORAGE_KEY, `{"owner":"${SNAPSHOT_OWNER}"}`);
    window.sessionStorage.setItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY, SNAPSHOT_OWNER);
    window.localStorage.setItem(
      ROSTER_VIEW_PREFERENCE_KEY,
      JSON.stringify({ lens: "grid", focusedIso: "2026-07-04" }),
    );
    setStatus(
      committed.status === "committed" && allocated.status === "allocated"
        ? "residue-seeded"
        : `failed:${committed.status}/${allocated.status}`,
    );
    remount();
  }, []);

  const probeResidue = useCallback(async () => {
    const [working, pointer, candidate, snapshot] = await Promise.all([
      rosterStorage.readWorking(),
      rosterStorage.readCurrentCandidate(),
      rosterStorage.readCandidate(JOB_A),
      rosterStorage.readSubmissionSnapshot(SNAPSHOT_OWNER),
    ]);
    setResidue(
      JSON.stringify({
        working: working !== null,
        pointer: pointer !== null,
        candidate: candidate !== null,
        snapshot: snapshot !== null,
        session: window.sessionStorage.getItem(OPTIMIZE_SESSION_STORAGE_KEY) !== null,
        retireMarker: window.sessionStorage.getItem(OPTIMIZE_RETIRE_PENDING_STORAGE_KEY) !== null,
        viewMetadata: window.localStorage.getItem(ROSTER_VIEW_PREFERENCE_KEY) !== null,
      }),
    );
  }, []);

  // ---------------------------------------------------------------------
  // Failure-injection controls.
  //
  // The F5 authority contract is mostly about what happens when a durable write
  // does NOT land: a quota/connection failure, a write that is still in flight
  // when the user asks to replace the roster, and another writer winning the CAS.
  // None of those can be provoked from the UI, and none can be proven in jsdom
  // (fake-indexeddb cannot round-trip the document's `Blob`). So the fixture
  // swaps `rosterStorage.writeWorking` for the duration of a test. Everything
  // above it — the autosave queue, the loss guard, the replacement coordinator,
  // the banners — stays production code reacting to a real failed write.
  // ---------------------------------------------------------------------

  const failWrites = () => {
    if (realWriteWorking === null) realWriteWorking = rosterStorage.writeWorking;
    rosterStorage.writeWorking = () => Promise.reject(new Error("fixture: storage unavailable"));
    setStatus("writes-failing");
  };

  const stallWrites = () => {
    if (realWriteWorking === null) realWriteWorking = rosterStorage.writeWorking;
    const real = realWriteWorking;
    rosterStorage.writeWorking = ((input: Parameters<typeof real>[0]) =>
      new Promise((resolve) => {
        releaseStalledWrite = () => resolve(real.call(rosterStorage, input));
      })) as typeof rosterStorage.writeWorking;
    setStatus("writes-stalled");
  };

  const healWrites = () => {
    if (realWriteWorking !== null) {
      rosterStorage.writeWorking = realWriteWorking;
      realWriteWorking = null;
    }
  };

  const releaseWrites = () => {
    const release = releaseStalledWrite;
    releaseStalledWrite = null;
    healWrites();
    release?.();
    setStatus("writes-released");
  };

  const restoreWrites = () => {
    healWrites();
    setStatus("writes-healthy");
  };

  /**
   * Commit a rival working-roster document at the CURRENT revision — what another
   * tab (or a Load/Import promotion) does. The mounted panel's autosave queue is
   * left holding a stale revision, so its next write must lose the CAS.
   */
  const rivalWrite = async () => {
    const row =
      await rosterStorage.readWorking<Awaited<ReturnType<typeof fixtureRosterDocument>>>();
    if (row === null) {
      setStatus("rival-failed:no-working");
      return;
    }
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await (realWriteWorking ?? rosterStorage.writeWorking).call(rosterStorage, {
      document: row.document,
      expectedRevision: row.revision,
      expectedClearEpoch: epoch,
    });
    setStatus(outcome.status === "written" ? "rival-written" : `rival-failed:${outcome.status}`);
  };

  return (
    <div data-testid="roster-fixture" style={{ padding: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <Button size="sm" data-testid="fx-seed-candidate" onClick={() => void seedCandidate()}>
          Seed candidate
        </Button>
        <Button size="sm" data-testid="fx-seed-working" onClick={() => void seedWorking()}>
          Seed working roster
        </Button>
        <Button size="sm" data-testid="fx-clear" onClick={() => void clearAll()}>
          Clear
        </Button>
        <Button size="sm" data-testid="fx-seed-residue" onClick={() => void seedResidue()}>
          Seed residue
        </Button>
        <Button size="sm" data-testid="fx-probe-residue" onClick={() => void probeResidue()}>
          Probe residue
        </Button>
        <Button size="sm" data-testid="fx-fail-writes" onClick={failWrites}>
          Fail writes
        </Button>
        <Button size="sm" data-testid="fx-stall-writes" onClick={stallWrites}>
          Stall writes
        </Button>
        <Button size="sm" data-testid="fx-release-writes" onClick={releaseWrites}>
          Release writes
        </Button>
        <Button size="sm" data-testid="fx-restore-writes" onClick={restoreWrites}>
          Restore writes
        </Button>
        <Button size="sm" data-testid="fx-rival-write" onClick={() => void rivalWrite()}>
          Rival write
        </Button>
        <Button size="sm" data-testid="fx-host-320" onClick={() => setHostWidth(320)}>
          Host 320
        </Button>
        <Button size="sm" data-testid="fx-host-759" onClick={() => setHostWidth(759)}>
          Host 759
        </Button>
        <Button size="sm" data-testid="fx-host-760" onClick={() => setHostWidth(760)}>
          Host 760
        </Button>
        <Button size="sm" data-testid="fx-host-auto" onClick={() => setHostWidth(null)}>
          Host auto
        </Button>
      </div>
      <div data-testid="fx-status">{status}</div>
      <div data-testid="fx-residue">{residue}</div>

      {/* THE HOST. Its width is what the roster measures; the window stays wide. */}
      <div
        data-testid="fx-host"
        style={hostWidth === null ? undefined : { width: `${hostWidth}px` }}
      >
        <RosterSection key={reloadKey} capture={capture} />
      </div>
    </div>
  );
}
