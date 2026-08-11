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
import { getRosterDb, rosterStorage, WORKING_ROSTER_KEY, type RosterStorage } from "@/lib/store";
import {
  fixtureAlternateRosterDocument,
  fixtureCanonicalDocument,
  fixtureContainer,
  fixtureRosterDocument,
} from "@/lib/roster/test-fixtures";
import { PREFERENCE_TYPE, type CanonicalPreference } from "@/lib/scenario";

const JOB_A = "opt_fixture_a";
/** The owner id the seeded submission snapshot is stored under. */
const SNAPSHOT_OWNER = "owner_fixture_residue";

/** The real `writeWorkingEdit`, held while a failure-injection control is active. */
let realWriteEdit: RosterStorage["writeWorkingEdit"] | null = null;
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

  /**
   * A durable candidate with NO working roster — the state the empty viewer's
   * Load offer exists for.
   *
   * `commitCandidate` fills a proven-empty working slot itself, so reaching this
   * state means dropping the row the commit wrote. That is a direct store poke, as
   * every control here is; it is not a second candidate protocol. Only the row THIS
   * commit created is removed, so a working roster seeded first survives.
   */
  const seedCandidate = useCallback(async () => {
    setStatus("seeding");
    // A DIFFERENT solved result from `fx-seed-working`'s, so staging both gives the
    // viewer a genuine choice to offer rather than the roster it already shows.
    const document = await fixtureAlternateRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await rosterStorage.commitCandidate({
      jobId: JOB_A,
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    if (outcome.status === "committed" && outcome.working.kind === "loaded-empty") {
      await getRosterDb().roster.delete(WORKING_ROSTER_KEY);
    }
    setStatus(outcome.status === "committed" ? "candidate-seeded" : `failed:${outcome.status}`);
    remount();
  }, []);

  /**
   * A completed run, left exactly as production leaves it — including the
   * fill-empty promotion the candidate commit performs when the working slot is
   * proven absent. The status reports F1's own disposition, so a browser test
   * asserts what the transaction decided rather than inferring it from the DOM.
   */
  const completeRun = useCallback(async () => {
    setStatus("seeding");
    const document = await fixtureAlternateRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await rosterStorage.commitCandidate({
      jobId: JOB_A,
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    setStatus(
      outcome.status === "committed"
        ? `run-completed:${outcome.working.kind}`
        : `failed:${outcome.status}`,
    );
    remount();
  }, []);

  /**
   * A working roster with no candidate behind it — the shape a roster the user
   * imported (or was sent) has.
   *
   * It goes through document promotion, not the edit operation: seeding a whole
   * document is a replacement, and replacement is what promotion is for. Promotion
   * also records the honest provenance for this row, which is none.
   */
  const seedWorking = useCallback(async () => {
    setStatus("seeding");
    const document = await fixtureRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await rosterStorage.promoteDocumentToWorking({
      document,
      validate: (value) => ({ ok: true as const, document: value }),
      expectedWorkingRevision: null,
      expectedClearEpoch: epoch,
    });
    setStatus(outcome.status === "promoted" ? "working-seeded" : `failed:${outcome.status}`);
    remount();
  }, []);

  /**
   * Seed a working roster whose SCENARIO differs from the default fixture's.
   *
   * The two controls below need a submission the default fixture cannot express,
   * and the requirement model is projected from `submission.canonicalYaml` — so
   * the only honest way to stage these states in a browser is to seed a document
   * carrying the real YAML. Everything after that is the production path.
   */
  const seedWithPreferences = useCallback(
    async (preferences: CanonicalPreference[], label: string) => {
      setStatus("seeding");
      const scenario = fixtureCanonicalDocument();
      scenario.preferences = preferences;
      const document = await fixtureRosterDocument({ document: scenario });
      const epoch = await rosterStorage.getClearEpoch();
      const outcome = await rosterStorage.promoteDocumentToWorking({
        document,
        validate: (value) => ({ ok: true as const, document: value }),
        expectedWorkingRevision: null,
        expectedClearEpoch: epoch,
      });
      setStatus(outcome.status === "promoted" ? label : `failed:${outcome.status}`);
      remount();
    },
    [],
  );

  /**
   * One requirement, scoped to a SINGLE date, asking for more people than the
   * roster puts on `D` there. Grid, Day and Coverage must show `staffed/required`
   * on 2026-07-04 and no target at all on the other three days.
   */
  const seedScoped = useCallback(
    () =>
      seedWithPreferences(
        [
          { type: PREFERENCE_TYPE.maxOneShiftPerDay },
          {
            type: PREFERENCE_TYPE.shiftTypeRequirement,
            shiftType: "D",
            requiredNumPeople: 2,
            date: "2026-07-04",
            weight: -1,
          },
        ],
        "scoped-seeded",
      ),
    [seedWithPreferences],
  );

  /**
   * One satisfiable requirement beside one whose selector cannot be resolved.
   * The Day dot must fail closed to `unknown` rather than reporting the
   * satisfied half as health.
   */
  const seedMixedUnavailable = useCallback(
    () =>
      seedWithPreferences(
        [
          { type: PREFERENCE_TYPE.maxOneShiftPerDay },
          {
            type: PREFERENCE_TYPE.shiftTypeRequirement,
            shiftType: "D",
            requiredNumPeople: 1,
            date: "ALL",
            weight: -1,
          },
          {
            type: PREFERENCE_TYPE.shiftTypeRequirement,
            shiftType: "NoSuchShift",
            requiredNumPeople: 1,
            date: "ALL",
            weight: -1,
          },
        ],
        "mixed-seeded",
      ),
    [seedWithPreferences],
  );

  /**
   * A satisfiable requirement on every day, beside an unresolvable one scoped to
   * the FIRST date only. The malformed rule must fail closed on 2026-07-03 and
   * be `not applicable` — not a warning — on every other date.
   */
  const seedScopedUnavailable = useCallback(
    () =>
      seedWithPreferences(
        [
          { type: PREFERENCE_TYPE.maxOneShiftPerDay },
          {
            type: PREFERENCE_TYPE.shiftTypeRequirement,
            shiftType: "D",
            requiredNumPeople: 1,
            date: "ALL",
            weight: -1,
          },
          {
            type: PREFERENCE_TYPE.shiftTypeRequirement,
            shiftType: "NoSuchShift",
            requiredNumPeople: 1,
            date: "2026-07-03",
            weight: -1,
          },
        ],
        "scoped-unavailable-seeded",
      ),
    [seedWithPreferences],
  );

  /**
   * A roster whose shift ids are Ward 8's REAL long authored labels — `long`,
   * `long+`, `night`, `night+` — rather than the default fixture's one-letter
   * `D`/`N` (G8).
   *
   * The chip's 34px minimum let a short id pass every geometry assertion while
   * the real ward's labels ran glyph-to-edge inside the colour box. A fixture
   * that only ever renders `D` cannot catch that, so the failing case is seeded
   * here with the exact ids the assembled ward authors, and measured in the
   * browser. Everything after the seed is the production path.
   */
  const seedWardLabels = useCallback(async () => {
    setStatus("seeding");
    const scenario = fixtureCanonicalDocument();
    scenario.shiftTypes = {
      items: [
        { id: "long", startTime: "07:00", endTime: "19:00", durationMinutes: 720 },
        { id: "long+", startTime: "07:30", endTime: "20:00", durationMinutes: 750 },
        { id: "night", startTime: "19:00", endTime: "07:00", durationMinutes: 720 },
        { id: "night+", startTime: "19:30", endTime: "08:00", durationMinutes: 750 },
      ],
    };
    scenario.people = { items: [{ id: "P1", history: ["long"] }, { id: "P2" }] };
    scenario.preferences = [
      { type: PREFERENCE_TYPE.maxOneShiftPerDay },
      {
        type: PREFERENCE_TYPE.shiftTypeRequirement,
        shiftType: "long",
        requiredNumPeople: 1,
        qualifiedPeople: "ALL",
        date: "ALL",
        weight: -1,
      },
    ];
    // Every long label sits beside another long label, so the measured gap
    // between adjacent chips is the real column-to-column separation rather than
    // a generous one next to a 34px `D`.
    const container = {
      ...fixtureContainer(),
      solvedDays: [
        [
          { kind: "shift" as const, shiftId: "night" },
          { kind: "shift" as const, shiftId: "night+" },
          { kind: "shift" as const, shiftId: "long" },
          { kind: "shift" as const, shiftId: "long+" },
        ],
        [
          { kind: "shift" as const, shiftId: "long+" },
          { kind: "shift" as const, shiftId: "long" },
          { kind: "leave" as const },
          { kind: "off" as const },
        ],
      ],
    };
    const document = await fixtureRosterDocument({ document: scenario, container });
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await rosterStorage.promoteDocumentToWorking({
      document,
      validate: (value) => ({ ok: true as const, document: value }),
      expectedWorkingRevision: null,
      expectedClearEpoch: epoch,
    });
    setStatus(outcome.status === "promoted" ? "ward-labels-seeded" : `failed:${outcome.status}`);
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
    const document = await fixtureAlternateRosterDocument();
    const epoch = await rosterStorage.getClearEpoch();
    const committed = await rosterStorage.commitCandidate({
      jobId: JOB_A,
      submissionOrdinal: 1,
      document,
      expectedClearEpoch: epoch,
    });
    // No working row: this control's whole point is that an ABSENT working roster
    // is not an empty browser, so the fill-empty row the commit wrote is dropped.
    if (committed.status === "committed" && committed.working.kind === "loaded-empty") {
      await getRosterDb().roster.delete(WORKING_ROSTER_KEY);
    }
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
  // swaps `rosterStorage.writeWorkingEdit` — the autosave primitive — for the
  // duration of a test. Everything above it — the autosave queue, the loss guard,
  // the replacement coordinator, the banners — stays production code reacting to a
  // real failed write.
  // ---------------------------------------------------------------------

  const failWrites = () => {
    if (realWriteEdit === null) realWriteEdit = rosterStorage.writeWorkingEdit;
    rosterStorage.writeWorkingEdit = () =>
      Promise.reject(new Error("fixture: storage unavailable"));
    setStatus("writes-failing");
  };

  const stallWrites = () => {
    if (realWriteEdit === null) realWriteEdit = rosterStorage.writeWorkingEdit;
    const real = realWriteEdit;
    rosterStorage.writeWorkingEdit = ((input: Parameters<typeof real>[0]) =>
      new Promise((resolve) => {
        releaseStalledWrite = () => resolve(real.call(rosterStorage, input));
      })) as typeof rosterStorage.writeWorkingEdit;
    setStatus("writes-stalled");
  };

  const healWrites = () => {
    if (realWriteEdit !== null) {
      rosterStorage.writeWorkingEdit = realWriteEdit;
      realWriteEdit = null;
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
   * A rival writer commits the SAME roster at the CURRENT revision — what another
   * tab's autosave does. The mounted panel's queue is left holding a stale
   * revision, so its next write must lose the CAS.
   *
   * It writes back the row's own document on purpose: this control exists to move
   * the revision, not to replace the roster, so the edit operation is the right
   * authority and its provenance-preserving contract holds.
   */
  const rivalWrite = async () => {
    const row =
      await rosterStorage.readWorking<Awaited<ReturnType<typeof fixtureRosterDocument>>>();
    if (row === null) {
      setStatus("rival-failed:no-working");
      return;
    }
    const epoch = await rosterStorage.getClearEpoch();
    const outcome = await (realWriteEdit ?? rosterStorage.writeWorkingEdit).call(rosterStorage, {
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
        <Button size="sm" data-testid="fx-complete-run" onClick={() => void completeRun()}>
          Complete a run
        </Button>
        <Button size="sm" data-testid="fx-seed-working" onClick={() => void seedWorking()}>
          Seed working roster
        </Button>
        <Button size="sm" data-testid="fx-seed-scoped" onClick={() => void seedScoped()}>
          Seed date-scoped requirement
        </Button>
        <Button size="sm" data-testid="fx-seed-mixed" onClick={() => void seedMixedUnavailable()}>
          Seed mixed unavailable
        </Button>
        <Button
          size="sm"
          data-testid="fx-seed-scoped-unavailable"
          onClick={() => void seedScopedUnavailable()}
        >
          Seed scoped unavailable
        </Button>
        <Button size="sm" data-testid="fx-seed-ward-labels" onClick={() => void seedWardLabels()}>
          Seed Ward labels
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
